import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RewindState } from "./state.js";
import {
  CUSTOM_TYPE,
  OUTSIDE,
  type ApplyResult,
  type PlanItem,
  type PromptCheckpoint,
  type RestorePlan,
  type WorkspaceSnapshot,
} from "./types.js";
import { Workspace, storeDirFor } from "./workspace.js";
import { checkEligible, resolveExisting } from "./eligibility.js";
import { OutsideStore } from "./outside.js";
import { withLock } from "./lock.js";

/** Store paths relative to the project root; anything outside stays absolute
 *  and will simply never match a repo, so it is never touched. */
export function toRelPath(cwd: string, inputPath: string): string {
  const abs = isAbsolute(inputPath) ? inputPath : join(cwd, inputPath);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs.split(sep).join("/");
  return rel.split(sep).join("/");
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
  if (!state.outside) return;
  const paths = new Set<string>();
  for (const cp of state.checkpoints.values()) {
    cp.outside = state.outside.sanitizeSnapshot(cp.outside);
    for (const p of Object.keys(cp.outside ?? {})) paths.add(p);
  }
  if (paths.size) state.outside.adopt(paths);
}

/** Opens the workspace and kicks the cold snapshot off in the background: it
 *  is 1.6s on a small repo and ~48s on the linux kernel, and the user is
 *  typing their first prompt while it runs. */
export function beginWorkspace(state: RewindState, cwd: string): void {
  state.cwd = cwd;

  // Decided before anything touches disk. `Workspace.open` already creates the
  // store directory and inits a shadow repo, so a check after it would leave
  // droppings in ~/.pi/agent/rewind for every directory pi was ever started in.
  const gate = checkEligible(cwd);
  const real = resolveExisting(cwd);

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
    state.ready = Promise.resolve();
    return;
  }

  // Created before the prime, not after it: `tool_call` can fire while the
  // cold snapshot is still running, and the pre-write content is only
  // capturable at that moment. Same store directory as the shadow repos, so
  // one project has one place on disk.
  state.outside = new OutsideStore(real, storeDirFor(real));
  adoptTracked(state);

  // Generation guard: this closure keeps running after a /new session resets
  // the same state object. A 42s prime from the old session must not clobber
  // the new session's workspace (or its readyError) when it finally lands.
  const gen = state.gen;
  state.ready = (async () => {
    try {
      const ws = await Workspace.open(cwd);
      if (gen !== state.gen) return;
      state.ws = ws;
      await ws.prime();
    } catch (err) {
      if (gen !== state.gen) return;
      state.readyError = err instanceof Error ? err.message : String(err);
      state.ws = null;
    }
  })();
}

/**
 * Priming costs 42 s on the linux kernel. Blocking the first prompt for that
 * long is worse than declaring the prompt unprotected, so callers on the hot
 * path pass a budget; the rewind UI passes none and waits.
 */
export async function waitReady(state: RewindState, budgetMs?: number): Promise<Workspace | null> {
  if (!state.ready) return state.ws;
  if (budgetMs == null) {
    await state.ready;
    return state.ws;
  }
  let timer: NodeJS.Timeout | undefined;
  // Deliberately not unref'd: an unref'd timer lets the process exit before the
  // race settles, leaving the caller's await hanging forever.
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  const outcome = await Promise.race([state.ready.then(() => "ready" as const), timeout]);
  clearTimeout(timer);
  return outcome === "ready" ? state.ws : null;
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

  let snapshot;
  try {
    // The ref is written by snapshot() inside the store lock: a commit that
    // sat unreferenced even briefly could be pruned by another session's
    // shutdown maintenance.
    snapshot = await ws.snapshot(state.head, `checkpoint ${entryId}`, state.forceTrack, {
      lockTimeoutMs: SNAPSHOT_LOCK_BUDGET_MS,
      ref: state.sessionId ? { sessionId: state.sessionId, entryId } : undefined,
    });
  } catch (err) {
    // A failed snapshot must not be recorded: a checkpoint that contains
    // nothing still looks restorable and silently does nothing.
    state.lastGap = `checkpoint failed: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }

  let outside: PromptCheckpoint["outside"] = {};
  try {
    outside = await ws.withStoreLock(
      () => state.outside?.snapshotTracked() ?? {},
      SNAPSHOT_LOCK_BUDGET_MS,
    );
  } catch (error) {
    state.lastGap = `outside checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }

  const cp: PromptCheckpoint = {
    entryId,
    parentEntryId: state.currentEntryId,
    prompt: prompt.slice(0, 200),
    timestamp,
    snapshot,
    outside,
  };
  state.checkpoints.set(entryId, cp);
  state.head = snapshot;
  state.dirty = true;
  state.lastGap = null;
  return cp;
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
  return withLock(join(state.outside.storeDir, "snapshot.lock"), async () => {
    const cp: PromptCheckpoint = {
      entryId,
      parentEntryId: state.currentEntryId,
      prompt: prompt.slice(0, 200),
      timestamp,
      snapshot: {},
      outside: state.outside?.snapshotTracked() ?? {},
    };
    state.checkpoints.set(entryId, cp);
    state.dirty = true;
    return cp;
  });
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
  const undoLabel = `before rewind to ${cp.prompt.slice(0, 40)}`;
  if (state.disabled) {
    if (!state.outside) return null;
    return withLock(join(state.outside.storeDir, "snapshot.lock"), async () => ({
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
  const now = await ws.snapshot(state.head, "pre-restore-preview", state.forceTrack, {
    ref: state.sessionId ? { sessionId: state.sessionId, entryId: pendingEntry } : undefined,
  });
  try {
    const worktreePlan = await ws.buildPlan(now, cp.snapshot);
    return ws.withStoreLock(() => ({
      ...withOutside(state, worktreePlan, cp.outside),
      outsideFrom: state.outside?.snapshotTracked() ?? {},
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

async function publishUndo(state: RewindState, plan: RestorePlan, ws: Workspace | null): Promise<void> {
  if (ws && state.sessionId) {
    await ws.replaceSnapshotRef(plan.from, state.undo?.snapshot, state.sessionId, "undo");
  }
  state.undo = {
    snapshot: plan.from,
    outside: plan.outsideFrom,
    timestamp: Date.now(),
    label: plan.undoLabel ?? "before rewind",
  };
}

export async function applyPlan(
  state: RewindState,
  preview: RestorePlan,
  opts: { includeTypeChanges?: boolean; includeOutside?: boolean } = {},
): Promise<ApplyResult | null> {
  if (state.disabled) {
    if (!state.outside) return null;
    mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
    return withLock(join(state.outside.storeDir, "snapshot.lock"), async () => {
      const plan: RestorePlan = {
        ...withOutside(state, EMPTY_PLAN, preview.outsideTo),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        undoLabel: preview.undoLabel,
      };
      const hasMutation = plan.items.some((item) =>
        item.action !== "unprotected" &&
        opts.includeOutside &&
        (item.action !== "type-change" || opts.includeTypeChanges),
      );
      if (!hasMutation) return { restored: 0, deleted: 0, skipped: [...plan.items], errors: [] };
      await publishUndo(state, plan, null);
      const result: ApplyResult = { restored: 0, deleted: 0, skipped: [], errors: [] };
      applyOutside(state, plan, opts, result);
      return result;
    });
  }

  const ws = await waitReady(state);
  if (!ws || !state.outside) return null;
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
        ...withOutside(state, worktreePlan, preview.outsideTo),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        undoLabel: preview.undoLabel,
        pendingRef: state.sessionId ? (preview.pendingRef ?? "undo-pending") : undefined,
      }),
      (plan) => plan.items.some((item) =>
        item.action !== "unprotected" &&
        (!isOutside(item) || opts.includeOutside) &&
        (item.action !== "type-change" || opts.includeTypeChanges),
      ),
      (now, plan) => {
        state.undo = {
          snapshot: now,
          outside: plan.outsideFrom,
          timestamp: Date.now(),
          label: plan.undoLabel ?? "before rewind",
        };
      },
      (lockedResult, plan) => {
        worktreeClean = lockedResult.errors.length === 0;
        applyOutside(state, plan, opts, lockedResult);
      },
    );
    if (outcome.applied && worktreeClean) state.head = outcome.plan.to;
    return outcome.result;
  } catch (error) {
    await discardRestorePlan(state, preview);
    throw error;
  }
}

function applyOutside(
  state: RewindState,
  plan: RestorePlan,
  opts: { includeTypeChanges?: boolean; includeOutside?: boolean },
  result: ApplyResult,
): void {
  const items = plan.items.filter(isOutside);
  if (!items.length || !state.outside) return;

  const doable: PlanItem[] = [];
  for (const item of items) {
    // Never applied by default: these paths are shared with the rest of the
    // machine, so "the user did not say yes" has to mean "do not touch it".
    if (item.action === "unprotected" || !opts.includeOutside) result.skipped.push(item);
    else if (item.action === "type-change" && !opts.includeTypeChanges) result.skipped.push(item);
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
  if (!state.undo || !state.outside) return null;
  if (state.disabled) {
    mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
    return withLock(join(state.outside.storeDir, "snapshot.lock"), async () => ({
      plan: withOutside(state, EMPTY_PLAN, state.undo?.outside),
      target: {},
    }));
  }

  const ws = await waitReady(state);
  if (!ws) return null;
  const target = state.undo.snapshot;
  // Fixed ref: previewing repeatedly stays bounded. It does not replace the
  // current undo ref/state, so cancelling the preview preserves the last undo.
  const now = await ws.snapshot(state.head, "pre-undo-preview", state.forceTrack, {
    ref: state.sessionId ? { sessionId: state.sessionId, entryId: "undo-prev" } : undefined,
  });
  const worktreePlan = await ws.buildPlan(now, target);
  const plan = await ws.withStoreLock(() => withOutside(state, worktreePlan, state.undo?.outside));
  return { plan, target };
}

export async function applyUndo(
  state: RewindState,
  prepared?: UndoPreparation,
  opts: { includeTypeChanges?: boolean } = {},
): Promise<ApplyResult | null> {
  const undo = prepared ?? (await planUndo(state));
  if (!undo || !state.undo || !state.outside) return null;
  const originalUndo = state.undo;

  let result: ApplyResult;
  let reverseUndo: RewindState["undo"] = null;
  let promotionWorkspace: Workspace | null = null;
  let didApply = false;
  if (state.disabled) {
    mkdirSync(state.outside.storeDir, { recursive: true, mode: 0o700 });
    result = await withLock(join(state.outside.storeDir, "snapshot.lock"), async () => {
      const outsideBefore = state.outside?.snapshotTracked() ?? {};
      const freshPlan = withOutside(state, EMPTY_PLAN, state.undo?.outside);
      const lockedResult: ApplyResult = { restored: 0, deleted: 0, skipped: [], errors: [] };
      reverseUndo = { snapshot: {}, outside: outsideBefore, timestamp: Date.now(), label: "before undo" };
      applyOutside(state, freshPlan, { includeTypeChanges: opts.includeTypeChanges, includeOutside: true }, lockedResult);
      return lockedResult;
    });
    didApply = result.restored + result.deleted > 0;
  } else {
    const ws = await waitReady(state);
    if (!ws) return null;
    const outcome = await ws.applyFresh(
      state.head,
      undo.target,
      state.forceTrack,
      { includeTypeChanges: opts.includeTypeChanges },
      {
        sessionId: state.sessionId ?? undefined,
        pendingEntry: "undo-prev",
        keepPending: true,
      },
      (worktreePlan) => ({
        ...withOutside(state, worktreePlan, state.undo?.outside),
        outsideFrom: state.outside?.snapshotTracked() ?? {},
        undoLabel: "before undo",
      }),
      (plan) => plan.items.some((item) =>
        item.action !== "unprotected" &&
        (item.action !== "type-change" || opts.includeTypeChanges),
      ),
      (now, plan) => {
        reverseUndo = {
          snapshot: now,
          outside: plan.outsideFrom,
          timestamp: Date.now(),
          label: "before undo",
        };
      },
      (lockedResult, plan) => {
        applyOutside(
          state,
          plan,
          { includeTypeChanges: opts.includeTypeChanges, includeOutside: true },
          lockedResult,
        );
      },
    );
    result = outcome.result;
    didApply = outcome.applied;
    promotionWorkspace = ws;
    reverseUndo = {
      snapshot: outcome.undoSnapshot,
      outside: outcome.plan.outsideFrom,
      timestamp: Date.now(),
      label: "before undo",
    };
  }

  // A skipped type change means the undo is intentionally incomplete and must
  // remain retryable after the user inspects/confirms it.
  const incomplete = result.skipped.some((item) => item.action === "type-change");
  if (didApply && result.errors.length === 0 && !incomplete && reverseUndo) {
    if (promotionWorkspace && state.sessionId) {
      await promotionWorkspace.replaceSnapshotRef(
        reverseUndo.snapshot,
        originalUndo.snapshot,
        state.sessionId,
        "undo",
      );
      await promotionWorkspace.deleteSnapshotRef(state.sessionId, "undo-prev").catch(() => {});
    }
    state.undo = reverseUndo;
    if (!state.disabled) state.head = undo.target;
  } else {
    // Failed/skipped undo must remain retryable at the original destination.
    state.undo = originalUndo;
  }
  return result;
}

/** Walk up the session tree to the nearest ancestor that has a checkpoint, so
 *  selecting an assistant message or tool call still resolves to something. */
export function pickCheckpointForEntry(
  state: RewindState,
  entryId: string,
  getEntry: (id: string) => unknown,
): PromptCheckpoint | undefined {
  if (state.checkpoints.has(entryId)) return state.checkpoints.get(entryId);
  let cur = getEntry(entryId) as { id?: string; parentId?: string } | null;
  const seen = new Set<string>();
  while (cur?.id && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (state.checkpoints.has(cur.id)) return state.checkpoints.get(cur.id);
    cur = cur.parentId ? (getEntry(cur.parentId) as typeof cur) : null;
  }
  return undefined;
}

export function persistIndex(pi: ExtensionAPI, state: RewindState): void {
  if (!state.sessionId || !state.dirty) return;
  pi.appendEntry(CUSTOM_TYPE, {
    version: 3,
    sessionId: state.sessionId,
    checkpoints: [...state.checkpoints.values()],
  });
  state.dirty = false;
}

function validCheckpoint(value: unknown): value is PromptCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cp = value as Partial<PromptCheckpoint>;
  if (typeof cp.entryId !== "string" || !cp.entryId || cp.entryId.length > 512) return false;
  if (!cp.snapshot || typeof cp.snapshot !== "object" || Array.isArray(cp.snapshot)) return false;
  for (const [sub, sha] of Object.entries(cp.snapshot)) {
    if (sub.includes("\0") || isAbsolute(sub) || sub.split("/").includes("..")) return false;
    if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha)) return false;
  }
  return true;
}

export function loadIndex(state: RewindState, entries: unknown[]): void {
  let latest: { checkpoints?: PromptCheckpoint[] } | null = null;
  for (const entry of entries as { type?: string; customType?: string; data?: unknown }[]) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
      latest = entry.data as { checkpoints?: PromptCheckpoint[] };
    }
  }
  if (!Array.isArray(latest?.checkpoints)) return;
  for (const cp of latest.checkpoints) {
    if (validCheckpoint(cp)) state.checkpoints.set(cp.entryId, cp);
  }
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
