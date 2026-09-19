import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-operation-tests-")));
const oldHome = process.env.HOME;
process.env.HOME = join(root, "home"); fs.mkdirSync(process.env.HOME);
const { default: extension } = await import("../src/index.js");
const { createInitialState, resetState } = await import("../src/state.js");
const { beginWorkspace, waitReady, ensureCheckpoint, captureOperationAfter, planRestore, applyPlan, loadIndex, persistIndex } = await import("../src/checkpoints.js");
const { readCheckpointState, checkpointStatePath, validCheckpoint } = await import("../src/checkpoint-store.js");
const { Workspace, storeDirFor } = await import("../src/workspace.js");

let count = 0;
function project(name: string) {
  const dir = join(root, name); fs.mkdirSync(join(dir, "ignored"), { recursive: true });
  fs.writeFileSync(join(dir, "package.json"), '{"private":true}\n');
  fs.writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  fs.writeFileSync(join(dir, "file.txt"), "BEFORE\n");
  fs.writeFileSync(join(dir, "ignored/file.txt"), "IGNORED BEFORE\n");
  return dir;
}
async function open(dir: string, sessionId = "operations", entries: any[] = []) {
  const state = createInitialState(); state.sessionId = sessionId;
  loadIndex(state, entries); beginWorkspace(state, dir);
  assert.ok(await waitReady(state), state.readyError ?? state.disabled ?? "unavailable");
  return state;
}
async function setup(name: string) {
  const dir = project(name); const state = await open(dir);
  const cp = await ensureCheckpoint(state, "u1", "fixture", Date.now()); assert.ok(cp);
  state.currentEntryId = "u1"; state.operationEntryId = "u1";
  return { dir, state, cp };
}
async function text(state: Awaited<ReturnType<typeof open>>, snapshot: Record<string, string>, path = "file.txt") {
  const repo = state.ws!.repos.get("")!;
  const entry = await repo.entryAt(snapshot[""], path); assert.ok(entry);
  return (await repo.catBlob(entry.sha))!.toString();
}
async function check(name: string, fn: () => Promise<void>) {
  await fn(); console.log(`ok ${++count} - ${name}`);
}

try {
  await check("private before/after pair keeps restore target, head and JSONL node count unchanged", async () => {
    const { dir, state, cp } = await setup("pair");
    const before = structuredClone(cp.snapshot); const head = state.head;
    const entries: any[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }) } as never;
    persistIndex(pi, state); assert.equal(entries.length, 1);
    fs.writeFileSync(join(dir, "file.txt"), "AFTER\n");
    assert.equal(await captureOperationAfter(state), true);
    assert.equal(state.head, head); assert.deepEqual(cp.snapshot, before);
    assert.equal(await text(state, cp.after!.snapshot), "AFTER\n");
    assert.equal(await text(state, before), "BEFORE\n");
    persistIndex(pi, state); assert.equal(entries.length, 1, "after-only state must not append a tree entry");
    const loaded = await open(dir, "operations", entries);
    assert.deepEqual(loaded.checkpoints.get("u1")!.after, cp.after);
    const plan = (await planRestore(loaded, loaded.checkpoints.get("u1")!))!;
    assert.deepEqual(plan.to, before);
    assert.deepEqual((await applyPlan(loaded, plan))!.errors, []);
    assert.equal(fs.readFileSync(join(dir, "file.txt"), "utf8"), "BEFORE\n");
  });

  await check("repeated observations keep one op ref and strict metadata validation", async () => {
    const { dir, state, cp } = await setup("bounded");
    for (let i = 0; i < 3; i++) {
      state.operationEntryId = "u1"; fs.writeFileSync(join(dir, "file.txt"), `AFTER ${i}\n`);
      assert.equal(await captureOperationAfter(state), true);
    }
    const refDir = join(state.ws!.storeDir, "root.git", "refs", "pi", "operations");
    assert.equal(fs.readdirSync(refDir).filter(name => name.startsWith("op-")).length, 1);
    assert.equal(validCheckpoint(cp), true);
    assert.equal(validCheckpoint({ ...cp, after: { ...cp.after, refId: "../../escape" } }), false);
    assert.equal(validCheckpoint({ ...cp, after: { ...cp.after, snapshot: { "../bad": "a".repeat(40) } } }), false);
    assert.equal(validCheckpoint({ ...cp, after: { ...cp.after, outside: { relative: { absent: true } } } }), false);
  });

  await check("failed publication preserves before and retires unpublished op ref", async () => {
    const { state, cp } = await setup("failure"); const before = structuredClone(cp.snapshot);
    const directory = join(state.ws!.storeDir, "checkpoints"); fs.chmodSync(directory, 0o500);
    try { assert.equal(await captureOperationAfter(state), false); }
    finally { fs.chmodSync(directory, 0o700); }
    assert.deepEqual(cp.snapshot, before); assert.equal(cp.after, undefined);
    assert.equal(fs.readdirSync(join(state.ws!.storeDir, "root.git", "refs", "pi", "operations")).filter(name => name.startsWith("op-")).length, 0);
    state.operationEntryId = "u1"; assert.equal(await captureOperationAfter(state), true);
  });

  await check("post-rename failure retains published after ref across reload", async () => {
    const { dir, state } = await setup("published-failure");
    const sync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("fixture directory sync"), { code: "EIO" });
      sync(fd);
    };
    syncBuiltinESMExports();
    try { assert.equal(await captureOperationAfter(state), false); }
    finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
    const after = readCheckpointState(state.ws!.storeDir, dir, "operations").checkpoints[0].after!;
    assert.ok(after);
    assert.equal(await state.ws!.repos.get("")!.refValue(`refs/pi/operations/${after.refId}`), after.snapshot[""]);
    assert.deepEqual((await open(dir)).checkpoints.get("u1")!.after, after);
  });

  await check("session generation reset rejects old publication and preserves new state", async () => {
    const { state, cp } = await setup("generation"); const ws = state.ws!;
    const original = ws.snapshotWithCoverage.bind(ws);
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    ws.snapshotWithCoverage = (parent, message, forced, opts = {}) => original(parent, message, forced, {
      ...opts, publish: async captured => { entered.resolve(); await release.promise; await opts.publish?.(captured); },
    });
    const pending = captureOperationAfter(state); await entered.promise;
    resetState(state); state.sessionId = "next-session"; state.operationEntryId = "next-user";
    release.resolve(); assert.equal(await pending, false);
    assert.equal(state.operationEntryId, "next-user"); assert.equal(state.lastGap, null);
    assert.equal(cp.after, undefined);
    assert.equal(fs.readdirSync(join(ws.storeDir, "root.git", "refs", "pi", "operations")).filter(name => name.startsWith("op-")).length, 0);
  });

  await check("actual hooks capture at settled/queued boundaries, not intermediate turns, without extra nodes", async () => {
    const dir = project("hooks"); const sessionId = "hook-operations";
    const hooks = new Map<string, Function>(); const commands: string[] = []; const entries: any[] = []; let appended = 0; let leaf: any;
    extension({
      on: (name: string, handler: Function) => hooks.set(name, handler),
      registerCommand: (name: string) => commands.push(name), events: {},
      appendEntry: (customType: string, data: unknown) => { appended++; entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    } as never);
    const ctx = { cwd: dir, hasUI: false, sessionManager: {
      getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => entries, getLeafEntry: () => leaf,
    } };
    const user = async (id: string) => {
      await hooks.get("before_agent_start")!({ prompt: id }, ctx);
      leaf = { id, type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: id } }; entries.push(leaf);
      await hooks.get("turn_start")!({}, ctx);
    };
    const persisted = () => readCheckpointState(storeDirFor(dir), dir, sessionId).checkpoints;
    await hooks.get("session_start")!({}, ctx); await user("u1");
    await hooks.get("tool_call")!({ toolName: "edit", input: { path: "ignored/file.txt" } }, ctx);
    fs.writeFileSync(join(dir, "ignored/file.txt"), "IGNORED AFTER\n");
    fs.writeFileSync(join(dir, "file.txt"), "FIRST AFTER\n");
    const outside = join(root, "hook-outside.txt"); fs.writeFileSync(outside, "OUTSIDE BEFORE\n");
    await hooks.get("tool_call")!({ toolName: "edit", input: { path: outside } }, ctx);
    fs.writeFileSync(outside, "OUTSIDE AFTER\n");
    await hooks.get("turn_end")!({}, ctx); assert.equal(persisted()[0].after, undefined);
    assert.equal(hooks.has("agent_end"), false);
    await user("u2"); // Queued/steering boundary seals u1 before binding u2.
    const first = persisted().find(cp => cp.entryId === "u1")!;
    assert.ok(first.after);
    const reader = await open(dir, sessionId, entries);
    assert.equal(await text(reader, first.after.snapshot), "FIRST AFTER\n");
    assert.equal(await text(reader, first.after.snapshot, "ignored/file.txt"), "IGNORED AFTER\n");
    const outsideAfter = first.after.outside![outside]; assert.ok("sha" in outsideAfter);
    assert.equal(fs.readFileSync(join(storeDirFor(dir), "outside", outsideAfter.sha.slice(0, 2), outsideAfter.sha), "utf8"), "OUTSIDE AFTER\n");
    fs.writeFileSync(join(dir, "file.txt"), "SECOND AFTER\n");
    await hooks.get("turn_end")!({}, ctx);
    // Equal JSONL/private revision still merges the private-only earlier after.
    const equalReload = await open(dir, sessionId, entries);
    assert.deepEqual(equalReload.checkpoints.get("u1")!.after, first.after);
    assert.ok(entries.filter(e => e.type === "custom").every(e => e.data.checkpoints.every((cp: any) => !Object.hasOwn(cp, "after"))));
    const beforeSettled = appended;
    await hooks.get("agent_settled")!({}, ctx);
    assert.equal(appended, beforeSettled);
    const second = persisted().find(cp => cp.entryId === "u2")!;
    assert.equal(await text(reader, second.snapshot), "FIRST AFTER\n");
    assert.equal(await text(reader, second.after!.snapshot), "SECOND AFTER\n");
    await hooks.get("agent_settled")!({}, ctx); assert.equal(appended, beforeSettled);
    await hooks.get("session_shutdown")!({}, ctx); assert.equal(appended, beforeSettled);
    assert.deepEqual(commands, ["rewind"]);
    const fork = await open(dir, "fork-operations", entries);
    assert.equal(fork.checkpoints.get("u1")!.after, undefined, "fork keeps before targets, not another session's private operation refs");
  });

  await check("a new run waits for the prior in-flight settled observation", async () => {
    const dir = project("run-barrier"); const hooks = new Map<string, Function>();
    extension({ on: (name: string, handler: Function) => hooks.set(name, handler), registerCommand: () => {}, events: {}, appendEntry: () => {} } as never);
    const ctx = { cwd: dir, hasUI: false, sessionManager: {
      getSessionId: () => "run-barrier", getEntries: () => [], getBranch: () => [],
      getLeafEntry: () => ({ id: "u1", type: "message", timestamp: new Date().toISOString(), message: { role: "user" } }),
    } };
    await hooks.get("session_start")!({}, ctx);
    await hooks.get("before_agent_start")!({ prompt: "first" }, ctx); await hooks.get("turn_start")!({}, ctx);
    const original = Workspace.prototype.snapshotWithCoverage;
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    Workspace.prototype.snapshotWithCoverage = function (parent, message, forced, opts = {}) {
      return original.call(this, parent, message, forced, message.startsWith("operation after") ? {
        ...opts, publish: async captured => { entered.resolve(); await release.promise; await opts.publish?.(captured); },
      } : opts);
    };
    const settled = hooks.get("agent_settled")!({}, ctx);
    try {
      await entered.promise;
      let started = false;
      const next = hooks.get("before_agent_start")!({ prompt: "second" }, ctx).then(() => { started = true; });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(started, false, "new tools must not race the old observation");
      release.resolve(); await settled; await next; assert.equal(started, true);
    } finally { release.resolve(); await settled; Workspace.prototype.snapshotWithCoverage = original; }
    await hooks.get("session_shutdown")!({}, ctx);
  });

  await check("explicit file restore supersedes the pending observation", async () => {
    const { dir, state, cp } = await setup("superseded");
    fs.writeFileSync(join(dir, "file.txt"), "AFTER\n");
    assert.deepEqual((await applyPlan(state, (await planRestore(state, cp))!))!.errors, []);
    assert.equal(state.operationEntryId, null);
    assert.equal(await captureOperationAfter(state), false);
    assert.equal(cp.after, undefined);
  });

  await check("projectless operation records only guarded named files", async () => {
    const dir = join(root, "plain"); fs.mkdirSync(dir);
    const state = createInitialState(); state.sessionId = "plain-operations";
    beginWorkspace(state, dir); assert.ok(state.disabled); assert.equal(state.ws, null);
    const cp = await ensureCheckpoint(state, "u1", "plain", Date.now()); assert.ok(cp);
    state.currentEntryId = "u1"; state.operationEntryId = "u1";
    const file = join(dir, "file.txt"); fs.writeFileSync(file, "BEFORE\n");
    state.outside!.touch(file, [cp]); fs.writeFileSync(file, "AFTER\n");
    assert.equal(await captureOperationAfter(state), true);
    assert.deepEqual(cp.after!.snapshot, {}); assert.ok(cp.after!.outside![file]);
  });
  console.log(`PASS: ${count} operation snapshot fixture groups`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
}
