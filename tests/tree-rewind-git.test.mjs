import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HERMETIC_ENV, runGit } from "../extensions/tree-rewind/src/git.ts";
import { MAX_PROJECT_FILE_BYTES, ShadowRepo } from "../extensions/tree-rewind/src/shadow.ts";

function fakeGit(source) {
  const dir = mkdtempSync(join(tmpdir(), "rewind-git-"));
  const path = join(dir, "git");
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
  return {
    dir,
    env: {
      ...HERMETIC_ENV,
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      TMPDIR: dir,
      FIXTURE_ROOT: dir,
    },
  };
}

function fakeNodeGit(source) {
  const fake = fakeGit(`exec '${process.execPath.replaceAll("'", "'\\''")}' "$FIXTURE_ROOT/fake-git.cjs"`);
  writeFileSync(join(fake.dir, "fake-git.cjs"), `
    const { appendFileSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const root = process.env.FIXTURE_ROOT;
    const marker = join(root, "marker");
    ${source}
  `);
  return fake;
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `fixture did not create ${path}`);
    await delay(10);
  }
}

function assertChildClosed(fake) {
  const pid = Number(readFileSync(join(fake.dir, "ready"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("abort before spawn creates no child or abort listener", async () => {
  const fake = fakeNodeGit('writeFileSync(marker, "spawned");');
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runGit(["status"], fake.env, { signal: controller.signal });
    assert.equal(result.code, 124);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /aborted/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await delay(100);
    assert.equal(existsSync(join(fake.dir, "marker")), false);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("abort waits for delayed SIGTERM writes and child close, with no late writes", async () => {
  const fake = fakeNodeGit(`
    setInterval(() => {}, 1_000);
    process.on("exit", () => appendFileSync(marker, "closed\\n"));
    process.on("SIGTERM", () => {
      appendFileSync(marker, "term\\n");
      setTimeout(() => {
        appendFileSync(marker, "delayed write\\n");
        process.exit(0);
      }, 250);
    });
    writeFileSync(join(root, "ready"), String(process.pid));
    process.stdout.write("discard on abort");
  `);
  const controller = new AbortController();
  const sentinel = () => {};
  controller.signal.addEventListener("abort", sentinel);
  let pending;
  try {
    let settled = false;
    pending = runGit(["status"], fake.env, { signal: controller.signal, timeoutMs: 10_000 });
    pending.then(() => { settled = true; });
    await waitForFile(join(fake.dir, "ready"));
    controller.abort();
    controller.abort();
    // Dispatch again to exercise stop idempotence, not just AbortController's own guard.
    controller.signal.dispatchEvent(new Event("abort"));
    await waitForFile(join(fake.dir, "marker"));
    assert.equal(settled, false);
    const result = await pending;
    assert.equal(result.code, 124);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /aborted/);
    assertChildClosed(fake);
    assert.equal(readFileSync(join(fake.dir, "marker"), "utf8"), "term\ndelayed write\nclosed\n");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), [sentinel]);
    await delay(300);
    assert.equal(readFileSync(join(fake.dir, "marker"), "utf8"), "term\ndelayed write\nclosed\n");
  } finally {
    controller.abort();
    await pending;
    controller.signal.removeEventListener("abort", sentinel);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

for (const failure of ["error", "throw", "false"]) {
  test(`failed signalling (${failure}) keeps a started writer pending until close`, async (t) => {
    const fake = fakeNodeGit(`
      setTimeout(() => {
        writeFileSync(marker, "writer finished");
        process.exit(0);
      }, 350);
      writeFileSync(join(root, "ready"), String(process.pid));
    `);
    const controller = new AbortController();
    const signals = [];
    const kill = ChildProcess.prototype.kill;
    let pending;
    try {
      t.mock.method(ChildProcess.prototype, "kill", function (signal) {
        signals.push(signal);
        if (signal !== "SIGTERM") return kill.call(this, signal);
        if (failure === "error") this.emit("error", new Error("synthetic signalling error"));
        if (failure === "throw") throw new Error("synthetic signalling exception");
        return false;
      });
      pending = runGit(["status"], fake.env, { signal: controller.signal, timeoutMs: 10_000 });
      await waitForFile(join(fake.dir, "ready"));
      controller.abort();
      controller.signal.dispatchEvent(new Event("abort"));
      const result = await pending;
      assert.equal(result.code, 124);
      assert.equal(result.stdout.length, 0);
      assert.equal(readFileSync(join(fake.dir, "marker"), "utf8"), "writer finished");
      assertChildClosed(fake);
      assert.deepEqual(signals, ["SIGTERM"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      controller.abort();
      await pending;
      t.mock.restoreAll();
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
}

test("abort escalates to SIGKILL when SIGTERM does not stop the child", async () => {
  const fake = fakeNodeGit(`
    setInterval(() => {}, 1_000);
    process.on("SIGTERM", () => writeFileSync(marker, "ignored term"));
    writeFileSync(join(root, "ready"), String(process.pid));
  `);
  const controller = new AbortController();
  let pending;
  try {
    pending = runGit(["status"], fake.env, { signal: controller.signal, timeoutMs: 10_000 });
    await waitForFile(join(fake.dir, "ready"));
    const started = Date.now();
    controller.abort();
    const result = await pending;
    assert.equal(result.code, 124);
    assert.equal(result.stdout.length, 0);
    assert.ok(Date.now() - started >= 900);
    assert.equal(readFileSync(join(fake.dir, "marker"), "utf8"), "ignored term");
    assertChildClosed(fake);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    controller.abort();
    await pending;
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("normal exit and spawn failures preserve codes and remove abort listeners", async () => {
  const fake = fakeGit("printf 'output'; exit 7");
  try {
    const signal = new AbortController().signal;
    const result = await runGit(["status"], fake.env, { signal });
    assert.equal(result.code, 7);
    assert.equal(result.stdout.toString(), "output");
    assert.equal(getEventListeners(signal, "abort").length, 0);

    for (const opts of [{ cwd: join(fake.dir, "missing") }, {}]) {
      const args = opts.cwd ? ["status"] : ["invalid\0argument"];
      const failed = await runGit(args, fake.env, { ...opts, signal });
      assert.equal(failed.code, 127);
      assert.equal(failed.stdout.length, 0);
      assert.match(failed.stderr, /failed to spawn/);
      assert.equal(getEventListeners(signal, "abort").length, 0);
    }
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("T12 kills a Git operation that exceeds its runtime budget", async () => {
  const fake = fakeGit("exec sleep 2");
  try {
    const signal = new AbortController().signal;
    const started = Date.now();
    const result = await runGit(["status"], fake.env, { timeoutMs: 30, signal });
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(result.code, 124);
    assert.match(result.stderr, /timed out after 30ms/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("T12 rejects an oversized changed file before Git hashes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rewind-size-preflight-"));
  const previousEnv = process.env;
  process.env = { ...HERMETIC_ENV, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root };
  try {
    const worktree = join(root, "worktree");
    const store = join(root, "store");
    mkdirSync(worktree);
    const large = join(worktree, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, MAX_PROJECT_FILE_BYTES + 1);
    const repo = new ShadowRepo(worktree, store, "root");
    await repo.init();

    await assert.rejects(repo.stage(), /size preflight.*large\.bin exceeds/);
  } finally {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("T12 bounds captured Git output", async () => {
  const fake = fakeGit("printf 'abcdefghijklmnopqrstuvwxyz0123456789'");
  try {
    const signal = new AbortController().signal;
    const result = await runGit(["status"], fake.env, { maxOutputBytes: 16, signal });
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(result.code, 124);
    assert.match(result.stderr, /stdout exceeded 16 bytes/);
    assert.equal(result.stdout.length, 0);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
