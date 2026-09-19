/** Final-review regressions. Every file and store is under a disposable HOME/root. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-review-regressions-")));
const priorHome = process.env.HOME;
process.env.HOME = join(root, "home"); fs.mkdirSync(process.env.HOME);
const { createInitialState } = await import("../src/state.js");
const { beginWorkspace, waitReady, ensureCheckpoint, captureProjectPreimage, planRestore, applyPlan, planUndo, applyUndo } = await import("../src/checkpoints.js");
const { recoveryPath } = await import("../src/recovery.js");
type State = ReturnType<typeof createInitialState>;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);
const read = (p: string) => fs.readFileSync(p, "utf8");
function project(name: string) {
  const dir = join(root, name); fs.mkdirSync(join(dir, "ignored"), { recursive: true });
  fs.writeFileSync(join(dir, "package.json"), '{"private":true}\n');
  fs.writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  fs.writeFileSync(join(dir, "a.txt"), "A\n");
  fs.writeFileSync(join(dir, "ignored/keep.txt"), "ignored sibling\n");
  return dir;
}
async function open(dir: string) {
  const state = createInitialState(); state.sessionId = "review-regressions";
  beginWorkspace(state, dir); assert.ok(await waitReady(state), state.readyError ?? "not ready");
  return state;
}
async function cp(state: State, id: string) {
  const point = await ensureCheckpoint(state, id, id, Date.now()); assert.ok(point, state.lastGap ?? "no checkpoint");
  state.currentEntryId = id; return point;
}

for (const tracked of [false, true]) test(`partial indexing rejects ${tracked ? "stale tracked" : "omitted unreadable"} checkpoint`, async () => {
  const dir = project(`unreadable-${tracked}`); const state = await open(dir);
  const file = join(dir, "locked.txt");
  if (tracked) { fs.writeFileSync(file, "OLD\n"); await cp(state, "old"); }
  fs.writeFileSync(file, "ORIGINAL UNREADABLE\n"); fs.chmodSync(file, 0);
  try {
    await assert.rejects(state.ws!.snapshotWithCoverage(state.head, "partial capture"), /incomplete|unreadable|index/i);
    assert.equal(await ensureCheckpoint(state, "unsafe", "unsafe", Date.now()), null);
    assert.equal(state.checkpoints.has("unsafe"), false);
    // Preserve the documented raw backend tolerance, not a user-facing target.
    await state.ws!.snapshot(state.head, "raw partial backend");
  } finally { fs.chmodSync(file, 0o600); }
  assert.equal(read(file), "ORIGINAL UNREADABLE\n");
  const safe = await cp(state, "readable");
  fs.writeFileSync(file, "AFTER\n");
  assert.deepEqual((await applyPlan(state, (await planRestore(state, safe))!))!.errors, []);
  assert.equal(read(file), "ORIGINAL UNREADABLE\n");
});

for (const pending of [false, true]) for (const corrupt of [false, true]) {
  test(`${pending ? "pending recovery" : "completed Undo"} retains ${corrupt ? "corrupt" : "missing"} outside target`, async () => {
    const dir = project(`undo-${pending}-${corrupt}`); const state = await open(dir); const point = await cp(state, "before");
    const outside = join(root, `outside-${pending}-${corrupt}.txt`);
    fs.writeFileSync(outside, "OUTSIDE A\n"); state.outside!.touch(outside, [point]);
    fs.writeFileSync(outside, "OUTSIDE B\n"); fs.writeFileSync(join(dir, "a.txt"), "B\n");
    const plan = (await planRestore(state, point))!;
    if (pending) {
      const ws = state.ws! as any; const original = ws.applyLocked;
      ws.applyLocked = async () => {
        assert.ok(state.recovery?.journal, "journal must precede the simulated partial writes");
        fs.writeFileSync(join(dir, "a.txt"), "A\n"); fs.writeFileSync(outside, "OUTSIDE A\n");
        throw new Error("fixture interrupted writer");
      };
      try { await assert.rejects(applyPlan(state, plan, { includeOutside: true }), /fixture interrupted writer/); }
      finally { ws.applyLocked = original; }
    } else assert.deepEqual((await applyPlan(state, plan, { includeOutside: true }))!.errors, []);
    const loaded = await open(dir);
    assert.equal(!!loaded.recovery?.journal, pending);
    const originalUndo = loaded.undo; assert.ok(originalUndo);
    const entry = originalUndo.outside![outside]; assert.ok("sha" in entry);
    const blob = join(loaded.outside!.storeDir, "outside", entry.sha.slice(0, 2), entry.sha);
    if (corrupt) fs.writeFileSync(blob, "CORRUPT\n"); else fs.rmSync(blob);
    const record = recoveryPath(loaded.outside!.storeDir, loaded.sessionId!); const priorRecord = read(record);
    const prepared = (await planUndo(loaded))!;
    assert.ok(prepared.plan.items.some(item => item.display === "a.txt" && item.action === "restore"));
    const outsideItem = prepared.plan.items.find(item => item.path === outside); assert.ok(outsideItem);
    // Planning checks blob presence; checksum corruption is detected at apply preflight.
    if (!corrupt) assert.equal(outsideItem.action, "unprotected");
    const result = (await applyUndo(loaded, prepared))!;
    assert.ok(result.errors.length, "missing target must refuse before any writer");
    assert.equal(result.restored + result.deleted, 0);
    assert.equal(read(join(dir, "a.txt")), "A\n"); assert.equal(read(outside), "OUTSIDE A\n");
    assert.equal(loaded.undo, originalUndo); assert.equal(read(record), priorRecord);
    fs.writeFileSync(blob, "OUTSIDE B\n");
    assert.deepEqual((await applyUndo(loaded, (await planUndo(loaded))!))!.errors, []);
    assert.equal(read(join(dir, "a.txt")), "B\n"); assert.equal(read(outside), "OUTSIDE B\n");
    assert.equal(loaded.recovery!.journal, null);
  });
}

test("bash creation then named edit preserves known pre-prompt absence", async () => {
  const dir = project("bash-created"); const state = await open(dir); const point = await cp(state, "before");
  const before = structuredClone(point.snapshot); const file = join(dir, "generated.txt");
  fs.writeFileSync(file, "BASH CREATED\n"); await captureProjectPreimage(state, "generated.txt");
  assert.deepEqual(point.snapshot, before); assert.ok(point.projectAbsent?.includes("generated.txt"));
  fs.writeFileSync(file, "EDITED\n"); fs.chmodSync(file, 0o600);
  assert.deepEqual((await applyPlan(state, (await planRestore(state, point))!))!.errors, []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((await applyUndo(state, (await planUndo(state))!))!.errors, []);
  assert.equal(read(file), "EDITED\n"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

for (const reload of [false, true]) test(`deleted forced ignored path retains later absence${reload ? " after reload" : ""}`, async () => {
  const dir = project(`forced-${reload}`); let state = await open(dir); await cp(state, "first");
  const rel = "ignored/file.txt"; const file = join(dir, rel);
  await captureProjectPreimage(state, rel); fs.writeFileSync(file, "FIRST CREATED\n");
  await cp(state, "exists"); fs.rmSync(file);
  let absent = await cp(state, "absent");
  assert.ok(absent.projectAbsent?.includes(rel));
  if (reload) { state = await open(dir); state.currentEntryId = "absent"; absent = state.checkpoints.get("absent")!; }
  assert.ok(state.forceTrack.has(rel)); assert.ok(absent.projectAbsent?.includes(rel));
  fs.writeFileSync(file, "RECREATED\n"); fs.chmodSync(file, 0o600);
  await captureProjectPreimage(state, rel);
  const plan = (await planRestore(state, absent))!;
  assert.equal(plan.items.find(item => item.display === rel)?.action, "delete");
  assert.deepEqual((await applyPlan(state, plan))!.errors, []); assert.equal(fs.existsSync(file), false);
  assert.deepEqual((await applyUndo(state, (await planUndo(state))!))!.errors, []);
  assert.equal(read(file), "RECREATED\n"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

for (const noop of [false, true]) test(`coverage-only nested warning does not trap ${noop ? "no-op recovery" : "Undo"}`, async () => {
  const dir = project(`coverage-only-${noop}`); const state = await open(dir);
  const skipped = "ignored/skipped-repo";
  fs.mkdirSync(join(dir, skipped, ".git"), { recursive: true });
  fs.writeFileSync(join(dir, skipped, "keep.txt"), "UNMANAGED\n");
  // Seed the same discovery outcome as an over-cap repo without creating 33
  // worktrees. Exercise actual buildPlan, transaction completion and retry.
  state.ws!.coverage.skippedNested.push(skipped);
  const point = await cp(state, "before"); fs.writeFileSync(join(dir, "a.txt"), "B\n");
  const plan = (await planRestore(state, point))!;
  if (noop) {
    const ws = state.ws! as any; const original = ws.applyLocked;
    ws.applyLocked = async () => { fs.writeFileSync(join(dir, "a.txt"), "A\n"); throw new Error("fixture interrupted writer"); };
    try { await assert.rejects(applyPlan(state, plan), /fixture interrupted writer/); }
    finally { ws.applyLocked = original; }
    assert.ok(state.recovery?.journal);
    fs.writeFileSync(join(dir, "a.txt"), "B\n"); // Operator already restored the managed target.
  } else assert.deepEqual((await applyPlan(state, plan))!.errors, []);
  const prepared = (await planUndo(state))!;
  assert.deepEqual((await applyUndo(state, prepared))!.errors, []);
  assert.equal(read(join(dir, "a.txt")), "B\n");
  assert.equal(state.recovery!.journal, null, "informational gaps must not poison future rewinds");
  if (!noop) assert.deepEqual(state.head, prepared.target, "completed Undo advances head despite coverage-only diagnostics");
  assert.deepEqual((await applyPlan(state, (await planRestore(state, point))!))!.errors, []);
  assert.equal(read(join(dir, "a.txt")), "A\n");
  assert.equal(read(join(dir, skipped, "keep.txt")), "UNMANAGED\n");
  // A formerly managed but now missing nested target is NOT informational.
  const missing = "ignored/managed-missing";
  const missingPlan = await state.ws!.buildPlan(point.snapshot, { ...point.snapshot, [missing]: point.snapshot[""] });
  const item = missingPlan.items.find(item => item.display === missing); assert.ok(item);
  assert.notEqual(item.coverageOnly, true);
  state.ws!.coverage.skippedNested.push("constructor");
  const diagnostics = await state.ws!.buildPlan(point.snapshot, point.snapshot);
  assert.equal(diagnostics.items.find(item => item.display === "constructor")?.coverageOnly, true, "only own tuple entries are managed targets");
});

let failed = 0;
try {
  for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`Review regressions: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
}
