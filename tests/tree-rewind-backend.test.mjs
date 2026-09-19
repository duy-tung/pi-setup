import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeBackend, createBackendLifetime, drainBackend, runBackend } from "../extensions/tree-rewind/src/backend-lifetime.ts";
import { LockTimeout, withLock } from "../extensions/tree-rewind/src/lock.ts";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const src = fileURLToPath(new URL("../extensions/tree-rewind/src/", import.meta.url));
const loader = fileURLToPath(new URL("../extensions/tree-rewind/spike/register.mjs", import.meta.url));
const lockModule = pathToFileURL(process.env.REWIND_TEST_LOCK_MODULE ?? join(src, "lock.ts")).href;
const lifeModule = pathToFileURL(join(src, "backend-lifetime.ts")).href;

function childFor(source) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", loader, "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  const ready = deferred();
  child.stdout.on("data", chunk => { output += chunk; if (output.includes("held\n")) ready.resolve(); });
  child.stderr.on("data", chunk => { error += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => { ready.resolve(); resolve({ code, signal }); }));
  return { child, ready: ready.promise, closed, output: () => output, error: () => error };
}

async function cleanupChild(run, dir) {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  await run.closed;
  rmSync(dir, { recursive: true, force: true });
}

test("hosted ownership installs no signal/exit handlers and drains whole jobs after unlock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-drain-")), lock = join(dir, "snapshot.lock");
  const lifetime = createBackendLifetime(true), writer = deferred(), metadata = deferred();
  const before = ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(signal => process.listenerCount(signal));
  let published = false;
  const job = runBackend(lifetime, async () => {
    await withLock(lock, async () => {
      assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(signal => process.listenerCount(signal)), before);
      await writer.promise;
    }, { lifetime });
    await metadata.promise;
    published = true;
  });
  let drained = false;
  try {
    assert.ok(existsSync(lock));
    closeBackend(lifetime);
    const draining = drainBackend(lifetime).then(() => { drained = true; });
    await turn();
    assert.equal(drained, false);
    assert.ok(existsSync(lock));
    writer.resolve();
    await turn();
    assert.equal(existsSync(lock), false);
    assert.equal(drained, false, "lock completion alone is not job completion");
    metadata.resolve();
    await draining;
    assert.ok(published);
    assert.equal(lifetime.pending.size, 0);
    await assert.rejects(runBackend(lifetime, () => assert.fail("late admission")), /closing/);
  } finally {
    writer.resolve(); metadata.resolve(); await job;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing cancels a queued lock and zero-wait maintenance never schedules a retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-queued-")), lock = join(dir, "snapshot.lock");
  const lifetime = createBackendLifetime(true);
  writeFileSync(lock, "foreign holder");
  try {
    const queued = withLock(lock, async () => assert.fail("queued writer entered"), { lifetime, timeoutMs: 60_000 });
    closeBackend(lifetime);
    await assert.rejects(queued, /closing/);
    await drainBackend(lifetime);
    assert.equal(readFileSync(lock, "utf8"), "foreign holder");
    let sleeps = 0, immediate;
    const timer = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (...args) => { sleeps++; return timer(...args); };
      immediate = withLock(lock, async () => assert.fail("maintenance entered"), { timeoutMs: 0, lifetime: createBackendLifetime(true) });
    } finally { globalThis.setTimeout = timer; }
    await assert.rejects(immediate, LockTimeout);
    assert.equal(sleeps, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const signal of ["SIGTERM", "SIGHUP"]) {
  test(`host ${signal} cleanup waits for the writer and retains control of exit`, { timeout: 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rewind-host-")), lock = join(dir, "snapshot.lock"), marker = join(dir, "cleaned");
    const run = childFor(`
      import { existsSync, writeFileSync } from "node:fs";
      import { withLock } from ${JSON.stringify(lockModule)};
      import { createBackendLifetime, closeBackend, drainBackend } from ${JSON.stringify(lifeModule)};
      const lifetime = createBackendLifetime(true);
      await withLock(${JSON.stringify(lock)}, async () => {
        // Install host handling AFTER acquisition: never infer ownership from
        // the listeners that happened to exist when the library took a lock.
        process.prependListener(${JSON.stringify(signal)}, async () => {
          closeBackend(lifetime);
          await drainBackend(lifetime);
          await new Promise(resolve => setTimeout(resolve, 20));
          writeFileSync(${JSON.stringify(marker)}, "host cleanup complete");
          process.exit(73);
        });
        process.stdout.write("held\\n");
        await new Promise(resolve => setTimeout(resolve, 180));
        if (!existsSync(${JSON.stringify(lock)})) throw new Error("writer continued unlocked");
        process.stdout.write("writer finished\\n");
      }, { lifetime });
    `);
    try {
      await run.ready;
      assert.match(run.output(), /held/, run.error());
      run.child.kill(signal);
      await assert.rejects(withLock(lock, async () => {}, { timeoutMs: 30 }), LockTimeout);
      assert.deepEqual(await run.closed, { code: 73, signal: null }, run.error());
      assert.match(run.output(), /writer finished/);
      assert.equal(readFileSync(marker, "utf8"), "host cleanup complete");
      assert.equal(existsSync(lock), false);
    } finally { await cleanupChild(run, dir); }
  });
}

test("forced process exit leaves an uncertain standalone lock fail-closed", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewind-forced-exit-")), lock = join(dir, "snapshot.lock");
  const run = childFor(`
    import { withLock } from ${JSON.stringify(lockModule)};
    await withLock(${JSON.stringify(lock)}, async () => {
      process.stdout.write("held\\n");
      process.exit(17);
    });
  `);
  try {
    assert.deepEqual(await run.closed, { code: 17, signal: null }, run.error());
    assert.ok(existsSync(lock), "exit is not proof a child writer stopped");
    await assert.rejects(withLock(lock, async () => {}, { timeoutMs: 0 }), LockTimeout);
  } finally { await cleanupChild(run, dir); }
});
