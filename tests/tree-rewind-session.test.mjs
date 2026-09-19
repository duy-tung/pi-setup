import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load after setting HOME: neither the hooks nor their reaper may see real state.
const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-rewind-session-")));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { createInitialState, resetState } = await import("../extensions/tree-rewind/src/state.ts");
const { beginWorkspace, ensureCheckpoint, waitReady } = await import("../extensions/tree-rewind/src/checkpoints.ts");
const { default: install, settleBackend } = await import("../extensions/tree-rewind/src/index.ts");
const { Workspace, storeDirFor } = await import("../extensions/tree-rewind/src/workspace.ts");
const { runRewindFlow } = await import("../extensions/tree-rewind/src/commands.ts");
const { drainBackend } = await import("../extensions/tree-rewind/src/backend-lifetime.ts");
after(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
let sequence = 0;
function project() {
  const cwd = join(home, `project-${++sequence}`);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "file.txt"), "before\n");
  return cwd;
}
function stateFor() { const state = createInitialState(true); state.sessionId = `session-${++sequence}`; return state; }
function fakeWorkspace(cwd, prime = async () => {}) {
  const marked = [], released = [];
  const storeDir = storeDirFor(cwd);
  mkdirSync(storeDir, { recursive: true });
  return { cwd, storeDir, marked, released, prime,
    withStoreLock: async fn => fn(), markSessionActive: id => marked.push(id), releaseSession: id => released.push(id), maintain: async () => {},
    coverage: { nestedCount: 0, unrepresentable: [], skippedNested: [], degradedParents: [], defaultExcluded: [] },
  };
}
function host(cwd, state = stateFor()) {
  const handlers = new Map(), entries = [], notifications = [], statuses = [];
  let sessionId = state.sessionId;
  const user = { id: `u-${++sequence}`, type: "message", timestamp: "2026-09-12T12:00:00Z", message: { role: "user", content: "fixture prompt" } };
  const pi = {
    events: { emit: () => {}, on: () => () => {} },
    on: (name, fn) => handlers.set(name, fn), registerCommand: () => {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  install(pi, state);
  state.restoreBlocker = () => undefined;
  const ctx = {
    cwd, hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => [user], getEntry: id => id === user.id ? user : undefined, getLeafEntry: () => user },
    ui: { theme: { fg: (_color, text) => text }, setStatus: (...args) => statuses.push(args), notify: (...args) => notifications.push(args) },
  };
  return { state, ctx, handlers, user, notifications, statuses, entries, pi,
    start: () => handlers.get("session_start")({}, ctx),
    stop: () => handlers.get("session_shutdown")({}, ctx),
    switchId: () => { sessionId = `next-${++sequence}`; },
  };
}

test("a late open cannot prime, lease or publish into the next generation", { timeout: 2000 }, async () => {
  const cwd = project(), state = stateFor(), gate = deferred();
  const old = fakeWorkspace(cwd), next = fakeWorkspace(cwd);
  let options;
  beginWorkspace(state, cwd, async (_cwd, opts) => { options = opts; await gate.promise; return old; });
  const pending = state.ready, staleWait = waitReady(state), oldLife = state.lifetime;
  resetState(state);
  state.sessionId = "next-session";
  beginWorkspace(state, cwd, async () => next);
  try {
    await state.ready;
    gate.resolve();
    await pending;
    assert.equal(await staleWait, null);
    assert.equal(options.signal.aborted, true);
    assert.equal(state.ws, next);
    assert.deepEqual(old.marked, []);
    assert.deepEqual(next.marked, ["next-session"]);
    await drainBackend(oldLife);
  } finally { gate.resolve(); await pending; await settleBackend(state); }
});

test("cold prime stays unpublished and shutdown drains it without late UI or leases", { timeout: 2000 }, async () => {
  const cwd = project(), gate = deferred(), entered = deferred();
  const h = host(cwd); h.ctx.hasUI = true;
  let options;
  const ws = fakeWorkspace(cwd, async () => { entered.resolve(); await gate.promise; });
  const open = Workspace.open;
  Workspace.open = async (_cwd, opts) => { options = opts; return ws; };
  try {
    await h.start();
    await entered.promise;
    assert.equal(h.state.ws, null);
    const statuses = h.statuses.length, notifications = h.notifications.length;
    let finished = false;
    const stopping = h.stop().then(() => { finished = true; });
    assert.equal(options.signal.aborted, true);
    await turn();
    assert.equal(finished, false, "signalling prime is not proof it finished");
    gate.resolve();
    await stopping;
    assert.equal(h.state.ws, null);
    assert.deepEqual(ws.marked, []);
    assert.deepEqual(ws.released, []);
    assert.equal(h.statuses.length, statuses);
    assert.equal(h.notifications.length, notifications);
  } finally { gate.resolve(); await h.stop(); Workspace.open = open; }
});

test("published workspace Git is not aborted and only its own lease is released", { timeout: 2000 }, async () => {
  const cwd = project(), h = host(cwd), ws = fakeWorkspace(cwd);
  let options;
  const open = Workspace.open;
  Workspace.open = async (_cwd, opts) => { options = opts; return ws; };
  try {
    await h.start(); await h.state.ready;
    assert.equal(h.state.ws, ws);
    assert.equal(h.state.primeAbort, null);
    await h.stop();
    assert.equal(options.signal.aborted, false, "normal accepted writers drain instead of being killed");
    assert.deepEqual(ws.released, ws.marked);
    assert.equal(ws.released.length, 1);
    await h.stop();
    assert.equal(ws.released.length, 1, "shutdown is idempotent");
  } finally { await h.stop(); Workspace.open = open; }
});

test("real prime waiting on another process's lock cancels promptly", { timeout: 2000 }, async () => {
  const cwd = project(), state = stateFor(), store = storeDirFor(cwd);
  mkdirSync(store, { recursive: true });
  const lock = join(store, "snapshot.lock");
  writeFileSync(lock, "foreign writer");
  beginWorkspace(state, cwd);
  try {
    await turn();
    await settleBackend(state);
    assert.equal(state.ws, null);
    assert.equal(readFileSync(lock, "utf8"), "foreign writer");
  } finally { rmSync(lock, { force: true }); await state.ready; }
});

test("a previous workspace cannot release a successor's same-session lease", { timeout: 2000 }, async () => {
  const cwd = project(), first = await Workspace.open(cwd), second = await Workspace.open(cwd);
  await first.withStoreLock(() => first.markSessionActive("same-session"));
  await second.withStoreLock(() => second.markSessionActive("same-session"));
  const dir = join(first.storeDir, "sessions"), path = join(dir, readdirSync(dir)[0]);
  const before = readFileSync(path, "utf8");
  await first.withStoreLock(() => first.releaseSession("same-session"));
  assert.equal(readFileSync(path, "utf8"), before);
  await second.withStoreLock(() => second.releaseSession("same-session"));
  assert.deepEqual(readdirSync(dir), []);
});

test("shutdown does not wait on a menu and its old selection cannot enter a new session", { timeout: 3000 }, async () => {
  const cwd = project(), h = host(cwd), gate = deferred(), menu = deferred();
  const open = Workspace.open;
  Workspace.open = async () => fakeWorkspace(cwd);
  let selects = 0, navigations = 0;
  const command = { ...h.ctx, hasUI: true, navigateTree: async () => { navigations++; }, ui: {
    ...h.ctx.ui,
    select: async (_title, choices) => { if (++selects === 1) return choices.find(choice => choice.includes("fixture prompt")); menu.resolve(); return gate.promise; },
    confirm: async () => assert.fail("old menu resumed into new file operations"),
  } };
  let flow;
  try {
    await h.start(); await h.state.ready;
    h.state.checkpoints.set(h.user.id, { entryId: h.user.id, snapshot: { "": "a".repeat(40) } });
    flow = runRewindFlow(h.state, command);
    await menu.promise;
    await h.stop();
    h.switchId(); await h.start(); await h.state.ready;
    const count = h.notifications.length;
    gate.resolve("Restore code and conversation");
    await flow;
    assert.equal(navigations, 0);
    assert.equal(selects, 2);
    assert.equal(h.notifications.length, count);
  } finally { gate.resolve("Cancel"); await flow; await h.stop(); Workspace.open = open; }
});

test("a real preview's late confirmation cannot apply files after shutdown/reset", { timeout: 5000 }, async () => {
  const cwd = project(), file = join(cwd, "file.txt"), h = host(cwd), gate = deferred(), shown = deferred();
  const command = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui,
    select: async (title, choices) => title === "Rewind to prompt:" ? choices.find(choice => choice.includes("fixture prompt")) : "Restore code only",
    confirm: async () => { shown.resolve(); return gate.promise; },
  } };
  let flow;
  try {
    await h.start(); await h.state.ready;
    assert.ok(await ensureCheckpoint(h.state, h.user.id, "fixture prompt", Date.now()));
    writeFileSync(file, "after\n");
    flow = runRewindFlow(h.state, command);
    await shown.promise;
    await h.stop();
    assert.equal(readFileSync(file, "utf8"), "after\n");
    h.switchId(); await h.start(); await h.state.ready;
    const count = h.notifications.length;
    gate.resolve(true);
    await flow;
    assert.equal(readFileSync(file, "utf8"), "after\n");
    assert.equal(h.notifications.length, count);
  } finally { gate.resolve(false); await flow; await h.stop(); }
});

test("an accepted checkpoint publishes private/public metadata before shutdown finishes", { timeout: 5000 }, async () => {
  const cwd = project(), h = host(cwd), ready = deferred(), release = deferred();
  let capture;
  try {
    await h.start(); await h.state.ready;
    const ws = h.state.ws, snapshot = ws.snapshotWithCoverage.bind(ws);
    ws.snapshotWithCoverage = (parent, label, paths, options = {}) => snapshot(parent, label, paths, {
      ...options,
      publish: async result => { ready.resolve(); await release.promise; await options.publish?.(result); },
    });
    capture = h.handlers.get("turn_start")({}, h.ctx);
    await ready.promise;
    let finished = false;
    const stopping = h.stop().then(() => { finished = true; });
    await turn();
    assert.equal(finished, false);
    release.resolve(); await capture; await stopping;
    assert.ok(h.state.checkpoints.has(h.user.id));
    assert.ok(h.entries.some(entry => entry.data.checkpoints?.some(cp => cp.entryId === h.user.id)));
    assert.equal(h.state.operationEntryId, null, "closing does not schedule another observation");
  } finally { release.resolve(); await capture; await h.stop(); }
});

test("an old public-index append failure does not poison the next session", { timeout: 2000 }, async () => {
  const cwd = project(), h = host(cwd), open = Workspace.open;
  Workspace.open = async () => fakeWorkspace(cwd);
  const append = h.pi.appendEntry;
  try {
    await h.start(); await h.state.ready;
    h.state.checkpoints.set(h.user.id, { entryId: h.user.id, parentEntryId: null, prompt: "p", timestamp: 1, snapshot: {}, outside: {} });
    h.state.dirty = true;
    h.pi.appendEntry = () => { throw new Error("fixture public append unavailable"); };
    await assert.rejects(h.stop(), /fixture public append/);
    h.pi.appendEntry = append;
    h.switchId(); await h.start(); await h.state.ready;
    assert.equal(h.state.lifetime.closed, false);
    assert.ok(h.state.ws);
  } finally { h.pi.appendEntry = append; await h.stop().catch(() => {}); Workspace.open = open; }
});

test("shutdown waits for the complete preimage job and blocks a late core write", { timeout: 5000 }, async () => {
  const cwd = project(), file = join(cwd, "file.txt"), h = host(cwd), captured = deferred(), release = deferred();
  let tool;
  try {
    await h.start(); await h.state.ready;
    await h.handlers.get("turn_start")({}, h.ctx);
    const ws = h.state.ws, backfill = ws.backfillFile.bind(ws);
    ws.backfillFile = async (...args) => { await backfill(...args); captured.resolve(); await release.promise; };
    tool = h.handlers.get("tool_call")({ toolName: "write", input: { path: file, content: "late\n" } }, h.ctx);
    await captured.promise;
    let stopped = false;
    const stopping = h.stop().then(() => { stopped = true; });
    await turn();
    assert.equal(stopped, false, "the post-lock tool hook is still an accepted backend job");
    release.resolve();
    const result = await tool;
    if (!result?.block) writeFileSync(file, "late\n"); // Model the core's tool-call gate.
    await stopping;
    assert.equal(result?.block, true);
    assert.match(result.reason, /closing/);
    assert.equal(readFileSync(file, "utf8"), "before\n");
  } finally { release.resolve(); await tool; await h.stop(); }
});

test("an incomplete public chain lets equal-revision private state repair a backfilled checkpoint", { timeout: 5000 }, async () => {
  const cwd = project(), ignored = join(cwd, "ignored.txt");
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  writeFileSync(ignored, "preimage\n");
  const { captureProjectPreimage, persistIndex, planRestore, applyPlan, restorePosition, loadIndex } = await import("../extensions/tree-rewind/src/checkpoints.ts");
  const state = stateFor(), entries = [];
  const pi = { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }) };
  beginWorkspace(state, cwd); await state.ready;
  const u1 = { id: "u1", type: "message", message: { role: "user" } };
  assert.ok(await ensureCheckpoint(state, "u1", "first", Date.now()));
  state.currentEntryId = "u1";
  persistIndex(pi, state, entries);                       // base without the ignored file
  await captureProjectPreimage(state, "ignored.txt");      // private + public delta carry the preimage
  writeFileSync(ignored, "overwritten\n");
  persistIndex(pi, state, entries);
  assert.ok(await ensureCheckpoint(state, "u2", "second", Date.now()));
  persistIndex(pi, state, entries);
  assert.equal(entries.length, 3);
  const revision = state.checkpointRevision;
  await settleBackend(state);
  // The backfill delta is missing from what reload sees; the private revision is equal.
  const damaged = [entries[0], entries[2]];
  const reloaded = stateFor(); reloaded.sessionId = state.sessionId;
  loadIndex(reloaded, damaged);
  assert.match(reloaded.lastGap, /chain incomplete/);
  assert.equal(reloaded.indexRevision, revision, "the revision floor for private saves is unchanged");
  assert.ok(reloaded.indexObjectRevision.get("u1") < revision, "a base object carries its own older batch revision");
  restorePosition(reloaded, [u1]);
  beginWorkspace(reloaded, cwd); await reloaded.ready;
  assert.equal(reloaded.checkpointRevision, revision);
  assert.ok(reloaded.checkpoints.get("u1").projectTouched?.includes("ignored.txt"), "private state repaired the checkpoint");
  const plan = await planRestore(reloaded, reloaded.checkpoints.get("u1"));
  assert.deepEqual((await applyPlan(reloaded, plan))?.errors, []);
  assert.equal(readFileSync(ignored, "utf8"), "preimage\n");
  await settleBackend(reloaded);
});

test("older private state never replaces an object from a newer surviving batch", { timeout: 5000 }, async () => {
  const { loadIndex } = await import("../extensions/tree-rewind/src/checkpoints.ts");
  const { saveCheckpointState } = await import("../extensions/tree-rewind/src/checkpoint-store.ts");
  const { CUSTOM_TYPE } = await import("../extensions/tree-rewind/src/types.ts");
  const cwd = project(), state = stateFor(), storeDir = storeDirFor(cwd);
  mkdirSync(storeDir, { recursive: true });
  const cp = (entryId, prompt) => ({ entryId, parentEntryId: null, prompt, timestamp: 1, snapshot: {}, outside: {} });
  assert.equal(saveCheckpointState(storeDir, cwd, state.sessionId, [cp("u1", "private-u1"), cp("u2", "private-u2")], 0, 7), 8);
  const batch = (data) => ({ type: "custom", customType: CUSTOM_TYPE, data });
  loadIndex(state, [
    batch({ version: 5, kind: "base", token: "t5", parent: null, localRevision: 5, sessionId: state.sessionId, checkpoints: [cp("u1", "public-u1"), cp("u2", "public-u2")], removed: [] }),
    batch({ version: 5, kind: "delta", token: "t10", parent: "missing", localRevision: 10, sessionId: state.sessionId, checkpoints: [cp("u2", "newer-u2")], removed: [] }),
  ]);
  assert.match(state.lastGap, /chain incomplete/);
  beginWorkspace(state, cwd); await state.ready;
  assert.equal(state.checkpoints.get("u1").prompt, "private-u1", "private revision 8 repairs the revision-5 base object");
  assert.equal(state.checkpoints.get("u2").prompt, "newer-u2", "the revision-10 surviving object is kept");
  assert.equal(state.checkpointRevision, 8);
  await settleBackend(state);
});

test("outside preview targets are bounded, hash-checked and never follow a swapped symlink", async () => {
  const { OutsideStore } = await import("../extensions/tree-rewind/src/outside.ts");
  const { createHash } = await import("node:crypto");
  const { symlinkSync, appendFileSync } = await import("node:fs");
  const cwd = project(), store = new OutsideStore(cwd, join(home, "store"));
  const bytes = Buffer.from("target bytes\n"), sha = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(store.blobDir, sha.slice(0, 2)), { recursive: true });
  const path = join(store.blobDir, sha.slice(0, 2), sha);
  writeFileSync(path, bytes);
  const item = { repo: "~", path: "/x", display: "/x", action: "restore", targetSha: sha };
  assert.deepEqual(store.targetBlob(item, 64), bytes);
  assert.equal(store.targetBlob(item, 4), "large");
  appendFileSync(path, "grown\n");
  assert.equal(store.targetBlob(item, 64), null, "changed bytes fail the hash instead of being returned");
  rmSync(path);
  writeFileSync(join(home, "elsewhere"), bytes);
  symlinkSync(join(home, "elsewhere"), path);
  assert.equal(store.targetBlob(item, 64), null, "a symlinked blob is never followed");
});
