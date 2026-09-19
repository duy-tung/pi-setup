import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrivateWriteError } from "./storage.js";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RewindState } from "./state.js";
import {
  CUSTOM_TYPE,
  OUTSIDE,
  type ApplyResult,
  type OperationSnapshot,
  type PlanItem,
  type PersistedIndex,
  type PromptCheckpoint,
  type RestorePlan,
  type WorkspaceSnapshot,
} from "./types.js";
import { Workspace, storeDirFor } from "./workspace.js";
import { checkEligible, resolveExisting } from "./eligibility.js";
import { OutsideStore } from "./outside.js";
import { withLock } from "./lock.js";
import { runBackend } from "./backend-lifetime.js";
import { outsideApproved, typeChangeApproved, type ApplyConsent } from "./plan.js";
import { readCheckpointState, saveCheckpointState, validCheckpoint, validProjectPath } from "./checkpoint-store.js";
import { assertRecoveryPreview, assertRecoveryReady, beginRestoreTransaction, finishRecoveryNoop, finishRestoreTransaction, loadRecoveryState, assertUndoTargetsAvailable, hasRequiredUndoItems, RestorePreflightError, type RestoreTransaction } from "./transactions.js";

/** Store paths relative to the project root; anything outside stays absolute
 *  and will simply never match a repo, so it is never touched. */
export function toRelPath(cwd: string, inputPath: string): string {
  const raw = isAbsolute(inputPath) ? inputPath : join(cwd, inputPath);
  const abs = resolveExisting(raw);
  const rel = relative(resolveExisting(cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs.split(sep).join("/");
  return rel.split(sep).join("/");
}

function projectMode(state: RewindState, rel: string): number | undefined {
  if (!validProjectPath(rel) || resolveExisting(join(state.cwd, rel)) !== join(resolveExisting(state.cwd), rel)) return undefined;
  try {
    const stat = lstatSync(join(state.cwd, rel));
    return stat.isFile() ? stat.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

function snapshotProjectModes(state: RewindState, paths: Iterable<string> = state.forceTrack): Record<string, number> {
  const modes: Record<string, number> = {};
  // Target-absent files still need their current private modes in the Undo.
  for (const rel of new Set([...state.forceTrack, ...paths])) {
    const mode = projectMode(state, rel);
    if (mode !== undefined) modes[rel] = mode;
  }
  return modes;
}

export function projectModeMapChangeCount(state: RewindState, modes: Record<string, number> | undefined): number {
  let count = 0;
  for (const [rel, mode] of Object.entries(modes ?? {})) {
    const current = projectMode(state, rel);
    if (current !== undefined && current !== mode) count += 1;
  }
  return count;
}

export function projectModeChangeCount(state: RewindState, cp: PromptCheckpoint): number {
  return projectModeMapChangeCount(state, cp.projectModes);
}

/** Restore non-Git permission bits only after content restoration succeeded. */
export function restoreProjectModeMap(state: RewindState, modes: Record<string, number> | undefined, result: ApplyResult): void {
  if (result.errors.length > 0) return;
  for (const [rel, mode] of Object.entries(modes ?? {})) {
    if (result.skipped.some(item => item.display === rel || rel.startsWith(`${item.display}/`))) continue;
    const current = projectMode(state, rel);
    if (current === undefined || current === mode) continue;
    try {
      chmodSync(join(state.cwd, rel), mode);
    } catch (error) {
      result.errors.push(`chmod ${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function restoreProjectModes(state: RewindState, cp: PromptCheckpoint, result: ApplyResult): void {
  restoreProjectModeMap(state, cp.projectModes, result);
}

/**
 * Put back what the checkpoints already know we were tracking.
 *
 * `loadIndex` runs first and fills `state.checkpoints`, so by the time a store
 * exists the paths are sitting right there in it. Without this the set is
 * rebuilt only by future `tool_call`s, and a file the agent edited before a
 * `/reload` drops out of every checkpoint taken after it.
 */
function adoptTracked(state: RewindState): void {
  for (const cp of state.checkpoints.values()) {
    for (const path of [...Object.keys(cp.projectModes ?? {}), ...(cp.projectAbsent ?? []), ...(cp.projectTouched ?? [])]) {
      if (validProjectPath(path)) state.forceTrack.add(path);
    }
  }
  if (!state.outside) return;
  const paths = new Set<string>();
  for (const cp of state.checkpoints.values()) {
    cp.outside = state.outside.sanitizeSnapshot(cp.outside);
    if (cp.after) cp.after.outside = state.outside.sanitizeSnapshot(cp.after.outside);
    for (const p of Object.keys(cp.outside ?? {})) paths.add(p);
  }
  if (paths.size) state.outside.adopt(paths);
}

/** Caller holds the shared store lock. Local metadata creates no Pi tree nodes. */
export function persistLocalIndex(state: RewindState): void {
  const store = state.outside;
  if (!store || !state.sessionId) return;
  state.checkpointRevision = saveCheckpointState(store.storeDir, store.cwd, state.sessionId, state.checkpoints.values(), state.checkpointRevision, state.indexRevision);
}

/** Awaited by tool_call, before a named write can lose its original contents. */
export async function captureProjectPreimage(state: RewindState, rel: string): Promise<void> {
  if (!validProjectPath(rel)) throw new Error("invalid project tool path");
  if (state.forceTrack.has(rel)) return;
  const gen = state.gen;
  const ws = await waitReady(state, READY_BUDGET_MS);
  if (gen !== state.gen) throw new Error("session changed during preimage capture");
  const cp = state.currentEntryId ? state.checkpoints.get(state.currentEntryId) : undefined;
  if (!ws || !cp) {
    // An already-declared cold-prime gap is not a checkpoint to backfill.
    state.forceTrack.add(rel);
    return;
  }
  const original = { snapshot: cp.snapshot, absent: cp.projectAbsent, touched: cp.projectTouched, modes: cp.projectModes };
  await ws.backfillFile(cp.snapshot, rel,
    state.sessionId ? { sessionId: state.sessionId, entryId: cp.entryId } : undefined,
    (snapshot, absent) => {
      if (gen !== state.gen) throw new Error("session changed during preimage capture");
      cp.snapshot = snapshot;
      cp.projectTouched = [...new Set([...(cp.projectTouched ?? []), rel])];
      if (absent) cp.projectAbsent = [...new Set([...(cp.projectAbsent ?? []), rel])];
      const mode = projectMode(state, rel);
      if (!absent && mode !== undefined && cp.projectModes?.[rel] === undefined) cp.projectModes = { ...cp.projectModes, [rel]: mode };
      try { persistLocalIndex(state); }
      catch (error) {
        cp.snapshot = original.snapshot;
        cp.projectAbsent = original.absent;
        cp.projectTouched = original.touched;
        cp.projectModes = original.modes;
        throw error;
      }
      if (state.head === original.snapshot) state.head = snapshot;
      state.forceTrack.add(rel);
      state.dirty = true;
    }, !cp.projectAbsent?.includes(rel) && isUnknownPath(cp.projectUnknown, rel));
}

function isUnknownPath(unknown: string[] | undefined, display: string): boolean {
  return (unknown ?? [""]).some(path => path === "" || path === display ||
    (path.endsWith("/") && (display === path.slice(0, -1) || display.startsWith(path))));
}

/** Target absence is only actionable when the checkpoint actually covered it. */
function protectUnknown(plan: RestorePlan, unknown: string[] | undefined, absent: string[] | undefined): RestorePlan {
  if (!unknown) return plan; // Raw Workspace plans retain their documented backend contract.
  const knownAbsent = new Set(absent ?? []);
  return {
    ...plan,
    projectUnknownTo: unknown,
    projectAbsentTo: absent,
    items: plan.items.map(item => {
      if (item.repo === OUTSIDE || item.targetSha || knownAbsent.has(item.display)) return item;
      if (item.action !== "delete" && item.action !== "type-change") return item;
      const uncovered = isUnknownPath(unknown, item.display);
      return uncovered ? { ...item, action: "unprotected" as const, reason: "original contents were not captured; absence is unknown" } : item;
    }),
  };
}

/** Opens the workspace and kicks the cold snapshot off in the background: it
 *  is 1.6s on a small repo and ~48s on the linux kernel, and the user is
 *  typing their first prompt while it runs. */
export function beginWorkspace(state: RewindState, cwd: string, openWorkspace: typeof Workspace.open = Workspace.open): void {
  if (state.lifetime.closed) return;
  state.cwd = cwd;

  // Decided before anything touches disk. `Workspace.open` already creates the
  // store directory and inits a shadow repo, so a check after it would leave
  // droppings in ~/.pi/agent/rewind for every directory pi was ever started in.
  const gate = checkEligible(cwd);
  const real = resolveExisting(cwd);
  if (state.sessionId) {
    try {
      const local = readCheckpointState(storeDirFor(real), real, state.sessionId);
      state.checkpointRevision = local.revision;
      for (const cp of local.checkpoints) {
        // At equal revisions the later JSONL flush may include outside touches.
        // A genuinely newer private revision covers crashes before turn_end.
        // Freshness is per object: after an incomplete public replay, an object
        // from an old base is repaired while one from a newer surviving batch stays.
        const published = state.indexObjectRevision.get(cp.entryId);
        if (published === undefined || local.revision > published || !state.checkpoints.has(cp.entryId)) state.checkpoints.set(cp.entryId, cp);
        else if (cp.after) state.checkpoints.get(cp.entryId)!.after = cp.after;
      }
    } catch (error) {
      state.readyError = `private checkpoint state unavailable: ${(error as Error).message}`;
      state.ready = Promise.resolve();
      return;
    }
  }

  if (!gate.ok) {
    state.disabled = gate.reason;
    state.readyError = gate.reason;
    state.ws = null;
    // Refusing to stage the directory is not a reason to protect nothing. The
    // files the agent *names* are still capturable one at a time, which is a
    // bounded promise this directory can keep: 64 paths, no `add -A`, no walk
    // into Library or .ssh.
    state.outside = new OutsideStore(real, storeDirFor(real), { projectless: true });
    adoptTracked(state);
    loadRecoveryState(state);
    state.ready = Promise.resolve();
    return;
  }

  // Created before the prime, not after it: `tool_call` can fire while the
  // cold snapshot is still running, and the pre-write content is only
  // capturable at that moment. Same store directory as the shadow repos, so
  // one project has one place on disk.
  state.outside = new OutsideStore(real, storeDirFor(real));
  adoptTracked(state);
  loadRecoveryState(state);

  // Generation guard: this closure keeps running after a /new session resets
  // the same state object. A 42s prime from the old session must not clobber
  // the new session's workspace (or its readyError) when it finally lands.
  const gen = state.gen;
  const sessionId = state.sessionId;
  const lifetime = state.lifetime;
  const primeAbort = new AbortController();
  state.primeAbort = primeAbort;
  state.ready = runBackend(lifetime, async () => {
    try {
      const ws = await openWorkspace(cwd, { lifetime, signal: primeAbort.signal });
      if (gen !== state.gen || lifetime.closed) return;
      await ws.prime();
      if (gen !== state.gen || lifetime.closed) return;
      await ws.withStoreLock(() => {
        if (gen !== state.gen || lifetime.closed) return;
        if (sessionId) ws.markSessionActive(sessionId);
        state.ws = ws; // Publish lease + workspace atomically under the lock.
      });
    } catch (err) {
      if (gen !== state.gen || lifetime.closed) return;
      state.readyError = err instanceof Error ? err.message : String(err);
      state.ws = null;
    } finally {
      if (state.primeAbort === primeAbort) state.primeAbort = null;
    }
  });
}

/**
 * Priming costs 42 s on the linux kernel. Blocking the first prompt for that
 * long is worse than declaring the prompt unprotected, so callers on the hot
 * path pass a budget; the rewind UI passes none and waits.
 */
export async function waitReady(state: RewindState, budgetMs?: number): Promise<Workspace | null> {
  const gen = state.gen;
  const ready = state.ready;
  const current = () => state.gen === gen && state.ready === ready && !state.lifetime?.closed;
  if (!current()) return null;
  if (!ready) return state.ws;
  if (budgetMs == null) {
    await ready;
    return current() ? state.ws : null;
  }
  let timer: NodeJS.Timeout | undefined;
  // Deliberately not unref'd: an unref'd timer lets the process exit before the
  // race settles, leaving the caller's await hanging forever.
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  const outcome = await Promise.race([ready.then(() => "ready" as const), timeout]);
  clearTimeout(timer);
  return outcome === "ready" && current() ? state.ws : null;
}

/** How long a prompt may wait for the cold snapshot before we give up and say
 *  so. Two seconds covers every repo we measured except the kernel. */
export const READY_BUDGET_MS = 2000;

/** How long a hot-path snapshot may wait on the store lock. Another session's
 *  cold prime can hold it for 40s+; stalling the agent that long is worse
 *  than one declared gap. */
export const SNAPSHOT_LOCK_BUDGET_MS = 5000;

/**
 * Record the worktree as it stands *before* the agent acts on this prompt,
 * bound to the user message id. The shadow commit's parent is whatever point
 * we last stood at, so the shadow DAG mirrors the path taken through the
 * session tree rather than a flat timeline.
 */
export async function ensureCheckpoint(
  state: RewindState,
  entryId: string,
  prompt: string,
  timestamp: number,
): Promise<PromptCheckpoint | null> {
  const existing = state.checkpoints.get(entryId);
  if (existing) return existing;
  const gen = state.gen;

  // Off by policy is not a gap: the status line already says so permanently, and
  // warning about it once per prompt would train the user to ignore the warning
  // that matters (a checkpoint that was supposed to happen and did not).
  if (state.disabled) return projectlessCheckpoint(state, entryId, prompt, timestamp);

  const ws = await waitReady(state, READY_BUDGET_MS);
  if (!ws) {
    state.lastGap = state.readyError
      ? `rewind unavailable: ${state.readyError}`
      : "still indexing — this prompt is not checkpointed";
    return null;
  }

  if (gen !== state.gen) return null;
  let checkpoint: PromptCheckpoint | null = null;
  let phase = "checkpoint";
  const validate = () => { if (gen !== state.gen) throw new Error("Session changed during checkpoint capture"); };
  try {
    // One transaction: closing must not cancel a second metadata acquisition
    // after an accepted snapshot has already published its protected Git ref.
    await ws.snapshotWithCoverage(state.head, `checkpoint ${entryId}`, state.forceTrack, {
      lockTimeoutMs: SNAPSHOT_LOCK_BUDGET_MS,
      ref: state.sessionId ? { sessionId: state.sessionId, entryId } : undefined,
      validate,
      publish: captured => {
        validate();
        phase = "checkpoint metadata";
        const cp: PromptCheckpoint = {
          entryId, parentEntryId: state.currentEntryId, prompt: prompt.slice(0, 200), timestamp,
          snapshot: captured.snapshot, outside: state.outside?.snapshotTracked() ?? {},
          projectModes: snapshotProjectModes(state), projectUnknown: captured.unknown,
          projectAbsent: captured.absent, projectTouched: [...state.forceTrack],
        };
        state.checkpoints.set(entryId, cp);
        try { persistLocalIndex(state); }
        catch (error) { state.checkpoints.delete(entryId); throw error; }
        state.head = cp.snapshot;
        state.dirty = true;
        state.lastGap = captured.unknown.includes("") ? "ignored coverage incomplete; ambiguous deletions will be skipped" : null;
        checkpoint = cp;
      },
    });
    return checkpoint;
  } catch (error) {
    if (gen === state.gen) state.lastGap = `${phase} failed: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

function outsideLock<T>(state: RewindState, operation: () => T | Promise<T>): Promise<T> {
  const store = state.outside;
  const generation = state.gen;
  if (!store) return Promise.reject(new Error("Outside store unavailable"));
  return withLock(join(store.storeDir, "snapshot.lock"), async () => {
    if (generation !== state.gen) throw new Error("Session changed before outside operation");
    return operation();
  }, { lifetime: state.lifetime });
}

/** A checkpoint with no worktree behind it: an empty shadow snapshot, and the
 *  edited-file store carrying the whole of the coverage. */
async function projectlessCheckpoint(
  state: RewindState,
  entryId: string,
  prompt: string,
  timestamp: number,
): Promise<PromptCheckpoint | null> {
  if (!state.outside) return null;
  mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
  return outsideLock(state, async () => {
    const cp: PromptCheckpoint = {
      entryId,
      parentEntryId: state.currentEntryId,
      prompt: prompt.slice(0, 200),
      timestamp,
      snapshot: {},
      outside: state.outside?.snapshotTracked() ?? {},
    };
    state.checkpoints.set(entryId, cp);
    try { persistLocalIndex(state); }
    catch (error) { state.checkpoints.delete(entryId); throw error; }
    state.dirty = true;
    return cp;
  });
}

/** Observe the operation's exit without moving its before-prompt target/head.
 * Metadata is private: no additional appendEntry or visible tree node. */
export async function captureOperationAfter(state: RewindState): Promise<boolean> {
  if (state.operationCapture) return state.operationCapture;
  const entryId = state.operationEntryId;
  const cp = entryId ? state.checkpoints.get(entryId) : undefined;
  const store = state.outside;
  const sessionId = state.sessionId;
  if (!cp || !store || !sessionId) return false;
  const generation = state.gen;
  const head = state.head;
  const refId = `op-${randomUUID()}`;
  const previous = cp.after;
  let workspace: Workspace | null = null;
  let captureStarted = false;
  const validate = () => {
    if (state.gen !== generation || state.operationEntryId !== entryId || state.checkpoints.get(entryId!) !== cp || state.head !== head) {
      throw new Error("operation position changed before after-snapshot publication");
    }
    assertRecoveryReady(state);
  };
  const publish = async (captured: { snapshot: WorkspaceSnapshot; unknown: string[] }) => {
    validate();
    const after: OperationSnapshot = {
      refId, timestamp: Date.now(), snapshot: captured.snapshot,
      outside: store.snapshotTracked(), projectModes: snapshotProjectModes(state), projectUnknown: captured.unknown,
    };
    if (!store.hasSnapshot(after.outside)) throw new Error("outside after-snapshot is unavailable or corrupt");
    cp.after = after;
    try { persistLocalIndex(state); }
    catch (error) { cp.after = previous; throw error; }
    // Not dirty: after-only metadata must never add a JSONL/tree entry at shutdown.
    if (previous) await workspace?.deleteSnapshotRefLocked(sessionId, previous.refId).catch(() => {});
  };
  const pending = (async () => {
    try {
      if (state.disabled) {
        await outsideLock(state, async () => publish({ snapshot: {}, unknown: [] }));
      } else {
        workspace = await waitReady(state);
        if (!workspace) throw new Error(state.readyError ?? "workspace not ready");
        await workspace.snapshotWithCoverage(head, `operation after ${entryId}`, state.forceTrack, {
          ref: { sessionId, entryId: refId }, lockTimeoutMs: SNAPSHOT_LOCK_BUDGET_MS,
          validate: () => { validate(); captureStarted = true; }, publish,
        });
      }
      return true;
    } catch (error) {
      // A published private pointer owns its pin even if a later fsync failed.
      if (workspace && captureStarted && !(error instanceof PrivateWriteError && error.published)) {
        const ws = workspace;
        await ws.withStoreLock(() => ws.deleteSnapshotRefLocked(sessionId, refId), SNAPSHOT_LOCK_BUDGET_MS, undefined, true).catch(() => {});
      }
      if (state.gen === generation) state.lastGap = `after-operation snapshot unavailable (before checkpoint retained): ${(error as Error).message}`;
      return false;
    }
  })();
  state.operationCapture = pending;
  try { return await pending; }
  finally {
    if (state.operationCapture === pending) state.operationCapture = null;
    if (state.gen === generation && state.operationEntryId === entryId) state.operationEntryId = null;
  }
}

/** The shape of a plan that has no worktree half. */
const EMPTY_PLAN: RestorePlan = { items: [], from: {}, to: {} };

export interface RestoreOutcome {
  plan: RestorePlan;
  result: ApplyResult | null;
}

/** Build the plan for going back to `cp`, having first snapshotted the current
 *  worktree so that the undo action in /rewind has somewhere to return to. */
export async function planRestore(state: RewindState, cp: PromptCheckpoint): Promise<RestorePlan | null> {
  assertRecoveryReady(state);
  const undoLabel = `before rewind to ${cp.prompt.slice(0, 40)}`;
  if (state.disabled) {
    if (!state.outside) return null;
    return outsideLock(state, async () => ({
      ...withOutside(state, EMPTY_PLAN, cp.outside),
      outsideFrom: state.outside?.snapshotTracked() ?? {},
      undoLabel,
    }));
  }

  const ws = await waitReady(state);
  if (!ws) return null;
  if (!(await ws.hasSnapshot(cp.snapshot))) return null;

  // Preview gets a temporary protected snapshot. The existing undo is not
  // replaced until apply actually begins, so cancelling preserves it.
  const pendingEntry = "undo-pending";
  const captured = await ws.snapshotWithCoverage(state.head, "pre-restore-preview", state.forceTrack, {
    ref: state.sessionId ? { sessionId: state.sessionId, entryId: pendingEntry } : undefined,
  });
  try {
    const worktreePlan = protectUnknown(await ws.buildPlan(captured.snapshot, cp.snapshot), cp.projectUnknown ?? [""], cp.projectAbsent);
    return ws.withStoreLock(() => ({
      ...withOutside(state, worktreePlan, cp.outside),
      projectUnknownFrom: captured.unknown,
      outsideFrom: state.outside?.snapshotTracked() ?? {},
      projectModesTo: cp.projectModes,
      projectModesFrom: snapshotProjectModes(state, Object.keys(cp.projectModes ?? {})),
      undoLabel,
      pendingRef: state.sessionId ? pendingEntry : undefined,
    }));
  } catch (error) {
    if (state.sessionId) await ws.deleteSnapshotRef(state.sessionId, pendingEntry).catch(() => {});
    throw error;
  }
}

/** Files outside the project are a second mechanism, so they are merged in at
 *  the plan level and nowhere else: the workspace never learns they exist. */
function withOutside(
  state: RewindState,
  plan: RestorePlan,
  to: RestorePlan["outsideTo"],
): RestorePlan {
  // A path may have temporarily become untrackable since the last preview.
  // Re-adopt only registry-authorized targets so a retry captures its preimage.
  state.outside?.adopt(Object.keys(to ?? {}));
  const items = state.outside?.plan(to) ?? [];
  if (!items.length) return { ...plan, outsideTo: to };
  return { ...plan, items: [...plan.items, ...items], outsideTo: to };
}

const isOutside = (i: PlanItem): boolean => i.repo === OUTSIDE;

export async function discardRestorePlan(state: RewindState, plan: RestorePlan): Promise<void> {
  if (!plan.pendingRef || !state.sessionId) return;
  const ws = await waitReady(state);
  if (ws) await ws.deleteSnapshotRef(state.sessionId, plan.pendingRef).catch(() => {});
}

export async function applyPlan(
  state: RewindState,
  preview: RestorePlan,
  opts: ApplyConsent = {},
): Promise<ApplyResult | null> {
  try { return await applyPlanChecked(state, preview, opts); }
  catch (error) {
    if (error instanceof RestorePreflightError) return { restored: 0, deleted: 0, skipped: [], errors: [error.message] };
    throw error;
  }
}

async function applyPlanChecked(
  state: RewindState,
  preview: RestorePlan,
  opts: ApplyConsent,
): Promise<ApplyResult | null> {
  const generation = state.gen;
  const validate = () => {
    if (generation !== state.gen) throw new Error("Session changed before restore");
    assertRecoveryReady(state);
  };
  const validateLocked = async () => {
    validate();
    await assertNotBusy(opts);
  };
  if (state.disabled) {
    if (!state.outside) return null;
    mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
    return outsideLock(state, async () => {
      await validateLocked();
      const plan: RestorePlan = {
        ...withOutside(state, EMPTY_PLAN, preview.outsideTo),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        undoLabel: preview.undoLabel,
      };
      const hasMutation = plan.items.some((item) =>
        item.action !== "unprotected" &&
        outsideApproved(item, opts) &&
        (item.action !== "type-change" || typeChangeApproved(item, opts)),
      );
      if (!hasMutation) return { restored: 0, deleted: 0, skipped: [...plan.items], errors: [] };
      const transaction = await beginRestoreTransaction(state, "rewind", plan, opts, null);
      const result: ApplyResult = { restored: 0, deleted: 0, skipped: [], errors: [] };
      applyOutside(state, plan, opts, result);
      await finishRestoreTransaction(state, transaction, result, null);
      return result;
    });
  }

  const ws = await waitReady(state);
  if (!ws || !state.outside) return null;
  validate();
  let transaction: RestoreTransaction;
  let worktreeClean = false;
  try {
    const outcome = await ws.applyFresh(
      state.head,
      preview.to,
      state.forceTrack,
      opts,
      {
        sessionId: state.sessionId ?? undefined,
        pendingEntry: preview.pendingRef ?? "undo-pending",
        previousUndo: state.undo?.snapshot,
        publishEntry: "undo",
      },
      (worktreePlan, now) => ({
        ...withOutside(state, protectUnknown(worktreePlan, preview.projectUnknownTo, preview.projectAbsentTo), preview.outsideTo),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        projectModesTo: preview.projectModesTo,
        projectModesFrom: snapshotProjectModes(state, Object.keys(preview.projectModesTo ?? {})),
        undoLabel: preview.undoLabel,
        pendingRef: state.sessionId ? (preview.pendingRef ?? "undo-pending") : undefined,
      }),
      (plan) => projectModeMapChangeCount(state, plan.projectModesTo) > 0 || plan.items.some((item) =>
        item.action !== "unprotected" &&
        (!isOutside(item) || outsideApproved(item, opts)) &&
        (item.action !== "type-change" || typeChangeApproved(item, opts)),
      ),
      async (_now, plan) => {
        // Snapshot and planning awaited Git under the lock; ask once more
        // before anything is published or written.
        await validateLocked();
        transaction = await beginRestoreTransaction(state, "rewind", plan, opts, ws);
      },
      async (lockedResult, plan) => {
        if (generation === state.gen) {
          applyOutside(state, plan, opts, lockedResult);
          restoreProjectModeMap(state, plan.projectModesTo, lockedResult);
        } else lockedResult.errors.push("Session changed; remaining outside/permission writes were skipped");
        await finishRestoreTransaction(state, transaction, lockedResult, ws);
        worktreeClean = lockedResult.errors.length === 0;
      },
      validateLocked,
    );
    if (generation === state.gen && outcome.applied && worktreeClean) state.head = outcome.plan.to;
    return outcome.result;
  } catch (error) {
    await discardRestorePlan(state, preview);
    throw error;
  }
}

/** Managed activity that began while we waited for the lock must stop the
 *  apply before its first write; surfaced as an error, never a silent skip. */
async function assertNotBusy(opts: ApplyConsent): Promise<void> {
  const reason = await opts.activityCheck?.();
  if (reason) throw new RestorePreflightError(reason);
}

function applyOutside(
  state: RewindState,
  plan: RestorePlan,
  opts: ApplyConsent,
  result: ApplyResult,
): void {
  const items = plan.items.filter(isOutside);
  if (!items.length || !state.outside) return;

  const doable: PlanItem[] = [];
  for (const item of items) {
    // Never applied by default: these paths are shared with the rest of the
    // machine, so "the user did not say yes" has to mean "do not touch it".
    if (item.action === "unprotected" || !outsideApproved(item, opts)) result.skipped.push(item);
    else if (item.action === "type-change" && !typeChangeApproved(item, opts)) result.skipped.push(item);
    else doable.push(item);
  }
  if (!doable.length) return;

  const r = state.outside.apply(doable);
  result.restored += r.restored;
  result.deleted += r.deleted;
  result.errors.push(...r.errors);
}

export interface UndoPreparation {
  plan: RestorePlan;
  target: WorkspaceSnapshot;
}

export async function planUndo(state: RewindState): Promise<UndoPreparation | null> {
  assertRecoveryReady(state, true);
  if (!state.undo || !state.outside) return null;
  if (state.disabled) {
    mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
    return outsideLock(state, async () => ({
      plan: { ...withOutside(state, EMPTY_PLAN, state.undo?.outside), outsideFrom: state.outside?.snapshotTracked() ?? {} },
      target: {},
    }));
  }

  const ws = await waitReady(state);
  if (!ws) return null;
  const target = state.undo.snapshot;
  // Fixed ref: previewing repeatedly stays bounded. It does not replace the
  // current undo ref/state, so cancelling the preview preserves the last undo.
  const captured = await ws.snapshotWithCoverage(state.head, "pre-undo-preview", state.forceTrack, {
    ref: state.sessionId ? { sessionId: state.sessionId, entryId: "undo-prev" } : undefined,
  });
  const worktreePlan = protectUnknown(await ws.buildPlan(captured.snapshot, target), state.undo.projectUnknown ?? [""], state.undo.projectAbsent);
  const plan = await ws.withStoreLock(() => ({
    ...withOutside(state, worktreePlan, state.undo?.outside),
    projectUnknownFrom: captured.unknown,
    outsideFrom: state.outside?.snapshotTracked() ?? {},
    projectModesTo: state.undo?.projectModes,
    projectModesFrom: snapshotProjectModes(state, Object.keys(state.undo?.projectModes ?? {})),
  }));
  return { plan, target };
}

export async function applyUndo(
  state: RewindState,
  prepared?: UndoPreparation,
  opts: ApplyConsent = {},
): Promise<ApplyResult | null> {
  try { return await applyUndoChecked(state, prepared, opts); }
  catch (error) {
    if (error instanceof RestorePreflightError) return { restored: 0, deleted: 0, skipped: [], errors: [error.message] };
    throw error;
  }
}

async function applyUndoChecked(
  state: RewindState,
  prepared: UndoPreparation | undefined,
  opts: ApplyConsent,
): Promise<ApplyResult | null> {
  const generation = state.gen;
  const validate = () => {
    if (generation !== state.gen) throw new Error("Session changed before Undo");
    assertRecoveryReady(state, true);
    assertUndoTargetsAvailable(state);
  };
  const validateLocked = async () => {
    validate();
    await assertNotBusy(opts);
  };
  const undo = prepared ?? (await planUndo(state));
  if (!undo || !state.undo || !state.outside) return null;
  const options = { ...opts, includeOutside: true };
  const shouldApply = (plan: RestorePlan) => projectModeMapChangeCount(state, plan.projectModesTo) > 0 || plan.items.some(item =>
    item.action !== "unprotected" && (item.action !== "type-change" || typeChangeApproved(item, opts)));
  if (state.disabled) {
    return outsideLock(state, async () => {
      await validateLocked();
      const plan = {
        ...withOutside(state, EMPTY_PLAN, state.undo?.outside),
        outsideFrom: state.outside?.snapshotTracked() ?? {}, undoLabel: "before undo",
      };
      await assertRecoveryPreview(state, undo.plan, plan, null);
      if (!shouldApply(plan)) {
        await finishRecoveryNoop(state, plan, null);
        return { restored: 0, deleted: 0, skipped: [...plan.items], errors: [] };
      }
      const transaction = await beginRestoreTransaction(state, "undo", plan, options, null);
      const result: ApplyResult = { restored: 0, deleted: 0, skipped: [], errors: [] };
      applyOutside(state, plan, options, result);
      await finishRestoreTransaction(state, transaction, result, null);
      return result;
    });
  }
  const ws = await waitReady(state);
  if (!ws) return null;
  validate();
  let transaction: RestoreTransaction;
  const outcome = await ws.applyFresh(
    state.head, undo.target, state.forceTrack, opts,
    { sessionId: state.sessionId ?? undefined, pendingEntry: "undo-prev" },
    async (worktreePlan) => {
      validate();
      const plan = {
        ...withOutside(state, protectUnknown(worktreePlan, state.undo?.projectUnknown ?? [""], state.undo?.projectAbsent), state.undo?.outside),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        projectModesTo: state.undo?.projectModes,
        projectModesFrom: snapshotProjectModes(state, Object.keys(state.undo?.projectModes ?? {})),
        undoLabel: "before undo",
      };
      await assertRecoveryPreview(state, undo.plan, plan, ws);
      return plan;
    },
    shouldApply,
    async (_now, plan) => {
      await validateLocked();
      transaction = await beginRestoreTransaction(state, "undo", plan, options, ws);
    },
    async (result, plan) => {
      if (generation === state.gen) {
        applyOutside(state, plan, options, result);
        restoreProjectModeMap(state, plan.projectModesTo, result);
      } else result.errors.push("Session changed; remaining outside/permission writes were skipped");
      await finishRestoreTransaction(state, transaction, result, ws);
    },
    validateLocked,
    (plan) => finishRecoveryNoop(state, plan, ws),
  );
  const incomplete = hasRequiredUndoItems(outcome.result.skipped);
  if (generation === state.gen && outcome.applied && outcome.result.errors.length === 0 && !incomplete) state.head = undo.target;
  return outcome.result;
}

/** Before-state belongs to its exact user prompt, not its descendants. Falling
 * back from an assistant/tool/uncheckpointed node restores too far backwards. */
export function pickCheckpointForEntry(
  state: RewindState,
  entryId: string,
  getEntry: (id: string) => unknown,
): PromptCheckpoint | undefined {
  const entry = getEntry(entryId) as { id?: string; type?: string; message?: { role?: string } } | undefined;
  if (entry?.id !== entryId || entry.type !== "message" || entry.message?.role !== "user") return undefined;
  return state.checkpoints.get(entryId);
}

function serializeBefore(cp: PromptCheckpoint): string {
  const { after: _after, ...before } = cp;
  return JSON.stringify(before);
}

function batchOnBranch(branch: unknown[] | undefined, token: string): boolean {
  return (branch as { type?: string; customType?: string; data?: { token?: unknown } }[] | undefined)
    ?.some(entry => entry?.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data?.token === token) ?? false;
}

/**
 * Publish before-checkpoint metadata to the session tree. Only changed objects
 * are appended, as a delta chained to the previous batch. A complete base is
 * republished when that previous batch is not on the active branch (tree
 * navigation), when the session owner changed (fork child), or when the caller
 * cannot supply the branch. Otherwise a fork whose history skipped the batch
 * that created an older checkpoint would lose it.
 */
export function persistIndex(pi: ExtensionAPI, state: RewindState, branch?: unknown[]): void {
  if (!state.sessionId || !state.dirty) return;
  const current = new Map<string, string>();
  for (const cp of state.checkpoints.values()) current.set(cp.entryId, serializeBefore(cp));
  const previous = state.publishedBatch;
  const base = !previous || previous.sessionId !== state.sessionId || !branch || !batchOnBranch(branch, previous.token);
  const changed = [...current].filter(([id, sig]) => base || state.publishedIndex.get(id) !== sig);
  const removed = base ? [] : [...state.publishedIndex.keys()].filter(id => !current.has(id));
  if (!changed.length && !removed.length) {
    state.dirty = false;
    return;
  }
  const token = randomUUID();
  const batch: PersistedIndex = {
    version: 5,
    kind: base ? "base" : "delta",
    token,
    parent: base ? null : previous!.token,
    localRevision: state.checkpointRevision,
    sessionId: state.sessionId,
    // Detached copies: later in-memory first-touch updates must not alias history.
    checkpoints: changed.map(([, sig]) => JSON.parse(sig) as PromptCheckpoint),
    removed,
  };
  pi.appendEntry(CUSTOM_TYPE, batch);
  state.publishedIndex = current;
  state.publishedBatch = { token, sessionId: state.sessionId };
  state.indexRevision = state.checkpointRevision;
  state.dirty = false;
}

/**
 * Replay published batches in file order. Legacy full arrays and bases replace
 * the map. A delta whose parent is not the immediately preceding batch has an
 * incomplete chain: its complete objects are still applied (an older object
 * covers less, never wrong bytes), removals are ignored, and the gap is reported.
 */
export function loadIndex(state: RewindState, entries: unknown[]): void {
  let checkpoints: Map<string, PromptCheckpoint> | null = null;
  let revisions = new Map<string, number>();
  let last: PersistedIndex | null = null;
  let gap = false;
  for (const entry of entries as { type?: string; customType?: string; data?: unknown }[]) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !entry.data) continue;
    const data = entry.data as PersistedIndex;
    if (!Array.isArray(data.checkpoints)) continue;
    const delta = data.version === 5 && data.kind === "delta";
    if (delta && (typeof data.token !== "string" || typeof data.parent !== "string")) continue;
    if (delta && data.parent !== last?.token) gap = true;
    if (!delta || !checkpoints) { checkpoints = new Map(); revisions = new Map(); gap = delta && gap; }
    if (delta && data.parent === last?.token) for (const id of data.removed ?? []) { checkpoints.delete(String(id)); revisions.delete(String(id)); }
    const revision = Number.isSafeInteger(data.localRevision) && data.localRevision! >= 0 ? data.localRevision! : 0;
    for (const cp of data.checkpoints) {
      if (!validCheckpoint(cp)) continue;
      // Operation observations belong to the private originating session, not forks.
      const { after: _after, ...before } = cp;
      checkpoints.set(before.entryId, JSON.parse(JSON.stringify(before)));
      revisions.set(before.entryId, revision);
    }
    last = data;
  }
  if (!checkpoints || !last) return;
  state.indexRevision = Number.isSafeInteger(last.localRevision) && last.localRevision! >= 0 ? last.localRevision! : 0;
  for (const [id, cp] of checkpoints) state.checkpoints.set(id, cp);
  state.indexObjectRevision = revisions;
  state.publishedIndex = new Map([...checkpoints].map(([id, cp]) => [id, serializeBefore(cp)]));
  state.publishedBatch = last.version === 5 && typeof last.token === "string" && typeof last.sessionId === "string"
    ? { token: last.token, sessionId: last.sessionId }
    : null;
  if (gap) state.lastGap = "checkpoint index chain incomplete; some coverage metadata may be older";
}

export function restorePosition(state: RewindState, branchEntries: unknown[]): void {
  const entries = branchEntries as { id?: string; type?: string; message?: { role?: string } }[];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry?.id || entry.type !== "message" || entry.message?.role !== "user") continue;
    const checkpoint = state.checkpoints.get(entry.id);
    if (!checkpoint) continue;
    state.currentEntryId = entry.id;
    state.head = checkpoint.snapshot;
    return;
  }
}

export function snapshotsEqual(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
