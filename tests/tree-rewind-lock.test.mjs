import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LockTimeout, withLock } from "../extensions/tree-rewind/src/lock.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function waitForText(child, expected, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}; got ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
  });
}

test("an old lock owned by a live local pid is never stolen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-lock-live-"));
  const lock = join(dir, "snapshot.lock");
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), time: 0, owner: "live" }));
    await assert.rejects(
      withLock(lock, async () => {}, { timeoutMs: 50, staleMs: 1 }),
      LockTimeout,
    );
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).owner, "live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a former holder never removes a successor lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-lock-owner-"));
  const lock = join(dir, "snapshot.lock");
  try {
    await withLock(lock, async () => {
      rmSync(lock, { force: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "remote-host", time: Date.now(), owner: "successor" }));
    });
    assert.equal(existsSync(lock), true);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).owner, "successor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signal handlers exist only while at least one lock is held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-lock-handlers-"));
  const lock = join(dir, "snapshot.lock");
  const before = process.listenerCount("SIGTERM");
  try {
    await withLock(lock, async () => {
      assert.equal(process.listenerCount("SIGTERM"), before + 1);
    });
    assert.equal(process.listenerCount("SIGTERM"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM terminates a rewind lock holder instead of continuing unlocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-lock-signal-"));
  const lock = join(dir, "snapshot.lock");
  const lockModule = pathToFileURL(join(root, "extensions", "tree-rewind", "src", "lock.ts")).href;
  const source = `
    import { withLock } from ${JSON.stringify(lockModule)};
    await withLock(${JSON.stringify(lock)}, async () => {
      process.stdout.write("held\\n");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      process.stdout.write("continued-after-SIGTERM\\n");
    });
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitForText(child, "held");
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.code, 143);
    assert.equal(result.signal, null);
    assert.equal(output.includes("continued-after-SIGTERM"), false);

    let acquired = false;
    await withLock(lock, async () => { acquired = true; }, { timeoutMs: 1000, staleMs: 1000 });
    assert.equal(acquired, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
