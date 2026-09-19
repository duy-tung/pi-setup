/** First-touch coverage through the same checkpoint/capture/apply path as Pi. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, applyUndo, beginWorkspace, captureProjectPreimage, loadIndex, persistIndex, planRestore, planUndo, waitReady } from "../src/checkpoints.js";
import { createInitialState } from "../src/state.js";
import extension, { checkpointCurrentUserEntry } from "../src/index.js";
import { checkpointStatePath, readCheckpointState } from "../src/checkpoint-store.js";
import { PrivateWriteError } from "../src/storage.js";
import { storeDirFor } from "../src/workspace.js";

const root = mkdtempSync(join(tmpdir(), "pi-preimage-tests-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
function makeProject(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "ignored"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.skip\n");
  writeFileSync(join(dir, "normal.txt"), "NORMAL ORIGINAL\n");
  writeFileSync(join(dir, "ignored/keep.txt"), "IGNORED ORIGINAL\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture");
  return realpathSync(dir);
}
async function open(dir: string, sessionId = "preimage-session", entries: unknown[] = []) {
  const state = createInitialState(); state.sessionId = sessionId;
  loadIndex(state, entries);
  beginWorkspace(state, dir); assert.ok(await waitReady(state));
  return state;
}
async function checkpoint(state: ReturnType<typeof createInitialState>, id: string) {
  state.currentPrompt = id;
  const cp = await checkpointCurrentUserEntry(state, {
    hasUI: false,
    sessionManager: { getLeafEntry: () => ({ id, type: "message", message: { role: "user" }, timestamp: new Date().toISOString() }) },
  });
  assert.ok(cp, state.lastGap ?? "checkpoint missing"); return cp;
}

try {
  const dir = makeProject("original");
  const state = await open(dir);
  chmodSync(join(dir, "ignored/keep.txt"), 0o600);
  const cp = await checkpoint(state, "u1");
  const beforeGit = readFileSync(join(dir, ".git/index"));
  writeFileSync(join(dir, "normal.txt"), "EARLIER TOOL CHANGE\n");
  await captureProjectPreimage(state, "ignored/keep.txt");
  writeFileSync(join(dir, "ignored/keep.txt"), "AGENT CHANGE\n");
  const plan = await planRestore(state, cp); assert.ok(plan);
  assert.equal(plan.items.find(item => item.display === "ignored/keep.txt")?.action, "restore");
  assert.equal((await applyPlan(state, plan))?.errors.length, 0);
  assert.equal(readFileSync(join(dir, "ignored/keep.txt"), "utf8"), "IGNORED ORIGINAL\n");
  assert.equal(lstatSync(join(dir, "ignored/keep.txt")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "normal.txt"), "utf8"), "NORMAL ORIGINAL\n", "preimage patch must not absorb earlier tool edits");
  assert.ok(readFileSync(join(dir, ".git/index")).equals(beforeGit), "real Git index unchanged");
  await applyUndo(state, (await planUndo(state))!);
  assert.equal(readFileSync(join(dir, "ignored/keep.txt"), "utf8"), "AGENT CHANGE\n");

  const newCp = await checkpoint(state, "u2");
  await captureProjectPreimage(state, "ignored/new.txt");
  assert.ok(newCp.projectAbsent?.includes("ignored/new.txt"));
  writeFileSync(join(dir, "ignored/new.txt"), "NEW\n");
  const afterCreate = await checkpoint(state, "u3");
  assert.ok(await state.ws!.repos.get("")!.entryAt(afterCreate.snapshot[""], "ignored/new.txt"), "an initially absent forced file is staged after creation");
  await applyPlan(state, (await planRestore(state, newCp))!);
  assert.equal(existsSync(join(dir, "ignored/new.txt")), false);
  writeFileSync(join(dir, "ignored/new.txt"), "RECREATED\n");
  const recreated = await checkpoint(state, "u4");
  assert.ok(await state.ws!.repos.get("")!.entryAt(recreated.snapshot[""], "ignored/new.txt"), "deleted/recreated forced files remain captured");

  const oldDir = makeProject("older"); const oldState = await open(oldDir);
  const older = await checkpoint(oldState, "older");
  writeFileSync(join(oldDir, "ignored/keep.txt"), "MANUAL BEFORE NEXT PROMPT\n");
  const current = await checkpoint(oldState, "current");
  await captureProjectPreimage(oldState, "ignored/keep.txt");
  writeFileSync(join(oldDir, "ignored/keep.txt"), "CURRENT MODIFIED\n");
  const olderPlan = (await planRestore(oldState, older))!;
  assert.equal(olderPlan.items.find(item => item.display === "ignored/keep.txt")?.action, "unprotected");
  await applyPlan(oldState, olderPlan);
  assert.equal(readFileSync(join(oldDir, "ignored/keep.txt"), "utf8"), "CURRENT MODIFIED\n", "do not invent older contents or delete unknown history");
  await applyPlan(oldState, (await planRestore(oldState, current))!);
  assert.equal(readFileSync(join(oldDir, "ignored/keep.txt"), "utf8"), "MANUAL BEFORE NEXT PROMPT\n");

  const rulesDir = makeProject("changed-ignore"); const rules = await open(rulesDir);
  const ignoredBefore = await checkpoint(rules, "before-rules");
  writeFileSync(join(rulesDir, ".gitignore"), "");
  writeFileSync(join(rulesDir, "new-normal.txt"), "new codegen file\n");
  await checkpoint(rules, "after-rules");
  const rulesPlan = (await planRestore(rules, ignoredBefore))!;
  assert.equal(rulesPlan.items.find(item => item.display === "ignored/keep.txt")?.action, "unprotected");
  assert.equal(rulesPlan.items.find(item => item.display === "new-normal.txt")?.action, "delete");
  await applyPlan(rules, rulesPlan);
  assert.ok(existsSync(join(rulesDir, "ignored/keep.txt")), "historical ignores remain unknown after rule changes");
  assert.equal(existsSync(join(rulesDir, "new-normal.txt")), false, "ordinary new bash/codegen files still rewind");

  const reloadDir = makeProject("reload"); const first = await open(reloadDir);
  await checkpoint(first, "persisted-before-tools");
  const olderJsonl: unknown[] = [];
  persistIndex({ appendEntry: (customType: string, data: unknown) => olderJsonl.push(JSON.parse(JSON.stringify({ type: "custom", customType, data }))) } as never, first);
  await captureProjectPreimage(first, "ignored/keep.txt");
  writeFileSync(join(reloadDir, "ignored/keep.txt"), "AFTER TOOL BEFORE TURN_END\n");
  const reloaded = await open(reloadDir, "preimage-session", olderJsonl);
  assert.ok(reloaded.forceTrack.has("ignored/keep.txt"));
  const durable = reloaded.checkpoints.get("persisted-before-tools"); assert.ok(durable);
  await applyPlan(reloaded, (await planRestore(reloaded, durable))!);
  assert.equal(readFileSync(join(reloadDir, "ignored/keep.txt"), "utf8"), "IGNORED ORIGINAL\n", "preimage survives reload without a turn_end/JSONL flush");

  const nestedDir = makeProject("nested");
  const dep = join(nestedDir, "vendor/dep"); mkdirSync(join(dep, "cache"), { recursive: true });
  git(dep, "init", "-q"); writeFileSync(join(dep, ".gitignore"), "cache/\n");
  writeFileSync(join(dep, "cache/item.txt"), "NESTED ORIGINAL\n");
  git(dep, "add", "-A"); git(dep, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "nested");
  git(nestedDir, "add", "vendor/dep");
  const nested = await open(nestedDir); const nestedCp = await checkpoint(nested, "nested-prompt");
  const rootCommit = nestedCp.snapshot[""];
  await captureProjectPreimage(nested, "vendor/dep/cache/item.txt");
  assert.equal(nestedCp.snapshot[""], rootCommit, "nested preimage does not restage the root");
  writeFileSync(join(dep, "cache/item.txt"), "NESTED MODIFIED\n");
  await applyPlan(nested, (await planRestore(nested, nestedCp))!);
  assert.equal(readFileSync(join(dep, "cache/item.txt"), "utf8"), "NESTED ORIGINAL\n");

  const syncDir = makeProject("post-publication-sync");
  const syncing = await open(syncDir); await checkpoint(syncing, "sync-prompt");
  const sync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("fixture directory sync failure"), { code: "EIO" });
    sync(fd);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureProjectPreimage(syncing, "ignored/keep.txt"), error => error instanceof PrivateWriteError && error.published);
  } finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  const committed = readCheckpointState(syncing.outside!.storeDir, syncDir, syncing.sessionId!).checkpoints[0];
  assert.equal(await syncing.ws!.repos.get("")!.refValue(`refs/pi/${syncing.sessionId}/sync-prompt`), committed.snapshot[""]);
  assert.equal(readFileSync(join(syncDir, "ignored/keep.txt"), "utf8"), "IGNORED ORIGINAL\n");
  const afterSync = await open(syncDir);
  writeFileSync(join(syncDir, "ignored/keep.txt"), "AFTER RELOAD\n");
  await applyPlan(afterSync, (await planRestore(afterSync, afterSync.checkpoints.get("sync-prompt")!))!);
  assert.equal(readFileSync(join(syncDir, "ignored/keep.txt"), "utf8"), "IGNORED ORIGINAL\n", "post-rename errors must not unpin the published preimage");

  const hookDir = makeProject("real-hook");
  const hooks = new Map<string, Function>();
  extension({ on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand: () => {}, events: {}, appendEntry: () => {} } as never);
  const hookCtx = { cwd: hookDir, hasUI: false, sessionManager: {
    getSessionId: () => "hook-session", getEntries: () => [], getBranch: () => [],
    getLeafEntry: () => ({ id: "hook-user", type: "message", message: { role: "user" }, timestamp: new Date().toISOString() }),
  } };
  await hooks.get("session_start")!({}, hookCtx);
  await hooks.get("before_agent_start")!({ prompt: "hook prompt" }, hookCtx);
  await hooks.get("turn_start")!({}, hookCtx);
  const privatePath = checkpointStatePath(storeDirFor(hookDir), "hook-session");
  assert.ok(existsSync(privatePath));
  const privateDir = join(storeDirFor(hookDir), "checkpoints"); chmodSync(privateDir, 0o500);
  try {
    const blocked = await hooks.get("tool_call")!({ toolName: "edit", input: { path: "ignored/keep.txt" } }, hookCtx);
    assert.equal(blocked?.block, true, "a durable preimage publication failure blocks the actual tool hook");
    assert.equal(readFileSync(join(hookDir, "ignored/keep.txt"), "utf8"), "IGNORED ORIGINAL\n");
  } finally { chmodSync(privateDir, 0o700); }
  const allowed = await hooks.get("tool_call")!({ toolName: "edit", input: { path: "ignored/keep.txt" } }, hookCtx);
  assert.equal(allowed, undefined, "capture retries after the storage failure is resolved");
  await hooks.get("session_shutdown")!({}, hookCtx);
  console.log("PASS preimages: original bytes/mode, exact one-file patch, absent/create/recreate, older unknown, ignore changes, reload, nested repo, actual tool-hook failure gate");
} finally {
  rmSync(root, { recursive: true, force: true });
}
