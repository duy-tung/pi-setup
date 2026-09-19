/** Durable recovery regressions through the same checkpoint/preview/apply APIs as Pi.
 * Run only this suite: node --import ./spike/register.mjs spike/recovery-test.mts
 * Every worktree, HOME, outside file, Git object, and removed lock is disposable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { RewindState } from "../src/state.js";
import type { ApplyResult, RestorePlan } from "../src/types.js";

const crashMode = process.argv[2] === "--crash";
const originalHome = process.env.HOME;
const inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
for (const key of Object.keys(inheritedGit)) delete process.env[key];
const root = crashMode
  ? fs.realpathSync(process.env.RECOVERY_TEST_ROOT!)
  : fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-recovery-tests-")));
const home = join(root, "home");
if (crashMode) assert.equal(process.env.HOME, home, "child must receive disposable HOME before creating any store");
else fs.mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;

// Imports intentionally follow environment isolation; homedir() is lazy today.
const { applyPlan, applyUndo, beginWorkspace, discardRestorePlan, ensureCheckpoint, planRestore, planUndo, waitReady } = await import("../src/checkpoints.js");
const { createInitialState, resetState } = await import("../src/state.js");
const { recoveryPath, readRecovery, writeRecovery } = await import("../src/recovery.js");
const { storeDirFor } = await import("../src/workspace.js");
const { withLock, LockTimeout } = await import("../src/lock.js");
const SESSION = "fixture-recovery-session";
const A = "CHECKPOINT ORIGINAL\n";
const B = "BEFORE REWIND EDITED\n";
const read = (path: string) => fs.readFileSync(path, "utf8");
const put = (dir: string, file: string, value: string) => fs.writeFileSync(join(dir, file), value);
const contents = (dir: string) => [read(join(dir, "a.txt")), read(join(dir, "b.txt"))];
const lockPath = (state: RewindState) => join(state.outside!.storeDir, "snapshot.lock");
const recordPath = (state: RewindState) => recoveryPath(state.outside!.storeDir, state.sessionId!);
const diskRecord = (state: RewindState) => readRecovery(state.outside!.storeDir, state.cwd, state.sessionId!);
type MutableWorkspace = { applyLocked: (plan: RestorePlan, opts: { includeTypeChanges?: boolean }) => Promise<ApplyResult> };
// applyLocked is TypeScript-private, not a #private field. Only fixture instances are patched.
const internals = (state: RewindState) => state.ws as unknown as MutableWorkspace;
function fixturePath(path: string): void {
  const rel = relative(root, path);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), `not a fixture path: ${path}`);
}
function makeProject(name: string): string {
  const path = join(root, name);
  fs.mkdirSync(path);
  put(path, "package.json", '{"private":true}\n'); // Eligibility marker; .gitignore alone is not a project marker.
  put(path, ".gitignore", "ignored/\n"); // Govern staging without creating a real Git repository.
  put(path, "a.txt", A); put(path, "b.txt", A);
  return fs.realpathSync(path);
}
async function open(path: string, sessionId = SESSION): Promise<RewindState> {
  fixturePath(path);
  const state = createInitialState(); state.sessionId = sessionId;
  beginWorkspace(state, path);
  assert.ok(await waitReady(state), state.readyError ?? state.disabled ?? "workspace unavailable");
  assert.equal(state.disabled, null, "fixture must pass the normal eligibility gate");
  fixturePath(state.outside!.storeDir);
  return state;
}
async function setup(name: string) {
  const dir = makeProject(name);
  const state = await open(dir);
  const cp = await ensureCheckpoint(state, "checkpoint-original", "original fixture", Date.now());
  assert.ok(cp, state.lastGap ?? "missing checkpoint");
  state.currentEntryId = cp.entryId;
  put(dir, "a.txt", B); put(dir, "b.txt", B);
  const plan = await planRestore(state, cp); assert.ok(plan);
  return { dir, state, cp, plan };
}
function success(result: ApplyResult | null): void {
  assert.ok(result, "operation returned no result"); assert.deepEqual(result.errors, []);
}
async function assertPins(state: RewindState): Promise<void> {
  const record = diskRecord(state); assert.ok(record);
  const points = [record.undo, record.journal?.before, record.journal?.target, record.journal?.previousUndo];
  for (const point of points) {
    if (!point) continue;
    for (const [sub, sha] of Object.entries(point.snapshot)) {
      const repo = state.ws!.repos.get(sub); assert.ok(repo);
      assert.equal(await repo.refValue(`refs/pi/${state.sessionId}/${point.refId}`), sha);
      assert.ok(await repo.hasCommit(sha), "durable transaction commit missing");
    }
  }
}
async function failPartial(state: RewindState, plan: RestorePlan, throwing = false): Promise<void> {
  const ws = internals(state); const original = ws.applyLocked;
  let entered = false;
  ws.applyLocked = async () => {
    ws.applyLocked = original; // One-shot, without altering the production writer.
    entered = true;
    assert.ok(fs.existsSync(lockPath(state)), "journal and first write must share snapshot.lock");
    assert.equal(diskRecord(state)?.journal?.phase, "pending");
    await assertPins(state);
    assert.deepEqual(contents(state.cwd), [B, B], "publication precedes the first workspace write");
    put(state.cwd, "a.txt", A); // Exactly one disposable file simulates a partial apply.
    if (throwing) throw new Error("fixture interrupted apply");
    return { restored: 1, deleted: 0, skipped: [], errors: ["fixture partial apply failure"] };
  };
  try {
    if (throwing) await assert.rejects(applyPlan(state, plan), /fixture interrupted apply/);
    else assert.match((await applyPlan(state, plan))!.errors.join("\n"), /fixture partial apply failure/);
    assert.ok(entered);
  } finally { ws.applyLocked = original; }
}
function shadowGit(gitDir: string, ...args: string[]): string {
  fixturePath(gitDir);
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe", timeout: 30_000,
  }).toString().trim();
}

if (crashMode) {
  const dir = fs.realpathSync(process.argv[3]!); fixturePath(dir);
  const state = await open(dir);
  const cp = await ensureCheckpoint(state, "checkpoint-original", "SIGKILL fixture", Date.now()); assert.ok(cp);
  put(dir, "a.txt", B); put(dir, "b.txt", B);
  const plan = await planRestore(state, cp); assert.ok(plan);
  internals(state).applyLocked = async () => {
    assert.equal(diskRecord(state)?.journal?.phase, "pending");
    assert.ok(fs.existsSync(lockPath(state)));
    await assertPins(state);
    put(dir, "a.txt", A);
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL unexpectedly returned");
  };
  await applyPlan(state, plan);
  throw new Error("crash child unexpectedly completed restore");
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

test("durable normal restore, reload, locked Undo promotion, reversible Undo", async () => {
  const { dir, state, plan } = await setup("normal");
  const ws = internals(state); const originalApply = ws.applyLocked;
  let writes = 0;
  ws.applyLocked = async function (...args) {
    writes++;
    assert.ok(fs.existsSync(lockPath(state)));
    assert.equal(diskRecord(state)?.journal?.kind, "rewind");
    assert.deepEqual(contents(dir), [B, B]);
    await assertPins(state);
    return originalApply.apply(this, args);
  };
  try { success(await applyPlan(state, plan)); } finally { ws.applyLocked = originalApply; }
  assert.equal(writes, 1); assert.deepEqual(contents(dir), [A, A]);
  assert.equal(diskRecord(state)?.journal, null);
  const loaded = await open(dir);
  assert.deepEqual(loaded.undo, diskRecord(state)?.undo);
  const undo = await planUndo(loaded); assert.ok(undo);
  const replace = loaded.ws!.replaceSnapshotRefLocked;
  let promoted = false;
  loaded.ws!.replaceSnapshotRefLocked = async function (...args) {
    if (args[3] === "undo") {
      promoted = true;
      assert.ok(fs.existsSync(lockPath(loaded)), "final Undo promotion escaped the apply lock");
      assert.equal(diskRecord(loaded)?.journal?.kind, "undo");
      assert.deepEqual(contents(dir), [B, B], "promotion follows completed workspace writes");
    }
    return replace.apply(this, args);
  };
  try { success(await applyUndo(loaded, undo)); } finally { loaded.ws!.replaceSnapshotRefLocked = replace; }
  assert.ok(promoted); assert.deepEqual(contents(dir), [B, B]);
  const again = await open(dir);
  success(await applyUndo(again, (await planUndo(again))!));
  assert.deepEqual(contents(dir), [A, A], "Undo remains reversible rather than consuming its destination");
});

for (const throwing of [false, true]) test(`${throwing ? "thrown/interrupted" : "failed-result"} restore persists; reload never replays; explicit Undo recovers`, async () => {
  const { dir, state, cp, plan } = await setup(throwing ? "interrupted" : "failed");
  await failPartial(state, plan, throwing);
  const bytes = read(recordPath(state));
  assert.equal(diskRecord(state)?.journal?.phase, throwing ? "pending" : "failed");
  const loaded = await open(dir);
  assert.deepEqual(contents(dir), [A, B]);
  assert.equal(read(recordPath(state)), bytes, "load must not rewrite or automatically replay the journal");
  assert.match(loaded.lastGap!, /interrupted/i);
  await assert.rejects(planRestore(loaded, cp), /interrupted|pending/i);
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.deepEqual(contents(dir), [B, B]); assert.equal(diskRecord(loaded)?.journal, null);
});

test("pending before/target immutable refs survive reload and aggressive Git GC", async () => {
  const { dir, state, plan } = await setup("gc");
  await failPartial(state, plan);
  const record = diskRecord(state)!;
  await state.ws!.withStoreLock(async () => {
    for (const repo of state.ws!.repos.values()) {
      // Remove checkpoint and transient refs so they cannot accidentally mask a missing tx pin.
      for (const ref of shadowGit(repo.gitDir, "for-each-ref", "--format=%(refname)", `refs/pi/${SESSION}/`).split("\n").filter(Boolean)) {
        if (!ref.includes("/tx-")) await repo.deleteRef(ref);
      }
      shadowGit(repo.gitDir, "reflog", "expire", "--expire=now", "--all");
      shadowGit(repo.gitDir, "gc", "--prune=now");
    }
  });
  const loaded = await open(dir); await assertPins(loaded);
  assert.deepEqual(loaded.recovery, record);
  assert.ok(await loaded.ws!.hasSnapshot(record.journal!.target.snapshot));
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.deepEqual(contents(dir), [B, B]);
});

test("late managed edit after recovery preview is refused without overwrite", async () => {
  const { dir, state, plan } = await setup("late-edit");
  await failPartial(state, plan);
  const loaded = await open(dir); const preview = await planUndo(loaded); assert.ok(preview);
  const bytes = read(recordPath(loaded));
  put(dir, "b.txt", "LATE MANAGED EDIT\n");
  await assert.rejects(applyUndo(loaded, preview), /changed after.*recovery preview/i);
  assert.deepEqual(contents(dir), [A, "LATE MANAGED EDIT\n"]);
  assert.equal(read(recordPath(loaded)), bytes, "refused preview must preserve pending destination");
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.deepEqual(contents(dir), [B, B]);
});

test("publication failure before first write preserves previous durable Undo", async () => {
  const { dir, state, cp, plan } = await setup("publication-failure");
  success(await applyPlan(state, plan));
  put(dir, "a.txt", "NEXT EDIT\n");
  const next = await planRestore(state, cp); assert.ok(next);
  const oldBytes = read(recordPath(state)); const oldUndo = state.undo;
  const rename = fs.renameSync; const ws = internals(state); const apply = ws.applyLocked;
  let injected = false; let enteredWriter = false;
  ws.applyLocked = async function (...args) { enteredWriter = true; return apply.apply(this, args); };
  fs.renameSync = ((from, to) => {
    if (String(to) === recordPath(state)) {
      injected = true;
      assert.ok(fs.existsSync(lockPath(state)));
      throw new Error("fixture publication I/O failure");
    }
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { await assert.rejects(applyPlan(state, next), /Cannot write private JSON/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); ws.applyLocked = apply; }
  assert.ok(injected); assert.equal(enteredWriter, false);
  assert.deepEqual(contents(dir), ["NEXT EDIT\n", A]);
  assert.equal(read(recordPath(state)), oldBytes); assert.equal(state.undo, oldUndo);
  for (const repo of state.ws!.repos.values()) {
    const refs = shadowGit(repo.gitDir, "for-each-ref", "--format=%(refname)", `refs/pi/${SESSION}/`).split("\n").filter(ref => ref.includes("/tx-"));
    assert.equal(refs.length, 1, "failed pre-publication attempts must not leak new tx refs");
  }
});

test("post-rename sync failure keeps published pins; explicit no-op recovery retires extras", async () => {
  const { dir, state, plan } = await setup("post-rename");
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("fixture directory sync failure"), { code: "EIO" });
    sync(fd);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(applyPlan(state, plan), /metadata was published/); }
  finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.deepEqual(contents(dir), [B, B]);
  assert.equal(diskRecord(state)?.journal?.phase, "pending"); await assertPins(state);
  const loaded = await open(dir);
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.equal(diskRecord(loaded)?.journal, null);
  assert.equal(loaded.lastGap, null);
  for (const repo of loaded.ws!.repos.values()) {
    const refs = shadowGit(repo.gitDir, "for-each-ref", "--format=%(refname)", `refs/pi/${SESSION}/`).split("\n").filter(ref => ref.includes("/tx-"));
    assert.equal(refs.length, 1);
  }
});

test("corrupt outside preimage blocks all writers before publication", async () => {
  const { dir, state, cp } = await setup("outside-corrupt-preimage");
  const external = join(root, "corrupt-preimage.txt"); fs.writeFileSync(external, A);
  state.outside!.touch(external, [cp]); fs.writeFileSync(external, B);
  const preview = (await planRestore(state, cp))!;
  const entry = preview.outsideFrom![external]; assert.ok("sha" in entry);
  const blob = join(state.outside!.storeDir, "outside", entry.sha.slice(0, 2), entry.sha);
  fs.writeFileSync(blob, "CORRUPT");
  assert.match((await applyPlan(state, preview, { includeOutside: true }))!.errors.join("\n"), /outside preimage/i);
  assert.deepEqual(contents(dir), [B, B]); assert.equal(read(external), B);
  assert.equal(diskRecord(state), null);
  fs.writeFileSync(blob, B);
  success(await applyPlan(state, (await planRestore(state, cp))!, { includeOutside: true }));
  assert.equal(read(external), A);
});

test("unsupported outside preimage is not destroyed; a resolved path is re-adopted for retry", async () => {
  const { state, cp } = await setup("outside-type-retry");
  const external = join(root, "outside-type-retry.txt"); fs.writeFileSync(external, A);
  state.outside!.touch(external, [cp]); fs.unlinkSync(external); fs.mkdirSync(external);
  fs.writeFileSync(join(external, "keep.txt"), "KEEP DIRECTORY");
  assert.match((await applyPlan(state, (await planRestore(state, cp))!, { includeOutside: true, includeTypeChanges: true }))!.errors.join("\n"), /unsupported current path/);
  assert.equal(read(join(external, "keep.txt")), "KEEP DIRECTORY");
  fs.renameSync(external, `${external}.preserved`); fs.writeFileSync(external, B);
  success(await applyPlan(state, (await planRestore(state, cp))!, { includeOutside: true }));
  assert.equal(read(external), A);
  // Valid JSON object-member order must not affect recovery authorization.
  const record = diskRecord(state)!;
  for (const [path, entry] of Object.entries(record.undo!.outside!)) {
    if ("sha" in entry) record.undo!.outside![path] = { mode: entry.mode, sha: entry.sha };
  }
  fs.writeFileSync(recordPath(state), JSON.stringify(record));
  const loaded = await open(state.cwd);
  assert.equal(loaded.recoveryError, null);
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.equal(read(external), B);
});

for (const corruption of ["null", "malformed", "symlink", "missing", "revision", "missing-target"] as const) {
  test(`${corruption} recovery metadata/destination fails closed`, async () => {
    const { dir, state, cp, plan } = await setup(`invalid-${corruption}`);
    success(await applyPlan(state, plan));
    const path = recordPath(state);
    const original = read(path);
    if (corruption === "null") fs.writeFileSync(path, "null\n");
    if (corruption === "malformed") fs.writeFileSync(path, "{not valid JSON\n");
    if (corruption === "symlink") {
      const target = join(root, "private-link-target.json"); fs.writeFileSync(target, original);
      fs.unlinkSync(path); fs.symlinkSync(target, path);
    }
    if (corruption === "missing") fs.unlinkSync(path);
    if (corruption === "revision") await state.ws!.withStoreLock(() => {
      const old = diskRecord(state)!;
      writeRecovery(state.outside!.storeDir, dir, SESSION, old.revision, { undo: old.undo, journal: old.journal });
    });
    if (corruption === "missing-target") {
      const changed = JSON.parse(original); changed.undo.snapshot[""] = "0".repeat(40);
      fs.writeFileSync(path, JSON.stringify(changed));
    }
    const damaged = fs.existsSync(path) ? read(path) : null;
    if (corruption === "missing" || corruption === "revision") {
      // A truly new session with no record is valid; disappearance after load is not.
      await assert.rejects(planUndo(state), /changed|revision/i);
      await assert.rejects(planRestore(state, cp), /changed|revision/i);
    } else {
      const loaded = await open(dir);
      if (corruption !== "missing-target") {
        assert.ok(loaded.recoveryError);
        await assert.rejects(planRestore(loaded, cp), /recovery|private|invalid/i);
      }
      await assert.rejects(planUndo(loaded));
    }
    assert.deepEqual(contents(dir), [A, A]);
    assert.equal(fs.existsSync(path) ? read(path) : null, damaged, "invalid metadata must not be replaced");
  });
}

test("partial outside Undo failure preserves exact RAM retry object and durable destination", async () => {
  const { dir, state, cp } = await setup("outside-failure");
  const external = join(root, "outside-owned.txt"); fs.writeFileSync(external, A);
  await state.ws!.withStoreLock(() => assert.ok(state.outside!.touch(external, [cp])));
  fs.writeFileSync(external, B);
  success(await applyPlan(state, (await planRestore(state, cp))!, { includeOutside: true }));
  assert.equal(read(external), A);
  const target = state.undo; assert.ok(target);
  const outside = state.outside!; const apply = outside.apply;
  outside.apply = () => ({ restored: 0, deleted: 0, errors: ["fixture outside undo failure"] });
  try {
    const result = await applyUndo(state, (await planUndo(state))!);
    assert.match(result!.errors.join("\n"), /fixture outside undo failure/);
  } finally { outside.apply = apply; }
  assert.equal(state.undo, target, "failed Undo must preserve exact retry object identity");
  assert.deepEqual(diskRecord(state)?.undo?.snapshot, target.snapshot);
  assert.deepEqual(diskRecord(state)?.undo?.outside, target.outside);
  assert.equal(diskRecord(state)?.journal?.phase, "failed");
  assert.deepEqual(contents(dir), [B, B]); assert.equal(read(external), A);
  const loaded = await open(dir);
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.equal(read(external), B); assert.equal(diskRecord(loaded)?.journal, null);
});

test("session generation change during held apply cannot publish into new session RAM", async () => {
  const { state, dir, plan } = await setup("generation");
  const ws = internals(state); const original = ws.applyLocked;
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const oldPath = recordPath(state);
  ws.applyLocked = async () => {
    assert.ok(diskRecord(state)?.journal); entered.resolve(); await release.promise;
    return { restored: 0, deleted: 0, skipped: [], errors: ["fixture held apply"] };
  };
  const applying = applyPlan(state, plan);
  try {
    await Promise.race([entered.promise, applying.then(() => { throw new Error("writer never entered"); })]);
    resetState(state); state.sessionId = "fixture-new-session";
    release.resolve(); await applying;
    assert.equal(state.undo, null); assert.equal(state.recovery, null); assert.equal(state.head, null);
    assert.equal(state.sessionId, "fixture-new-session");
    assert.ok(JSON.parse(read(oldPath)).journal, "old session remains durably recoverable");
    assert.deepEqual(contents(dir), [B, B]);
  } finally { release.resolve(); ws.applyLocked = original; await applying.catch(() => {}); }
});

test("repeated restore/Undo keeps tx refs bounded; cancellation preserves prior record", async () => {
  const { state, cp, plan } = await setup("bounded");
  success(await applyPlan(state, plan));
  for (let i = 0; i < 3; i++) {
    success(await applyUndo(state, (await planUndo(state))!));
    success(await applyPlan(state, (await planRestore(state, cp))!));
    await assertPins(state);
    for (const repo of state.ws!.repos.values()) {
      const refs = shadowGit(repo.gitDir, "for-each-ref", "--format=%(refname)", `refs/pi/${SESSION}/`).split("\n").filter(ref => ref.includes("/tx-"));
      assert.equal(refs.length, 1, "completed operations retain only the current durable Undo tx pin");
    }
  }
  const bytes = read(recordPath(state)); const undo = state.undo;
  const cancelled = await planRestore(state, cp); assert.ok(cancelled);
  await discardRestorePlan(state, cancelled);
  assert.equal(read(recordPath(state)), bytes); assert.equal(state.undo, undo);
});

test("real SIGKILL preserves partial files and journal; stale lock requires explicit fixture-only resolution", async () => {
  const dir = makeProject("sigkill");
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./register.mjs", import.meta.url)), fileURLToPath(import.meta.url), "--crash", dir], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, HOME: home, RECOVERY_TEST_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-16_384); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_384); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const death = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(death.signal, "SIGKILL", output); assert.equal(death.code, null);
  assert.deepEqual(contents(dir), [A, B]);
  const lock = join(storeDirFor(dir), "snapshot.lock"); fixturePath(lock);
  const stale = read(lock); assert.equal(JSON.parse(stale).pid, child.pid);
  const loaded = createInitialState(); loaded.sessionId = SESSION;
  beginWorkspace(loaded, dir); // Recovery load is synchronous; prime now waits behind the stale lock.
  const bytes = read(recordPath(loaded));
  assert.equal(loaded.recovery?.journal?.phase, "pending");
  try {
    await assert.rejects(withLock(lock, async () => { assert.fail("dead lock was automatically stolen"); }, { timeoutMs: 5, staleMs: 0 }), LockTimeout);
    assert.equal(read(lock), stale, "dead-looking lock must never be automatically stolen");
    assert.deepEqual(contents(dir), [A, B], "beginWorkspace must not replay the journal");
    assert.equal(read(recordPath(loaded)), bytes);
  } finally {
    // The child is confirmed dead. Simulate operator resolution of THIS fixture lock only.
    // Production deliberately never steals stale locks (unsafe compare-and-unlink race).
    assert.equal(read(lock), stale); fs.unlinkSync(lock);
    assert.ok(await waitReady(loaded));
  }
  assert.deepEqual(contents(dir), [A, B], "prime after explicit lock resolution must not replay either");
  await assert.rejects(planRestore(loaded, loaded.checkpoints.get("checkpoint-original")!), /interrupted|pending/i);
  success(await applyUndo(loaded, (await planUndo(loaded))!));
  assert.deepEqual(contents(dir), [B, B]); assert.equal(diskRecord(loaded)?.journal, null);
});

let passed = 0; let failed = 0;
try {
  for (const [name, run] of tests) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
  }
  console.log(`Recovery regression tests: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed) process.exitCode = 1;
} finally {
  // Never derive cleanup from the caller's HOME or production store location.
  fs.rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  Object.assign(process.env, inheritedGit);
}
