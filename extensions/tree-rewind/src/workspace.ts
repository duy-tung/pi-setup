import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { targetTrackedFiles } from "./git.js";
import { withLock } from "./lock.js";
import { markOrigin } from "./reaper.js";
import { ShadowRepo, type DiffRecord } from "./shadow.js";
import {
  MAX_NESTED_REPOS,
  OUTSIDE,
  ROOT,
  type ApplyResult,
  type Coverage,
  type PlanItem,
  type RestorePlan,
  type WorkspaceSnapshot,
} from "./types.js";

type Kind = "file" | "symlink" | "gitlink" | "absent";

function kindOfMode(mode: string): Kind {
  if (mode === "000000") return "absent";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return "file";
}

function kindOnDisk(abs: string): Kind | "dir" | "absent" {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "file";
  } catch {
    return "absent";
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Materialize the promised replacement before moving the current path aside.
 * If installation fails, the original is renamed back; a confirmed directory
 * replacement can therefore never become deletion-without-replacement. */
async function applyTypeChange(repo: ShadowRepo, item: PlanItem, result: ApplyResult): Promise<void> {
  const abs = join(repo.worktree, item.path);
  if (!parentsAreReal(repo.worktree, item.path)) {
    result.errors.push(`replace ${item.display}: parent is no longer a real directory, skipped`);
    return;
  }

  if (!item.targetSha) {
    try {
      rmSync(abs, { recursive: true, force: true });
      result.deleted++;
    } catch (error) {
      result.errors.push(`delete ${item.display}: ${(error as Error).message}`);
    }
    return;
  }

  const targetKind = kindOfMode(item.targetMode ?? "000000");
  if (targetKind !== "file" && targetKind !== "symlink") {
    result.errors.push(`replace ${item.display}: unsupported target type ${targetKind}`);
    return;
  }
  const content = await repo.catBlob(item.targetSha);
  if (!content) {
    result.errors.push(`replace ${item.display}: missing target blob; original left untouched`);
    return;
  }

  const parent = dirname(abs);
  const stem = `.${basename(abs)}.pi-rewind-${randomUUID()}`;
  const prepared = join(parent, `${stem}.new`);
  const backup = join(parent, `${stem}.old`);
  let movedOriginal = false;
  try {
    mkdirSync(parent, { recursive: true });
    if (!parentsAreReal(repo.worktree, item.path)) throw new Error("parent is no longer a real directory");
    if (targetKind === "symlink") {
      symlinkSync(content.toString("utf8"), prepared);
    } else {
      writeFileSync(prepared, content, { flag: "wx", mode: parseInt(item.targetMode ?? "100644", 8) & 0o777 });
      chmodSync(prepared, parseInt(item.targetMode ?? "100644", 8) & 0o777);
    }
    if (kindOnDisk(abs) !== "absent") {
      renameSync(abs, backup);
      movedOriginal = true;
    }
    try {
      renameSync(prepared, abs);
    } catch (error) {
      if (movedOriginal && kindOnDisk(abs) === "absent") renameSync(backup, abs);
      throw error;
    }
    result.restored++;
    if (movedOriginal) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        result.errors.push(`replace ${item.display}: replacement installed but old backup remains at ${backup}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    result.errors.push(`replace ${item.display}: ${(error as Error).message}`);
  } finally {
    rmSync(prepared, { recursive: true, force: true });
  }
}

/** Prime is background work: it should wait out another session's cold prime
 *  (42s measured on the linux kernel) rather than hit the default 30s lock
 *  timeout and turn rewind off for the whole session. */
const PRIME_LOCK_TIMEOUT_MS = 10 * 60_000;

/** Where everything about one project lives: shadow repos, the lock, and the
 *  blobs for files outside it. Derivable without opening the workspace, so the
 *  outside store can exist before the cold prime finishes. */
export function storeDirFor(cwd: string): string {
  return join(homedir(), ".pi", "agent", "rewind", hash(cwd));
}

function countFiles(dir: string, cap = 1000): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    let ents;
    try {
      ents = readdirSync(stack.pop()!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(join(e.parentPath ?? dir, e.name));
      else n++;
    }
  }
  return n;
}

/**
 * The project worktree as a set of shadow repos: the root, plus one per nested
 * git repo. Git hard-refuses to stage a file that lives inside a nested repo
 * (`fatal: Pathspec ... is in submodule`), so recursion is the only way to
 * checkpoint their contents at all — see spike/DECISIONS.md §2.
 */
export class Workspace {
  readonly repos = new Map<string, ShadowRepo>();
  readonly coverage: Coverage = {
    unrepresentable: [],
    skippedNested: [],
    defaultExcluded: [],
    caseInsensitive: false,
    nestedCount: 0,
  };

  readonly cwd: string;
  readonly storeDir: string;
  private unrepresentable = new Set<string>();
  private lockPath: string;

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.storeDir = storeDirFor(cwd);
    this.lockPath = join(this.storeDir, "snapshot.lock");
  }

  static async open(cwd: string): Promise<Workspace> {
    const real = (() => {
      try {
        return realpathSync(cwd);
      } catch {
        return cwd;
      }
    })();
    const ws = new Workspace(real);
    mkdirSync(ws.storeDir, { recursive: true });
    // The store is named by a hash, so without this nothing on disk says which
    // project it belongs to — and the reaper cannot tell an abandoned store
    // from a live one it simply has not seen this session.
    markOrigin(ws.storeDir, real);
    const root = new ShadowRepo(real, ws.storeDir, "root");
    ws.repos.set(ROOT, root);
    return ws;
  }

  /**
   * Cold path. Stages the root, discovers nested repos, and measures what the
   * filesystem cannot represent. Everything here is safe to run in the
   * background while the model is thinking.
   */
  async prime(): Promise<void> {
    await withLock(
      this.lockPath,
      async () => {
        const root = this.repos.get(ROOT)!;
        // init mutates the shared shadow config/index, so it belongs under the
        // same lock as every later stage/snapshot/apply operation.
        await root.init();
        // Reported from the root only: nested repos are git repos by definition,
        // so they always govern their own ignores and never seed defaults.
        this.coverage.defaultExcluded = [...root.defaultExcludes];
        await root.stage([], { reseed: true });
        this.coverage.caseInsensitive = probeCaseInsensitive(this.cwd);
        await this.discoverNested(root, ROOT, 0);
        await this.scanUnrepresentable();
      },
      { timeoutMs: PRIME_LOCK_TIMEOUT_MS },
    );
  }

  private async discoverNested(parent: ShadowRepo, prefix: string, depth: number): Promise<void> {
    if (depth > 4) {
      for (const sub of await parent.gitlinks()) {
        const display = prefix ? `${prefix}/${sub}` : sub;
        if (!this.coverage.skippedNested.includes(display)) this.coverage.skippedNested.push(display);
      }
      return;
    }
    for (const sub of await parent.gitlinks()) {
      const display = prefix ? `${prefix}/${sub}` : sub;
      if (this.repos.has(display)) continue;
      if (this.repos.size > MAX_NESTED_REPOS) {
        this.coverage.skippedNested.push(display);
        continue;
      }
      const abs = join(this.cwd, display);
      if (!existsSync(abs)) {
        this.coverage.skippedNested.push(display);
        continue;
      }
      const repo = new ShadowRepo(abs, this.storeDir, `n-${hash(display)}`);
      await repo.init();
      await repo.stage([], { reseed: true });
      this.repos.set(display, repo);
      this.coverage.nestedCount++;
      await this.discoverNested(repo, display, depth + 1);
    }
  }

  /**
   * Two paths differing only in case are one file on a case-insensitive
   * filesystem, so one of them can never be captured and restoring either
   * silently overwrites the other. Declare them instead of guessing.
   */
  private async scanUnrepresentable(): Promise<void> {
    if (!this.coverage.caseInsensitive) return;
    for (const [sub, repo] of this.repos) {
      const tracked = (await targetTrackedFiles(repo.worktree)) ?? (await repo.trackedPaths());
      const byLower = new Map<string, string[]>();
      for (const p of tracked) {
        const k = p.toLowerCase();
        byLower.set(k, (byLower.get(k) ?? []).concat(p));
      }
      for (const group of byLower.values()) {
        if (group.length < 2) continue;
        for (const p of group) this.unrepresentable.add(sub ? `${sub}/${p}` : p);
      }
    }
    this.coverage.unrepresentable = [...this.unrepresentable];
  }

  /** Which shadow repo owns a path relative to the project root. */
  owner(display: string): { repo: string; path: string } {
    let best = ROOT;
    for (const sub of this.repos.keys()) {
      if (!sub) continue;
      if (display === sub || display.startsWith(`${sub}/`)) {
        if (sub.length > best.length) best = sub;
      }
    }
    return { repo: best, path: best ? display.slice(best.length + 1) : display };
  }

  private async snapshotLocked(
    parent: WorkspaceSnapshot | null,
    message: string,
    forceTrack: Iterable<string>,
    ref?: { sessionId: string; entryId: string },
  ): Promise<WorkspaceSnapshot> {
    const byRepo = new Map<string, string[]>();
    for (const display of forceTrack) {
      const { repo, path } = this.owner(display);
      byRepo.set(repo, (byRepo.get(repo) ?? []).concat(path));
    }
    const out: WorkspaceSnapshot = {};
    for (const [sub, repo] of this.repos) {
      const parentCommit = parent?.[sub];
      out[sub] = await repo.commit(parentCommit ? [parentCommit] : [], message, byRepo.get(sub) ?? []);
      // The ref is written inside the lock: a commit that sits unreferenced for
      // even a moment can be pruned by another session's maintenance.
      if (ref) await repo.setRef(`refs/pi/${ref.sessionId}/${ref.entryId}`, out[sub]);
    }
    await this.declareNewGitlinks(parent?.[ROOT], out[ROOT]);
    return out;
  }

  /** Commit every repo, threading each one's parent so the shadow DAG mirrors
   *  the session tree. Throws rather than returning a partial snapshot. */
  async snapshot(
    parent: WorkspaceSnapshot | null,
    message: string,
    forceTrack: Iterable<string> = [],
    opts: { ref?: { sessionId: string; entryId: string }; lockTimeoutMs?: number } = {},
  ): Promise<WorkspaceSnapshot> {
    return withLock(
      this.lockPath,
      () => this.snapshotLocked(parent, message, forceTrack, opts.ref),
      opts.lockTimeoutMs == null ? {} : { timeoutMs: opts.lockTimeoutMs },
    );
  }

  async setSnapshotRef(snapshot: WorkspaceSnapshot, sessionId: string, entryId: string): Promise<void> {
    await withLock(this.lockPath, async () => {
      for (const [sub, commit] of Object.entries(snapshot)) {
        const repo = this.repos.get(sub);
        if (!repo) throw new Error(`snapshot repo is no longer available: ${sub || "root"}`);
        await repo.setRef(`refs/pi/${sessionId}/${entryId}`, commit);
      }
    });
  }

  private async replaceSnapshotRefLocked(
    snapshot: WorkspaceSnapshot,
    previous: WorkspaceSnapshot | undefined,
    sessionId: string,
    entryId: string,
  ): Promise<void> {
    const updated: string[] = [];
    try {
      for (const [sub, commit] of Object.entries(snapshot)) {
        const repo = this.repos.get(sub);
        if (!repo) throw new Error(`snapshot repo is no longer available: ${sub || "root"}`);
        await repo.setRef(`refs/pi/${sessionId}/${entryId}`, commit);
        updated.push(sub);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const sub of updated.reverse()) {
        const repo = this.repos.get(sub);
        if (!repo) {
          rollbackErrors.push(`${sub || "root"}: repo disappeared`);
          continue;
        }
        try {
          const old = previous?.[sub];
          if (old) await repo.setRef(`refs/pi/${sessionId}/${entryId}`, old);
          else await repo.deleteRef(`refs/pi/${sessionId}/${entryId}`);
        } catch (rollbackError) {
          rollbackErrors.push(`${sub || "root"}: ${(rollbackError as Error).message}`);
        }
      }
      if (rollbackErrors.length) {
        throw new Error(`snapshot ref publication failed and rollback was incomplete (${rollbackErrors.join("; ")}): ${(error as Error).message}`);
      }
      throw error;
    }
  }

  /** Replace a multi-repo ref as one logical publication. Git cannot transact
   * across repositories, so any partial update is rolled back. */
  async replaceSnapshotRef(
    snapshot: WorkspaceSnapshot,
    previous: WorkspaceSnapshot | undefined,
    sessionId: string,
    entryId: string,
  ): Promise<void> {
    await withLock(this.lockPath, () => this.replaceSnapshotRefLocked(snapshot, previous, sessionId, entryId));
  }

  async deleteSnapshotRef(sessionId: string, entryId: string): Promise<void> {
    await withLock(this.lockPath, async () => {
      for (const repo of this.repos.values()) await repo.deleteRef(`refs/pi/${sessionId}/${entryId}`);
    });
  }

  /** Nested repos created after prime (the agent ran `git clone` / `git init`)
   *  would otherwise be silent non-coverage: the root commit records only a
   *  gitlink and nothing ever says so. O(changed) via the root diff. */
  private async declareNewGitlinks(parentSha: string | undefined, sha: string): Promise<void> {
    if (!parentSha || parentSha === sha) return;
    const root = this.repos.get(ROOT)!;
    for (const rec of await root.diff(parentSha, sha)) {
      if (rec.dstMode !== "160000") continue;
      if (this.repos.has(rec.path) || this.coverage.skippedNested.includes(rec.path)) continue;
      this.coverage.skippedNested.push(rec.path);
    }
  }

  async setRefs(snapshot: WorkspaceSnapshot, sessionId: string, entryId: string): Promise<void> {
    for (const [sub, sha] of Object.entries(snapshot)) {
      await this.repos.get(sub)?.setRef(`refs/pi/${sessionId}/${entryId}`, sha);
    }
  }

  async hasSnapshot(snapshot: WorkspaceSnapshot): Promise<boolean> {
    // An empty snapshot must never look resolvable: `every` over no entries is
    // true, which is how failed snapshots used to pass as valid checkpoints.
    if (!snapshot || !snapshot[ROOT]) return false;
    for (const [sub, sha] of Object.entries(snapshot)) {
      const repo = this.repos.get(sub);
      // A nested repo can have been deleted since the checkpoint. Keep the
      // still-valid root/rest of the tuple restorable and declare that nested
      // component unprotected in buildPlan rather than rejecting everything.
      if (!repo) {
        if (sub === ROOT) return false;
        continue;
      }
      if (!(await repo.hasCommit(sha))) return false;
    }
    return true;
  }

  async buildPlan(from: WorkspaceSnapshot, to: WorkspaceSnapshot): Promise<RestorePlan> {
    const items: PlanItem[] = [];

    for (const [sub, repo] of this.repos) {
      const a = from[sub];
      const b = to[sub];
      if (!b) {
        if (sub) items.push(unprotectedItem(sub, sub, "nested repo has no checkpoint at this point"));
        continue;
      }
      if (!a) continue;
      for (const rec of await repo.diff(a, b)) {
        const item = this.classify(sub, rec);
        if (item) items.push(item);
      }
    }

    for (const sub of Object.keys(to)) {
      if (sub && !this.repos.has(sub)) {
        items.push(unprotectedItem(sub, sub, "nested repo from checkpoint is no longer present"));
      }
    }

    const declared = new Set(items.filter((i) => i.action === "unprotected").map((i) => i.display));
    for (const sub of this.coverage.skippedNested) {
      if (!declared.has(sub)) items.push(unprotectedItem(sub, sub, "nested repo not checkpointed"));
    }

    return { items: subsumeUnderTypeChanges(items), from, to };
  }

  private classify(sub: string, rec: DiffRecord): PlanItem | null {
    const display = sub ? `${sub}/${rec.path}` : rec.path;

    // A gitlink diff at the parent level is not ours to apply. If the nested
    // repo has its own shadow, its plan covers the contents; if not (created
    // mid-session, or over the cap), that is real non-coverage and must appear
    // in the preview rather than vanish.
    if (rec.srcMode === "160000" || rec.dstMode === "160000") {
      if (this.repos.has(display)) return null;
      return unprotectedItem(sub, display, "nested repo not checkpointed");
    }

    if (this.unrepresentable.has(display)) {
      return unprotectedItem(sub, display, "case collision on this filesystem");
    }

    const srcKind = kindOfMode(rec.srcMode);
    const dstKind = kindOfMode(rec.dstMode);
    const abs = join(this.cwd, display);
    const disk = kindOnDisk(abs);

    if (dstKind === "absent") {
      if (disk === "dir") {
        return {
          repo: sub,
          path: rec.path,
          display,
          action: "type-change",
          reason: "target says absent, disk holds a directory",
        };
      }
      return { repo: sub, path: rec.path, display, action: "delete" };
    }

    // `checkout-index -f` will silently rm -rf a directory to put a file in
    // its place — verified, spike/DECISIONS.md §4. Never let that be implicit.
    if (disk === "dir") {
      const n = countFiles(abs);
      return {
        repo: sub,
        path: rec.path,
        display,
        action: "type-change",
        targetSha: rec.dstSha,
        targetMode: rec.dstMode,
        reason: `directory with ${n >= 1000 ? "1000+" : n} file(s) → ${dstKind}`,
      };
    }

    if (disk !== "absent" && disk !== dstKind) {
      return {
        repo: sub,
        path: rec.path,
        display,
        action: "type-change",
        targetSha: rec.dstSha,
        targetMode: rec.dstMode,
        reason: `${disk} → ${dstKind}`,
      };
    }

    if (srcKind !== "absent" && srcKind !== dstKind) {
      return {
        repo: sub,
        path: rec.path,
        display,
        action: "type-change",
        targetSha: rec.dstSha,
        targetMode: rec.dstMode,
        reason: `${srcKind} → ${dstKind}`,
      };
    }

    // Rewriting a hardlinked file through git gives it a new inode, orphaning
    // its siblings with stale content. Write in place to preserve the inode.
    let writer: PlanItem["writer"] = "checkout";
    if (dstKind === "file") {
      try {
        if (lstatSync(abs).nlink > 1) writer = "in-place";
      } catch {
        /* absent: checkout will create it */
      }
    }

    return {
      repo: sub,
      path: rec.path,
      display,
      action: "restore",
      writer,
      targetSha: rec.dstSha,
      targetMode: rec.dstMode,
    };
  }

  async withStoreLock<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    return withLock(this.lockPath, async () => fn(), timeoutMs == null ? {} : { timeoutMs });
  }

  /** Re-snapshot and re-plan inside the same lock that performs the writes.
   * This closes the confirmation window: same-type edits made while the dialog
   * is open become the exact undo point rather than being overwritten unseen. */
  async applyFresh(
    parent: WorkspaceSnapshot | null,
    target: WorkspaceSnapshot,
    forceTrack: Iterable<string>,
    opts: { includeTypeChanges?: boolean },
    refs: { sessionId?: string; pendingEntry: string; previousUndo?: WorkspaceSnapshot; publishEntry?: string; keepPending?: boolean },
    decorate: (worktreePlan: RestorePlan, now: WorkspaceSnapshot) => RestorePlan,
    shouldApply: (plan: RestorePlan) => boolean,
    onUndo: (now: WorkspaceSnapshot, plan: RestorePlan) => void,
    whileLocked?: (result: ApplyResult, plan: RestorePlan) => void,
  ): Promise<{ plan: RestorePlan; result: ApplyResult; applied: boolean; undoSnapshot: WorkspaceSnapshot }> {
    return withLock(this.lockPath, async () => {
      const ref = refs.sessionId ? { sessionId: refs.sessionId, entryId: refs.pendingEntry } : undefined;
      const now = await this.snapshotLocked(parent, "pre-apply", forceTrack, ref);
      const plan = decorate(await this.buildPlan(now, target), now);
      if (!shouldApply(plan)) {
        if (refs.sessionId && !refs.keepPending) {
          for (const repo of this.repos.values()) await repo.deleteRef(`refs/pi/${refs.sessionId}/${refs.pendingEntry}`).catch(() => {});
        }
        return {
          plan,
          result: { restored: 0, deleted: 0, skipped: [...plan.items], errors: [] },
          applied: false,
          undoSnapshot: now,
        };
      }
      if (refs.sessionId && refs.publishEntry) {
        await this.replaceSnapshotRefLocked(now, refs.previousUndo, refs.sessionId, refs.publishEntry);
      }
      onUndo(now, plan);
      const result = await this.applyLocked(
        { ...plan, items: plan.items.filter((item) => item.repo !== OUTSIDE) },
        opts,
      );
      whileLocked?.(result, plan);
      if (refs.sessionId && !refs.keepPending) {
        for (const repo of this.repos.values()) await repo.deleteRef(`refs/pi/${refs.sessionId}/${refs.pendingEntry}`).catch(() => {});
      }
      return { plan, result, applied: true, undoSnapshot: now };
    });
  }

  async apply(
    plan: RestorePlan,
    opts: { includeTypeChanges?: boolean } = {},
    whileLocked?: (result: ApplyResult) => void,
  ): Promise<ApplyResult> {
    // Under the same lock as prime/snapshot. An unlocked apply interleaving
    // with another session's snapshot rewrote the shared index between
    // read-tree and checkout-index, and the "restore" silently wrote back the
    // *current* content while reporting success (reproduced).
    return withLock(this.lockPath, async () => {
      const result = await this.applyLocked(plan, opts);
      whileLocked?.(result);
      return result;
    });
  }

  private async applyLocked(plan: RestorePlan, opts: { includeTypeChanges?: boolean }): Promise<ApplyResult> {
    const result: ApplyResult = { restored: 0, deleted: 0, skipped: [], errors: [] };
    const byRepo = new Map<string, PlanItem[]>();

    for (const item of plan.items) {
      if (item.action === "unprotected") {
        result.skipped.push(item);
        continue;
      }
      if (item.action === "type-change" && !opts.includeTypeChanges) {
        result.skipped.push(item);
        continue;
      }
      byRepo.set(item.repo, (byRepo.get(item.repo) ?? []).concat(item));
    }

    for (const [sub, items] of byRepo) {
      const repo = this.repos.get(sub);
      const commit = plan.to[sub];
      if (!repo || !commit) {
        result.skipped.push(...items);
        continue;
      }

      const deletions = items.filter((i) => i.action === "delete");
      const inPlace = items.filter((i) => i.action === "restore" && i.writer === "in-place");
      const viaGit = items.filter((i) => i.action === "restore" && i.writer !== "in-place");

      for (const item of deletions) {
        const abs = join(repo.worktree, item.path);
        // TOCTOU guard: the disk may have changed between plan and apply (a
        // confirm dialog left open, another session). Node's rmSync follows a
        // symlinked parent straight out of the worktree — reproduced deleting
        // a file outside the project. git's own writers are immune; ours must
        // re-check.
        if (!parentsAreReal(repo.worktree, item.path)) {
          result.errors.push(`delete ${item.display}: parent is no longer a real directory, skipped`);
          continue;
        }
        if (kindOnDisk(abs) === "dir") {
          result.errors.push(`delete ${item.display}: a directory appeared here since the plan, skipped`);
          continue;
        }
        try {
          rmSync(abs, { force: true });
          pruneEmptyDirs(dirname(abs), repo.worktree);
          result.deleted++;
        } catch (err) {
          result.errors.push(`delete ${item.display}: ${(err as Error).message}`);
        }
      }

      // Explicitly confirmed type changes are materialized beside the current
      // path first, then atomically swapped in with rollback to the old path on
      // install failure. Never delete a directory and merely hope checkout can
      // produce the promised replacement afterward.
      for (const item of items.filter((i) => i.action === "type-change")) {
        await applyTypeChange(repo, item, result);
      }

      if (viaGit.length) {
        const safe: PlanItem[] = [];
        for (const item of viaGit) {
          const targetKind = kindOfMode(item.targetMode ?? "000000");
          const disk = kindOnDisk(join(repo.worktree, item.path));
          // The confirmation may sit open while another process changes the
          // path. checkout-index -f recursively deletes a directory to install
          // a file, so reclassify immediately before Git gets the path.
          if (!parentsAreReal(repo.worktree, item.path) || (disk !== "absent" && disk !== targetKind)) {
            result.errors.push(`checkout ${item.display}: disk type changed since preview (${disk} → ${targetKind}), skipped`);
            continue;
          }
          safe.push(item);
        }
        const r = await repo.checkoutPaths(commit, safe.map((i) => i.path));
        result.restored += r.ok;
        if (r.failed.length) {
          result.errors.push(`checkout failed in ${sub || "root"} for ${r.failed.length} path(s)`);
        }
      }

      for (const item of inPlace) {
        if (!item.targetSha) continue;
        const abs = join(repo.worktree, item.path);
        const kind = kindOnDisk(abs);
        // writeFileSync follows symlinks (parent or leaf); re-check the shape
        // the plan was built against before writing through anything.
        if (!parentsAreReal(repo.worktree, item.path) || kind === "symlink" || kind === "dir") {
          result.errors.push(`write ${item.display}: disk changed since the plan, skipped`);
          continue;
        }
        const buf = await repo.catBlob(item.targetSha);
        if (!buf) {
          result.errors.push(`missing blob for ${item.display}`);
          continue;
        }
        try {
          // Truncate-in-place: same inode, so every hardlink sees the change.
          // chmod applies to the shared inode too, restoring the checkpointed
          // executable bits for every sibling rather than reporting a lie.
          writeFileSync(join(repo.worktree, item.path), buf);
          if (item.targetMode) chmodSync(abs, parseInt(item.targetMode, 8) & 0o777);
          result.restored++;
        } catch (err) {
          result.errors.push(`write ${item.display}: ${(err as Error).message}`);
        }
      }
    }

    return result;
  }

  async pruneSession(sessionId: string): Promise<void> {
    for (const repo of this.repos.values()) await repo.deleteRefs(`refs/pi/${sessionId}`);
  }

  storeBytes(): number {
    return dirSize(this.storeDir);
  }

  /**
   * Drop checkpoints from sessions we no longer keep, then repack. Bounded by
   * both age and count so neither a long-lived project nor a burst of short
   * sessions can grow the store without limit.
   *
   * The repack keeps a grace window rather than pruning now — see `ShadowRepo.gc`
   * for why, and note it only bounds a store this session can reach. A store
   * whose project is gone is never reached from here at all; `reapStores`
   * covers that case.
   */
  async maintain(
    keep: { sessionId?: string; maxSessions?: number; maxAgeDays?: number; maxBytes?: number } = {},
  ): Promise<{ prunedSessions: string[]; packed: boolean; bytesBefore: number; bytesAfter: number }> {
    // Under the store lock: gc must never run while another session is mid-
    // snapshot or mid-apply — their objects are in flight and a concurrent
    // prune collected them (measured).
    return withLock(this.lockPath, () => this.maintainLocked(keep));
  }

  private async maintainLocked(
    keep: { sessionId?: string; maxSessions?: number; maxAgeDays?: number; maxBytes?: number },
  ): Promise<{ prunedSessions: string[]; packed: boolean; bytesBefore: number; bytesAfter: number }> {
    const maxSessions = keep.maxSessions ?? 20;
    const maxAgeDays = keep.maxAgeDays ?? 30;
    const maxBytes = keep.maxBytes ?? 2 * 1024 ** 3;
    const bytesBefore = this.storeBytes();

    const root = this.repos.get(ROOT)!;
    const sessions = [...(await root.sessionRefs())].sort((a, b) => b[1] - a[1]);
    const cutoff = Date.now() / 1000 - maxAgeDays * 86400;

    const prunedSessions: string[] = [];
    for (const [id, when] of sessions) {
      if (id === keep.sessionId) continue;
      const tooOld = when < cutoff;
      const tooMany = sessions.findIndex(([s]) => s === id) >= maxSessions;
      if (tooOld || tooMany) prunedSessions.push(id);
    }
    for (const id of prunedSessions) await this.pruneSession(id);

    const loose = await root.looseObjectCount();
    const packed = prunedSessions.length > 0 || loose > 5000 || bytesBefore > maxBytes;
    if (packed) for (const repo of this.repos.values()) await repo.gc();

    return { prunedSessions, packed, bytesBefore, bytesAfter: this.storeBytes() };
  }
}

/**
 * When a directory is going to be replaced wholesale, the deletions of the
 * files inside it are part of that one decision, not separate ones. Without
 * this, skipping an unconfirmed type change still lets the child deletions run
 * and destroys exactly the data the confirmation exists to protect.
 */
function subsumeUnderTypeChanges(items: PlanItem[]): PlanItem[] {
  const dirs = items
    .filter((i) => i.action === "type-change" && /directory with|holds a directory/.test(i.reason ?? ""))
    .map((i) => `${i.display}/`);
  if (!dirs.length) return items;
  return items.filter(
    (i) => !(i.action === "delete" && dirs.some((d) => i.display.startsWith(d))),
  );
}

/**
 * True only if every directory between the worktree root and `rel` is a real
 * directory on disk right now — no symlinked parent for rmSync/writeFileSync
 * to follow outside the worktree. Absent components are fine: nothing can be
 * traversed through them.
 */
function parentsAreReal(worktree: string, rel: string): boolean {
  const parts = rel.split("/");
  let cur = worktree;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return true;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}

function unprotectedItem(repo: string, display: string, reason: string): PlanItem {
  return { repo, path: display, display, action: "unprotected", reason };
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      if (readdirSync(cur).length > 0) return;
      rmSync(cur, { recursive: false });
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    let ents;
    try {
      ents = readdirSync(stack.pop()!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = join(e.parentPath ?? dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else
        try {
          total += lstatSync(p).size;
        } catch {
          /* vanished */
        }
    }
  }
  return total;
}

function probeCaseInsensitive(dir: string): boolean {
  const p = join(dir, `.piRewindCase_${process.pid}`);
  try {
    writeFileSync(p, "");
    const insensitive = existsSync(join(dir, `.pirewindcase_${process.pid}`));
    rmSync(p, { force: true });
    return insensitive;
  } catch {
    return false;
  }
}

export { relative, sep };
