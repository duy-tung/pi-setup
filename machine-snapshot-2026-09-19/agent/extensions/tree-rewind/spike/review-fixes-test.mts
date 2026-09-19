/** Regressions for the 2026-09 review findings. Every file and store is under a disposable HOME/root. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-review-fixes-")));
const priorHome = process.env.HOME;
process.env.HOME = join(root, "home"); fs.mkdirSync(process.env.HOME);
const { createInitialState, resetState } = await import("../src/state.js");
const { beginWorkspace, waitReady, ensureCheckpoint, planRestore, applyPlan, planUndo, applyUndo, persistLocalIndex } = await import("../src/checkpoints.js");
const { runRewindFlow, handleTreeRestore } = await import("../src/commands.js");
const { checkTrackablePath } = await import("../src/eligibility.js");
const { OutsideStore } = await import("../src/outside.js");
const { Workspace } = await import("../src/workspace.js");
const { withLock } = await import("../src/lock.js");
type State = ReturnType<typeof createInitialState>;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);
const read = (p: string) => fs.readFileSync(p, "utf8");
const write = (p: string, s: string) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, s); };
const git = (d: string, ...args: string[]) => execFileSync("git", args, { cwd: d, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" }).toString().trim();
function repo(name: string, files: Record<string, string> = { "a.txt": "A\n" }) {
  const dir = join(root, name); fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
  for (const [p, s] of Object.entries(files)) write(join(dir, p), s);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "i");
  return dir;
}
function project(name: string) {
  const dir = join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "package.json"), "{}\n"); fs.writeFileSync(join(dir, "a.txt"), "A\n");
  return dir;
}
async function open(dir: string, sessionId = "review-fixes") {
  const state = createInitialState(); state.sessionId = sessionId;
  beginWorkspace(state, dir); assert.ok(await waitReady(state), state.readyError ?? "not ready");
  return state;
}
async function cp(state: State, id: string) {
  const point = await ensureCheckpoint(state, id, id, Date.now()); assert.ok(point, state.lastGap ?? "no checkpoint");
  state.currentEntryId = id; return point;
}
/** A mock command host that walks the /rewind → prompt → "Restore code only" flow. */
function host(state: State, opts: { onConfirm?: (title: string) => boolean | void; idle?: () => boolean; prompts?: any[] } = {}) {
  const user = { id: state.currentEntryId ?? "u1", type: "message", message: { role: "user", content: "fixture prompt", timestamp: Date.now() } };
  const confirmations: string[] = []; const notices: { message: string; level: string }[] = [];
  const ctx = {
    hasUI: true, isIdle: opts.idle ?? (() => true),
    sessionManager: { getBranch: () => opts.prompts ?? [user], getEntry: (id: string) => (opts.prompts ?? [user]).find((e: any) => e.id === id) },
    ui: {
      select: async (title: string, options: string[]) => title === "Rewind to prompt:" ? options.find((o) => o.includes("fixture prompt")) : "Restore code only",
      confirm: async (title: string) => { confirmations.push(title); return opts.onConfirm?.(title) ?? true; },
      notify: (message: string, level: string) => notices.push({ message, level }),
    },
  };
  return { ctx, confirmations, notices };
}

test("F2: type-change consent is bound to the previewed items", async () => {
  const dir = repo("consent-type", { ".gitignore": "*.ignored\n", a: "A target\n", b: "B target\n" });
  const state = await open(dir); await cp(state, "u1");
  fs.rmSync(join(dir, "a")); write(join(dir, "a", "old"), "old\n"); write(join(dir, "b"), "B current\n");
  const h = host(state, {
    onConfirm: (title) => {
      // While the "Replace them too?" dialog for `a` is open, `b` becomes a directory holding uncaptured data.
      if (title.startsWith("1 path(s) changed type")) { fs.rmSync(join(dir, "b")); write(join(dir, "b", "precious.ignored"), "not snapshotted\n"); }
    },
  });
  await runRewindFlow(state, h.ctx);
  assert.ok(h.confirmations.some((t) => t.includes("  a   directory")), "the dialog listed a");
  assert.ok(fs.existsSync(join(dir, "b", "precious.ignored")), "b's unconfirmed replacement was skipped");
  assert.equal(fs.lstatSync(join(dir, "a")).isFile(), true, "a's confirmed replacement was applied");
  assert.match(h.notices.at(-1)!.message, /skipped/);
});

test("F2: outside consent is bound to the previewed items", async () => {
  const dir = project("consent-outside"); const state = await open(dir); const point = await cp(state, "u1");
  const a = join(root, "consent-a.txt"), b = join(root, "consent-b.txt");
  fs.writeFileSync(a, "a-target\n"); fs.writeFileSync(b, "b-target\n");
  state.outside!.touch(a, [point]); state.outside!.touch(b, [point]);
  fs.writeFileSync(a, "a-current\n");
  const h = host(state, { onConfirm: (title) => { if (title.includes("OUTSIDE this project")) fs.writeFileSync(b, "b-late\n"); } });
  await runRewindFlow(state, h.ctx);
  assert.equal(read(a), "a-target\n"); assert.equal(read(b), "b-late\n", "b was never shown, so it is not restored");
});

test("F1: /tree hook restores while the host reports non-idle for its own navigation", async () => {
  const dir = project("tree-idle"); const state = await open(dir); await cp(state, "u1");
  fs.writeFileSync(join(dir, "a.txt"), "B\n");
  const h = host(state, { idle: () => false }); // Pi's navigateTree sets a branch-summary controller before the hook.
  h.ctx.ui.select = async () => "Restore code only";
  assert.deepEqual(await handleTreeRestore(state, { preparation: { targetId: "u1" } }, h.ctx), { cancel: true });
  assert.equal(read(join(dir, "a.txt")), "A\n");
  assert.equal(state.hostNavigating, false);
  // Outside the hook, a non-idle host still blocks.
  fs.writeFileSync(join(dir, "a.txt"), "B\n");
  const slash = host(state, { idle: () => false }); await runRewindFlow(state, slash.ctx);
  assert.equal(read(join(dir, "a.txt")), "B\n"); assert.match(slash.notices.at(-1)!.message, /active response/);
});

test("F12: activity that begins during the probe or the lock wait stops the apply", async () => {
  const dir = project("activity"); const state = await open(dir); await cp(state, "u1");
  fs.writeFileSync(join(dir, "a.txt"), "B\n");
  let idle = true; let probes = 0;
  state.restoreBlocker = async () => { probes++; if (probes === 2) { await Promise.resolve(); idle = false; } return null; };
  const h = host(state, { idle: () => idle }); await runRewindFlow(state, h.ctx);
  assert.equal(read(join(dir, "a.txt")), "B\n", "the recheck after the async probe refused");
  idle = true; probes = 0; state.restoreBlocker = async () => (idle ? null : "background job running");
  const ws = state.ws! as any; const original = ws.applyFresh.bind(ws);
  ws.applyFresh = async (...args: any[]) => { idle = false; return original(...args); }; // Activity appears while queued for the lock.
  try {
    const late = host(state, { idle: () => true }); await runRewindFlow(state, late.ctx);
    assert.equal(read(join(dir, "a.txt")), "B\n", "the under-lock recheck refused before the first write");
    assert.match(late.notices.at(-1)!.message, /background job running/);
  } finally { ws.applyFresh = original; }
});

test("F3: a nested root replaced by a symlink is refused, not written through", async () => {
  const dir = repo("nested-symlink", { "root.txt": "root\n" }); const dep = join(dir, "dep"); repo("nested-symlink/dep", { "lib.txt": "TARGET\n" });
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "dep");
  const state = await open(dir); const point = await cp(state, "u1");
  write(join(dep, "lib.txt"), "CURRENT\n"); const plan = (await planRestore(state, point))!;
  assert.ok(plan.items.some((i) => i.display === "dep/lib.txt" && i.action === "restore"));
  const ext = join(root, "external-repo"); fs.renameSync(dep, ext); write(join(ext, "lib.txt"), "OUTSIDE PRECIOUS\n"); fs.symlinkSync(ext, dep);
  const result = (await applyPlan(state, plan))!;
  assert.equal(read(join(ext, "lib.txt")), "OUTSIDE PRECIOUS\n"); assert.equal(result.restored, 0);
  assert.ok(result.skipped.length || result.errors.length, "the redirected root is declared, not silently applied");
});

test("F4: a missing project target blob refuses every writer before publication", async () => {
  const dir = project("missing-blob"); const state = await open(dir); const point = await cp(state, "u1");
  fs.writeFileSync(join(dir, "a.txt"), "B\n"); assert.deepEqual((await applyPlan(state, (await planRestore(state, point))!))!.errors, []);
  fs.writeFileSync(join(dir, "new.txt"), "POST REWIND\n");
  const prepared = (await planUndo(state))!; const shadow = state.ws!.repos.get("")!;
  const entry = (await shadow.entryAt(state.undo!.snapshot[""], "a.txt"))!;
  fs.unlinkSync(join(shadow.gitDir, "objects", entry.sha.slice(0, 2), entry.sha.slice(2)));
  const result = (await applyUndo(state, prepared))!;
  assert.equal(result.restored + result.deleted, 0); assert.match(result.errors[0], /missing or corrupt/);
  assert.equal(read(join(dir, "new.txt")), "POST REWIND\n"); assert.equal(read(join(dir, "a.txt")), "A\n");
  assert.ok(state.undo, "the Undo destination is retained");
});

test("F6: an outside path that now resolves elsewhere carries no captured history", async () => {
  const dir = project("alias"); const state = await open(dir); const point = await cp(state, "u1");
  const a = join(root, "alias-a.txt"), b = join(root, "alias-b.txt"); fs.writeFileSync(a, "A ORIGINAL"); fs.writeFileSync(b, "B UNRELATED");
  await state.ws!.withStoreLock(() => { state.outside!.touch(a, [point]); persistLocalIndex(state); });
  fs.unlinkSync(a); fs.symlinkSync(b, a);
  const reload = await open(dir); const target = reload.checkpoints.get("u1")!;
  const plan = (await planRestore(reload, target))!;
  assert.ok(!plan.items.some((i) => i.path === b && i.action === "restore"));
  assert.ok([...reload.outside!.refused.values()].some((why) => /resolves|registry/.test(why)));
  assert.equal(read(b), "B UNRELATED");
});

test("F7: a permission error while capturing is not recorded as absence", async () => {
  if (process.getuid?.() === 0) return;
  const parent = join(root, "unreadable"); fs.mkdirSync(parent); const file = join(parent, "keep.txt"); fs.writeFileSync(file, "EXISTING");
  const out = new OutsideStore(join(root, "alias"), join(root, "permission-store"));
  const point: any = { entryId: "p", parentEntryId: null, prompt: "p", timestamp: 1, snapshot: {} };
  fs.chmodSync(parent, 0);
  try { assert.equal(out.touch(file, [point]), false); } finally { fs.chmodSync(parent, 0o700); }
  assert.equal(point.outside?.[file], undefined); assert.match(out.refused.get(file) ?? "", /EACCES|cannot stat/);
});

test("F16: credential-shaped names follow the documented globs", async () => {
  const cwd = join(root, "alias");
  for (const name of [".env", ".env.local", ".envrc", ".env-prod", "credentials", "credentials.csv", "credentials.backup", "id_rsa", "id_rsa-old", "server.pem"]) {
    assert.equal(checkTrackablePath(join(root, name), cwd).ok, false, name);
  }
  for (const name of ["identity.txt", "envelope.txt", "my-credentials-notes.md"]) assert.equal(checkTrackablePath(join(root, name), cwd).ok, true, name);
});

test("F8: a repo initialised over an indexed directory makes it unprotected", async () => {
  const dir = repo("new-nested", { base: "base\n" }); const state = await open(dir); const before = await cp(state, "before");
  write(join(dir, "dep", "file"), "NEW DATA\n"); await cp(state, "during");
  repo("new-nested/dep", {}); // git init + commit inside dep
  const plan = (await planRestore(state, before))!;
  assert.equal(plan.items.find((i) => i.display === "dep/file")?.action, "unprotected");
  assert.deepEqual((await applyPlan(state, plan))!.errors, []); assert.equal(read(join(dir, "dep", "file")), "NEW DATA\n");
});

test("F9: case-colliding target paths are refused, neither is written", async () => {
  const dir = project("target-case"); fs.writeFileSync(join(dir, "lower.txt"), "lower target\n");
  const state = await open(dir); if (!state.ws!.coverage.caseInsensitive) return;
  const point = await cp(state, "u1"); const shadow = state.ws!.repos.get("")!;
  const env = { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(root, "case.index") };
  const g = (args: string[], input?: string) => execFileSync("git", args, { cwd: dir, env, input, stdio: "pipe" }).toString().trim();
  g(["read-tree", point.snapshot[""]]); const blob = g(["hash-object", "-w", "--stdin"], "UPPER TARGET\n");
  g(["update-index", "--add", "--cacheinfo", `100644,${blob},LOWER.txt`]);
  const sha = g(["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", g(["write-tree"]), "-m", "historical case-sensitive checkpoint"]);
  fs.writeFileSync(join(dir, "lower.txt"), "CURRENT\n");
  const plan = (await planRestore(state, { ...point, snapshot: { "": sha } }))!;
  assert.ok(plan.items.length >= 1 && plan.items.every((i) => i.action === "unprotected" && /case collision/.test(i.reason ?? "")));
  await applyPlan(state, plan); assert.equal(read(join(dir, "lower.txt")), "CURRENT\n");
});

test("F10: hardlinked paths with different targets are refused together", async () => {
  const dir = repo("hardlinks", { a: "TARGET A\n", b: "TARGET B\n" }); const state = await open(dir); const point = await cp(state, "u1");
  fs.rmSync(join(dir, "b")); fs.linkSync(join(dir, "a"), join(dir, "b")); write(join(dir, "a"), "SHARED CURRENT\n");
  const plan = (await planRestore(state, point))!;
  assert.ok(["a", "b"].every((p) => plan.items.find((i) => i.display === p)?.action === "unprotected"));
  await applyPlan(state, plan); assert.equal(read(join(dir, "a")), "SHARED CURRENT\n");
});

test("F11: file → directory is a type change with its own confirmation", async () => {
  const dir = repo("file-to-dir", { "thing/child": "TARGET CHILD\n" }); const state = await open(dir); const point = await cp(state, "u1");
  fs.rmSync(join(dir, "thing"), { recursive: true }); write(join(dir, "thing"), "CURRENT FILE\n");
  const plan = (await planRestore(state, point))!;
  assert.equal(plan.items.find((i) => i.display === "thing")?.action, "type-change");
  const refused = (await applyPlan(state, plan))!;
  assert.equal(read(join(dir, "thing")), "CURRENT FILE\n"); assert.equal(refused.restored + refused.deleted, 0);
  assert.ok(refused.skipped.some((i) => i.display === "thing/child"), "the restores beneath are gated with it");
  const applied = (await applyPlan(state, (await planRestore(state, point))!, { includeTypeChanges: true }))!;
  assert.deepEqual(applied.errors, []); assert.equal(read(join(dir, "thing", "child")), "TARGET CHILD\n");
});

test("F14: prompts with identical labels stay distinguishable", async () => {
  const dir = project("labels"); const state = await open(dir); await cp(state, "u1"); await cp(state, "u2"); await cp(state, "u3");
  const same = (id: string, text = "fixture prompt") => ({ id, type: "message", message: { role: "user", content: text, timestamp: 1767268800000 } });
  const rows: string[] = []; let navigated = "";
  const ctx = {
    hasUI: true, isIdle: () => true, navigateTree: async (id: string) => { navigated = id; return { cancelled: false }; },
    sessionManager: { getBranch: () => [same("u1"), same("u2"), same("u3", "fixture prompt (2)")] },
    ui: { select: async (title: string, options: string[]) => { if (title === "Rewind to prompt:") { rows.push(...options); return options.at(-3)!; } return "Restore conversation only"; }, notify: () => {} },
  };
  await runRewindFlow(state, ctx);
  assert.equal(new Set(rows).size, rows.length, `labels are unique: ${rows.join(" | ")}`);
  assert.equal(navigated, "u2", "the chosen row navigates to its own prompt");
});

test("F23: coverage is reachable before the first prompt and names ignored gaps", async () => {
  const dir = project("coverage"); fs.mkdirSync(join(dir, "cache")); fs.writeFileSync(join(dir, "cache", "secret.txt"), "UNCAPTURED"); fs.writeFileSync(join(dir, ".gitignore"), "cache/\n");
  const state = await open(dir); const reports: string[] = [];
  const ctx = { hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: { select: async () => undefined, confirm: async (s: string) => { reports.push(s); return false; }, notify: () => {} } };
  await runRewindFlow(state, ctx); assert.equal(reports.length, 1, "no prompts yet still opens the report");
  await cp(state, "u1"); reports.length = 0;
  ctx.sessionManager.getBranch = () => [{ id: "u1", type: "message", message: { role: "user", content: "u1" } }] as any;
  ctx.ui.select = (async () => "· coverage report") as any;
  await runRewindFlow(state, ctx); assert.match(reports[0], /cache\//); assert.match(reports[0], /bash\/manual writes/);
});

test("F20: a checkpoint whose parent was collected recovers as a new root", async () => {
  const dir = project("missing-parent"); const ws = await Workspace.open(dir); await ws.prime();
  const old = await ws.snapshot(null, "old", [], { ref: { sessionId: "old", entryId: "e" } });
  await ws.pruneSession("old"); git(dir, "--git-dir", ws.repos.get("")!.gitDir, "gc", "--prune=now");
  const next = await ws.snapshot(old, "next", [], { ref: { sessionId: "new", entryId: "e" } });
  assert.ok(next[""]); assert.ok(ws.coverage.degradedParents.includes("project root"));
});

test("F21: shadows of deleted nested worktrees are pruned with their sessions", async () => {
  const dir = repo("orphan-nested", { "root.txt": "r\n" }); repo("orphan-nested/dep", { lib: "nested\n" }); git(dir, "add", "-A"); git(dir, "commit", "-qm", "dep");
  const ws = await Workspace.open(dir); await ws.prime(); await ws.snapshot(null, "old", [], { ref: { sessionId: "old", entryId: "e" } }); ws.releaseSession("old");
  const nestedGitDir = ws.repos.get("dep")!.gitDir; fs.rmSync(join(dir, "dep"), { recursive: true });
  const reopened = await Workspace.open(dir); await reopened.prime();
  await reopened.maintain({ maxSessions: 0, recentSessionGraceMs: 0 });
  assert.equal(git(dir, "--git-dir", nestedGitDir, "for-each-ref", "--format=%(refname)", "refs/pi/"), "");
});

test("F15: a queued projectless checkpoint cannot publish into a later session", async () => {
  const plain = join(root, "plain"), next = join(root, "next"); fs.mkdirSync(plain); fs.mkdirSync(next);
  const state = createInitialState(); state.sessionId = "old"; beginWorkspace(state, plain);
  const store = state.outside!.storeDir; fs.mkdirSync(store, { recursive: true });
  const acquired = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holder = withLock(join(store, "snapshot.lock"), async () => { acquired.resolve(); await release.promise; }); await acquired.promise;
  const pending = ensureCheckpoint(state, "old-user", "old prompt", 3).catch(() => null);
  resetState(state); state.sessionId = "new"; beginWorkspace(state, next); release.resolve(); await holder; await pending;
  assert.equal(state.checkpoints.has("old-user"), false);
});

test("F4: a blob whose payload is corrupt (header intact) is refused too", async () => {
  const dir = project("corrupt-blob"); const state = await open(dir); const point = await cp(state, "u1");
  fs.writeFileSync(join(dir, "a.txt"), "B\n"); assert.deepEqual((await applyPlan(state, (await planRestore(state, point))!))!.errors, []);
  const shadow = state.ws!.repos.get("")!; const entry = (await shadow.entryAt(state.undo!.snapshot[""], "a.txt"))!;
  const loose = join(shadow.gitDir, "objects", entry.sha.slice(0, 2), entry.sha.slice(2));
  // Re-encode a wrong body under the same header: `cat-file --batch-check` still says "blob 2".
  const { deflateSync } = await import("node:zlib");
  fs.chmodSync(loose, 0o644); fs.writeFileSync(loose, deflateSync(Buffer.from("blob 2\0X\n")));
  const result = (await applyUndo(state, (await planUndo(state))!))!;
  assert.equal(result.restored + result.deleted, 0); assert.match(result.errors[0], /missing or corrupt/); assert.equal(read(join(dir, "a.txt")), "A\n");
});

test("F8: a nested repo created where the checkpoint had a file is never replaced", async () => {
  const dir = repo("self-nested", { dep: "was a file\n" }); const state = await open(dir); const point = await cp(state, "u1");
  fs.rmSync(join(dir, "dep")); repo("self-nested/dep", { file: "inner\n" });
  // Either the guarded capture refuses (git cannot index through the new
  // repo) or the plan declares `dep` unprotected; it must never be a REPLACE.
  let plan; try { plan = await planRestore(state, point); } catch (error) { assert.match((error as Error).message, /incomplete/); }
  if (plan) {
    assert.ok(plan.items.every((i) => i.action !== "type-change"), JSON.stringify(plan.items));
    await applyPlan(state, plan, { includeTypeChanges: true });
  }
  assert.ok(fs.existsSync(join(dir, "dep", ".git")), "nested repository metadata survives");
  assert.equal(read(join(dir, "dep", "file")), "inner\n");
});

test("F10: an unchanged managed sibling sharing the inode blocks the in-place write", async () => {
  const dir = repo("hardlink-sibling", { a: "A\n", b: "B\n" }); const state = await open(dir); const point = await cp(state, "u1");
  fs.rmSync(join(dir, "b")); fs.linkSync(join(dir, "a"), join(dir, "b")); // both now read "A": only b differs from target
  const plan = (await planRestore(state, point))!;
  assert.equal(plan.items.find((i) => i.display === "b")?.action, "unprotected");
  await applyPlan(state, plan); assert.equal(read(join(dir, "a")), "A\n");
});

test("F6: a parent redirected after tracking is refused at capture time", async () => {
  const dir = project("redirect-parent"); const state = await open(dir); const point = await cp(state, "u1");
  const safe = join(root, "safe"); fs.mkdirSync(safe); const file = join(safe, "config"); fs.writeFileSync(file, "ok");
  state.outside!.touch(file, [point]);
  const elsewhere = join(root, "elsewhere"); fs.mkdirSync(elsewhere); fs.writeFileSync(join(elsewhere, "config"), "SHOULD NOT BE COPIED");
  fs.renameSync(safe, join(root, "safe-moved")); fs.symlinkSync(elsewhere, safe);
  const snap = state.outside!.snapshotTracked();
  assert.equal(snap[file], undefined); assert.match(state.outside!.refused.get(file) ?? "", /resolves/);
  const blobs = fs.existsSync(join(state.outside!.storeDir, "outside")) ? fs.readdirSync(join(state.outside!.storeDir, "outside"), { recursive: true }).map(String) : [];
  const { createHash } = await import("node:crypto");
  assert.ok(!blobs.some((b) => b.endsWith(createHash("sha256").update("SHOULD NOT BE COPIED").digest("hex"))));
});

test("F7: an unreadable current outside file is unprotected in the plan, not a no-op", async () => {
  if (process.getuid?.() === 0) return;
  const parent = join(root, "unreadable-plan"); fs.mkdirSync(parent); const file = join(parent, "keep.txt"); fs.writeFileSync(file, "EXISTING");
  const out = new OutsideStore(join(root, "alias"), join(root, "plan-store"));
  fs.chmodSync(parent, 0);
  try {
    const items = out.plan({ [file]: { absent: true } });
    assert.equal(items[0]?.action, "unprotected", JSON.stringify(items));
  } finally { fs.chmodSync(parent, 0o700); }
});

test("F12: activity that begins during the locked capture is refused before publication", async () => {
  const dir = project("activity-locked"); const state = await open(dir); await cp(state, "u1"); fs.writeFileSync(join(dir, "a.txt"), "B\n");
  let busy = false; state.restoreBlocker = async () => (busy ? "background job running" : null);
  const ws = state.ws! as any; const original = ws.snapshotLocked.bind(ws);
  ws.snapshotLocked = async (...args: any[]) => { const r = await original(...args); busy = true; return r; };
  try {
    const h = host(state); await runRewindFlow(state, h.ctx);
    assert.equal(read(join(dir, "a.txt")), "B\n"); assert.match(h.notices.at(-1)!.message, /background job running/);
    assert.equal(state.recovery?.journal ?? null, null, "nothing was published");
  } finally { ws.snapshotLocked = original; }
});

test("F10: a hardlink across root and nested shadows is detected", async () => {
  const dir = repo("hardlink-cross", { a: "A\n" }); repo("hardlink-cross/dep", { b: "B\n" }); git(dir, "add", "-A"); git(dir, "commit", "-qm", "dep");
  const state = await open(dir); const point = await cp(state, "u1");
  fs.rmSync(join(dir, "dep", "b")); fs.linkSync(join(dir, "a"), join(dir, "dep", "b")); // dep/b now reads "A"; only it differs
  const plan = (await planRestore(state, point))!;
  assert.equal(plan.items.find((i) => i.display === "dep/b")?.action, "unprotected", JSON.stringify(plan.items));
  await applyPlan(state, plan); assert.equal(read(join(dir, "a")), "A\n");
});

test("F12: activity that begins during blob verification is refused before the journal", async () => {
  const dir = project("activity-verify"); const state = await open(dir); await cp(state, "u1"); fs.writeFileSync(join(dir, "a.txt"), "B\n");
  let busy = false; state.restoreBlocker = async () => (busy ? "background job running" : null);
  const ws = state.ws! as any; const original = ws.missingTargets.bind(ws);
  ws.missingTargets = async (...args: any[]) => { const r = await original(...args); busy = true; return r; };
  try {
    const h = host(state); await runRewindFlow(state, h.ctx);
    assert.equal(read(join(dir, "a.txt")), "B\n"); assert.match(h.notices.at(-1)!.message, /background job running/);
    assert.equal(state.recovery?.journal ?? null, null);
  } finally { ws.missingTargets = original; }
});

let failed = 0;
try {
  for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); }
  }
  console.log(`Review fixes: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
}
