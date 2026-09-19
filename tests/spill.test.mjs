import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const credential = ["sk-ant-oat01-", "A".repeat(24)].join("");
const rawEvent = (rawPath, preview = "first line\nlast line") => ({
  toolName: "bash", input: {}, toolCallId: "fixture", isError: false,
  content: [{ type: "text", text: `${preview}\n\n[Showing lines 2-3 of 3. Full output: ${rawPath}]` }],
  details: { fullOutputPath: rawPath, truncation: { truncated: true, truncatedBy: "lines" } },
});
const textOf = result => result.content.map(part => part.text ?? "").join("\n");

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-spill-test-"));
  const priorHome = process.env.HOME;
  const priorAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  const handlers = new Map();
  const { default: spill } = await import(`../extensions/spill.ts?fixture=${encodeURIComponent(home)}`);
  spill({ on: (name, handler) => handlers.set(name, handler) });
  handlers.get("session_start")(); // GC can only inspect this disposable home.
  return {
    home,
    run: event => handlers.get("tool_result")(event),
    cleanup() {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("actual core Bash line truncation gets a private redacted full-output copy below 32 KiB", async () => {
  const f = await fixture();
  let rawPath;
  try {
    const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    const piRoot = resolve(dirname(cli), "../..");
    const { createBashTool } = await import(pathToFileURL(join(piRoot, "dist/core/tools/bash.js")).href);
    const code = `process.stdout.write(${JSON.stringify(credential + "\n" + "x\n".repeat(2100))})`;
    const original = await createBashTool(f.home).execute("fixture", {
      command: `${JSON.stringify(process.execPath)} -e '${code}'`, timeout: 5,
    });
    rawPath = original.details.fullOutputPath;
    assert.equal(original.details.truncation.truncatedBy, "lines");
    assert.ok(Buffer.byteLength(textOf(original)) < 32 * 1024);
    const event = { ...rawEvent(rawPath), ...original };
    const before = structuredClone(event);
    const result = f.run(event);
    assert.ok(result, "raw output must be processed regardless of inline size");
    assert.deepEqual(event, before);
    const copy = result.details.fullOutputPath;
    assert.ok(copy && copy !== rawPath);
    assert.equal(existsSync(rawPath), false);
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(copy)).mode & 0o777, 0o700);
    assert.equal(readFileSync(copy, "utf8").includes(credential), false);
    assert.match(readFileSync(copy, "utf8"), /REDACTED:ANTHROPIC_OAUTH_ACCESS/);
    assert.equal(JSON.stringify(result).includes(rawPath), false);
    assert.deepEqual(result.details.truncation, original.details.truncation);
    // Keep all 2,000 short preview lines; do not duplicate a head/tail overlap.
    assert.equal(textOf(result).split("\n").filter(line => line === "x").length, 2000);
  } finally { if (rawPath) rmSync(rawPath, { force: true }); f.cleanup(); }
});

for (const failure of ["nonzero", "timeout"]) {
  test(`actual core Bash ${failure} errors suppress text-only locators without trusting them for file IO`, async () => {
    const f = await fixture();
    let rawPath;
    try {
      const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
      const piRoot = resolve(dirname(cli), "../..");
      const { createBashTool } = await import(pathToFileURL(join(piRoot, "dist/core/tools/bash.js")).href);
      const code = `process.stdout.write(${JSON.stringify(credential + "\n" + "x\n".repeat(2100))}); `
        + (failure === "nonzero" ? "process.exitCode = 1" : "setInterval(() => {}, 1000)");
      let message;
      try {
        await createBashTool(f.home).execute("fixture", {
          command: `${JSON.stringify(process.execPath)} -e '${code}'`, timeout: 1,
        }, undefined, update => {
          // Test cleanup uses trusted core update metadata, never a parsed text path.
          if (typeof update.details?.fullOutputPath === "string") rawPath = update.details.fullOutputPath;
        });
        assert.fail("the synthetic command should fail");
      } catch (error) { message = error.message; }
      assert.ok(rawPath && message.includes(rawPath));
      assert.ok(Buffer.byteLength(message) < 32 * 1024);
      const event = { toolName: "bash", input: {}, isError: true, details: {}, content: [{ type: "text", text: message }] };
      const result = f.run(event);
      assert.ok(result);
      const merged = { ...event, ...result };
      assert.equal(merged.isError, true);
      assert.equal(JSON.stringify(merged).includes(rawPath), false);
      assert.match(textOf(merged), failure === "nonzero" ? /Command exited with code 1/ : /Command timed out after 1 seconds/);
      assert.equal(textOf(merged).split("\n").filter(line => line === "x").length, 2000);
      assert.equal(readFileSync(rawPath, "utf8").includes(credential), true, "without trusted result metadata spill must not open/rewrite/delete the locator's target");
    } finally { if (rawPath) rmSync(rawPath, { force: true }); f.cleanup(); }
  });
}

test("forged error locators never authorize reading or deleting files, including large previews", async () => {
  const f = await fixture();
  try {
    const unrelated = join(f.home, "unrelated.txt");
    const privateText = "unrelated fixture contents";
    writeFileSync(unrelated, privateText);
    for (const size of [10, 40 * 1024]) {
      const message = "x".repeat(size)
        + `\n\n[Showing last 4 KiB of line 1 (line is 50 KiB). Full output: ${unrelated}]\n\nCommand aborted`;
      const event = { toolName: "bash", isError: true, details: {}, content: [{ type: "text", text: message }] };
      const result = f.run(event);
      assert.ok(result);
      assert.equal(JSON.stringify(result).includes(unrelated), false);
      assert.equal(textOf(result).includes(privateText), false);
      assert.match(textOf(result), /Command aborted/);
      assert.equal(readFileSync(unrelated, "utf8"), privateText);
      const copy = textOf(result).match(/full text saved to (.+?)\. Preview/)?.[1];
      if (copy) {
        assert.equal(readFileSync(copy, "utf8").includes(unrelated), false);
        assert.equal(readFileSync(copy, "utf8").includes(privateText), false);
      }
    }
  } finally { f.cleanup(); }
});

test("small raw-output previews stay intact and are redacted independently of hook ordering", async () => {
  const f = await fixture();
  try {
    const rawPath = join(f.home, "raw.log");
    writeFileSync(rawPath, credential + "\nfull output");
    const result = f.run(rawEvent(rawPath, `first line\n${credential}\nlast line`));
    assert.ok(result);
    assert.equal(textOf(result).split("first line").length, 2);
    assert.equal(textOf(result).split("last line").length, 2);
    assert.equal(textOf(result).includes(credential), false);
    assert.equal(JSON.stringify(result).includes(rawPath), false);
    assert.equal(existsSync(rawPath), false);
    assert.equal(readFileSync(result.details.fullOutputPath, "utf8").includes(credential), false);
  } finally { f.cleanup(); }
});

for (const failure of ["missing", "oversized", "storage-failure"]) {
  test(`small preview with ${failure} full output withholds the raw locator, including details`, async () => {
    const f = await fixture();
    try {
      const rawPath = join(f.home, "raw.log");
      if (failure === "oversized") {
        const fd = openSync(rawPath, "w");
        try { ftruncateSync(fd, 8 * 1024 * 1024 + 1); } finally { closeSync(fd); }
      } else if (failure === "storage-failure") {
        writeFileSync(rawPath, credential);
        writeFileSync(join(f.home, ".pi"), "blocks private storage");
      }
      const result = f.run(rawEvent(rawPath, `visible\n${credential}`));
      assert.ok(result);
      assert.match(textOf(result), /full text withheld/);
      assert.equal(JSON.stringify(result).includes(rawPath), false);
      assert.equal(textOf(result).includes(credential), false);
      assert.equal(result.details.fullOutputPath, undefined);
      assert.equal(existsSync(rawPath), failure !== "missing", "never delete a full output that was not copied");
    } finally { f.cleanup(); }
  });
}

test("ordinary output retains its 32 KiB byte budget, read/image exemptions and recoverable spill", async () => {
  const f = await fixture();
  try {
    const plain = text => ({ toolName: "fixture", input: {}, content: [{ type: "text", text }], details: { marker: "keep" } });
    assert.equal(f.run(plain("x".repeat(32 * 1024))), undefined);
    const large = "🔥".repeat(8193) + "\n" + credential;
    const event = plain(large);
    assert.equal(f.run({ ...event, toolName: "read" }), undefined);
    assert.equal(f.run({ ...event, content: [...event.content, { type: "image", data: "fixture" }] }), undefined);
    const result = f.run(event);
    assert.ok(result);
    const inline = textOf(result);
    assert.ok(Buffer.byteLength(inline) < 32 * 1024);
    assert.equal(inline.includes(credential), false);
    const copy = inline.match(/full text saved to (.+?)\. Preview/)[1];
    assert.equal(readFileSync(copy, "utf8").includes(credential), false);
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.deepEqual(event.details, { marker: "keep" });
  } finally { f.cleanup(); }
});
