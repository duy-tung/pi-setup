/** Real filesystem targets behind a mock Pi tree/fork host. Own all test state. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-target-safety-")));
const oldHome = process.env.HOME;
process.env.HOME = home;
try {
  const { createInitialState } = await import("../src/state.js");
  const { beginWorkspace, ensureCheckpoint, persistIndex, loadIndex, planUndo, applyUndo, restorePosition } = await import("../src/checkpoints.js");
  const { handleTreeRestore, handleForkRestore } = await import("../src/commands.js");
  const cwd = join(home, "project"), file = join(cwd, "file.txt");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(file, "before first\n");
  const state = createInitialState();
  state.sessionId = "parent";
  beginWorkspace(state, cwd);
  await state.ready;
  const cp1 = (await ensureCheckpoint(state, "u1", "first", Date.now()))!;
  assert.ok(cp1);
  writeFileSync(file, "after first\n");
  assert.ok(await ensureCheckpoint(state, "u2", "second", Date.now()));
  state.head = cp1.snapshot;
  state.currentEntryId = "u1";
  writeFileSync(file, "alternate branch base\n");
  assert.ok(await ensureCheckpoint(state, "ub", "branch", Date.now()));
  writeFileSync(file, "current branch bytes\n");

  const entry = (id: string, role: string, parentId: string | null = null) => ({ id, parentId, type: "message", message: { role, content: id } });
  const nodes = [entry("u1", "user"), entry("a1", "assistant", "u1"), entry("u2", "user", "a1"), entry("t2", "toolResult", "u2"), entry("gap", "user", "a1"), entry("ub", "user", "a1")];
  let menus = 0;
  let choice = "Restore code only";
  const ctx = {
    hasUI: true, isIdle: () => true,
    sessionManager: { getEntry: (id: string) => nodes.find(node => node.id === id) },
    ui: { select: async () => { menus++; return choice; }, confirm: async () => true, notify: () => {} },
  };
  for (const targetId of ["a1", "t2", "gap"]) {
    assert.equal(await handleTreeRestore(state, { preparation: { targetId } }, ctx), undefined);
    assert.equal(readFileSync(file, "utf8"), "current branch bytes\n");
  }
  assert.equal(menus, 0, "non-checkpoint selections do not offer ancestor code restore");
  assert.deepEqual(await handleTreeRestore(state, { preparation: { targetId: "u2" } }, ctx), { cancel: true });
  assert.equal(readFileSync(file, "utf8"), "after first\n", "an exact cross-branch target restores its own before-state");

  writeFileSync(file, "parent undo destination\n");
  choice = "Restore code and conversation";
  assert.equal(await handleForkRestore(state, { entryId: "u1" }, ctx), undefined, "successful combined restore permits the host fork");
  assert.equal(readFileSync(file, "utf8"), "before first\n");
  const shared: unknown[] = [];
  state.dirty = true;
  persistIndex({ appendEntry: (customType: string, data: unknown) => shared.push({ type: "custom", customType, data }) } as never, state);
  // Model the fork's copied public before metadata, not a TUI keypress or
  // transfer of a private recovery record. The child starts with its own ID.
  const child = createInitialState();
  child.sessionId = "child";
  loadIndex(child, shared);
  beginWorkspace(child, cwd);
  await child.ready;
  assert.equal(child.undo, null);
  const resumedParent = createInitialState();
  resumedParent.sessionId = "parent";
  loadIndex(resumedParent, shared);
  restorePosition(resumedParent, [nodes.at(-1)]);
  beginWorkspace(resumedParent, cwd);
  await resumedParent.ready;
  assert.ok(resumedParent.undo, "the parent retains durable Undo after a combined fork");
  const undo = await planUndo(resumedParent);
  assert.ok(undo);
  assert.deepEqual((await applyUndo(resumedParent, undo))?.errors, []);
  assert.equal(readFileSync(file, "utf8"), "parent undo destination\n");
  console.log("PASS target safety: non-user/gap refusal, exact cross-branch bytes, parent-owned durable fork Undo");
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
}
