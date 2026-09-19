/** Durable publication around the existing locked writers; never auto-replay. */
import { randomUUID } from "node:crypto";
import type { RewindState, UndoPoint } from "./state.js";
import type { Workspace } from "./workspace.js";
import { outsideApproved, typeChangeApproved, type ApplyConsent } from "./plan.js";
import { OUTSIDE, type ApplyResult, type OutsideSnapshot, type PlanItem, type RestorePlan } from "./types.js";
import { readRecovery, writeRecovery, type RecoveryJournal, type RecoveryRecord, type StoredUndoPoint } from "./recovery.js";

export class RestorePreflightError extends Error {}

const RECOVERY_GAP = "interrupted file restore; use Undo last rewind to recover explicitly";

function sameMap(a: object | undefined, b: object | undefined): boolean {
  const canonical = (value: object | undefined) => Object.entries(value ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, entry && typeof entry === "object" ? Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)) : entry]);
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function points(record: RecoveryRecord | null): StoredUndoPoint[] {
  return [record?.undo, record?.journal?.before, record?.journal?.target, record?.journal?.previousUndo].filter(Boolean) as StoredUndoPoint[];
}

/** Startup validates identity/authorization but does not read or restore file contents. */
export function loadRecoveryState(state: RewindState): void {
  if (!state.outside || !state.sessionId) return;
  try {
    const record = readRecovery(state.outside.storeDir, state.outside.cwd, state.sessionId);
    const paths = new Set<string>();
    for (const point of points(record)) {
      const safe = state.outside.sanitizeSnapshot(point.outside);
      if (!sameMap(point.outside, safe)) throw new Error("recovery outside-path authorization changed");
      for (const path of Object.keys(safe ?? {})) paths.add(path);
    }
    state.outside.adopt(paths);
    state.recovery = record;
    state.undo = record?.undo ?? null;
    if (record?.journal) state.lastGap = RECOVERY_GAP;
  } catch (error) {
    state.recoveryError = `Recovery state unavailable: ${(error as Error).message}`;
    state.undo = null;
  }
}

/** Caller rechecks this under snapshot.lock, before changing refs or files. */
export function assertRecoveryReady(state: RewindState, allowPending = false): void {
  if (state.recoveryError) throw new Error(state.recoveryError);
  if (!state.outside || !state.sessionId) throw new Error("Rewind needs an initialized session");
  const latest = readRecovery(state.outside.storeDir, state.outside.cwd, state.sessionId);
  if ((latest?.revision ?? 0) !== (state.recovery?.revision ?? 0)) throw new Error("Recovery state changed in another instance; reload before restoring");
  if (latest?.journal && !allowPending) throw new Error("An interrupted restore is pending. Use Undo last rewind before starting another file rewind.");
}

/** Planning may mark missing blobs unprotected; that is not a completed Undo. */
export function assertUndoTargetsAvailable(state: RewindState): void {
  if (state.undo && !state.outside?.hasSnapshot(state.undo.outside)) {
    throw new RestorePreflightError("Undo target is missing, corrupt, or no longer authorized; the original Undo destination was preserved");
  }
}

function stored(value: UndoPoint, refId: string): StoredUndoPoint {
  // Strict durable records omit optional properties rather than writing undefined.
  return {
    snapshot: value.snapshot, timestamp: value.timestamp, label: value.label, refId,
    ...(value.outside === undefined ? {} : { outside: value.outside }),
    ...(value.projectModes === undefined ? {} : { projectModes: value.projectModes }),
    ...(value.projectUnknown === undefined ? {} : { projectUnknown: value.projectUnknown }),
    ...(value.projectAbsent === undefined ? {} : { projectAbsent: value.projectAbsent }),
  };
}

export interface RestoreTransaction {
  generation: number;
  cwd: string;
  storeDir: string;
  sessionId: string;
  record: RecoveryRecord;
  prior: RecoveryRecord | null;
  originalUndo: UndoPoint | null;
}

/** All callers hold snapshot.lock. Immutable pins survive publication failures. */
export async function beginRestoreTransaction(
  state: RewindState, kind: "rewind" | "undo", plan: RestorePlan,
  options: ApplyConsent, ws: Workspace | null,
): Promise<RestoreTransaction> {
  assertRecoveryReady(state, kind === "undo");
  if (kind === "undo") assertUndoTargetsAvailable(state);
  const store = state.outside!;
  const sessionId = state.sessionId!;
  const generation = state.gen;
  const prior = state.recovery;
  const originalUndo = state.undo;
  const id = randomUUID();
  const before = stored({
    snapshot: plan.from, outside: plan.outsideFrom, projectModes: plan.projectModesFrom,
    projectUnknown: plan.projectUnknownFrom, projectAbsent: plan.projectAbsentFrom,
    timestamp: Date.now(), label: plan.undoLabel ?? "before rewind",
  }, `tx-${id}-before`);
  const target = stored({
    snapshot: plan.to, outside: plan.outsideTo, projectModes: plan.projectModesTo,
    projectUnknown: plan.projectUnknownTo, projectAbsent: plan.projectAbsentTo,
    timestamp: Date.now(), label: kind === "undo" ? "undo destination" : "rewind destination",
  }, `tx-${id}-target`);
  const previousUndo = originalUndo ? stored(originalUndo, prior?.undo?.refId ?? `tx-${randomUUID()}-before`) : null;
  if (!store.hasSnapshot(before.outside)) throw new RestorePreflightError("Cannot preserve Undo: an outside preimage is missing, corrupt, or no longer authorized");
  const selectedOutside: OutsideSnapshot = {};
  for (const item of plan.items) {
    if (item.repo !== OUTSIDE || !outsideApproved(item, options) || item.action === "unprotected" ||
        (item.action === "type-change" && !typeChangeApproved(item, options))) continue;
    if (!Object.hasOwn(before.outside ?? {}, item.path)) {
      throw new RestorePreflightError(`Cannot preserve Undo for ${item.display}; preserve or resolve the unsupported current path before retrying`);
    }
    const entry = plan.outsideTo?.[item.path];
    if (!entry) throw new RestorePreflightError("Outside restore target lacks an explicit preimage or absence");
    selectedOutside[item.path] = entry;
  }
  if (!store.hasSnapshot(selectedOutside)) throw new RestorePreflightError("Outside restore target is missing, corrupt, or no longer authorized");
  // Project targets get the same treatment: git's checkout removes the current
  // file before it discovers that the replacement blob is gone, so a missing
  // object must refuse every writer here, before anything is published.
  if (ws) {
    const missing = await ws.missingTargets(plan, options);
    if (missing.length) {
      throw new RestorePreflightError(`Restore target blob is missing or corrupt for ${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}; nothing was written`);
    }
  }
  try {
    for (const point of [before, target, previousUndo]) {
      if (point) await ws?.setRefs(point.snapshot, sessionId, point.refId);
    }
    if (generation !== state.gen) throw new Error("Session changed before restore publication");
    // Last word before the journal is published and writers start: blob
    // verification and ref pinning above awaited Git, and managed activity
    // may have begun meanwhile. The pins are cleaned up by the catch below.
    const busy = await options.activityCheck?.();
    if (busy) throw new RestorePreflightError(busy);
    const journal: RecoveryJournal = {
      id, kind, phase: "pending", startedAt: Date.now(), before, target, previousUndo,
      options: { includeOutside: !!options.includeOutside, includeTypeChanges: !!options.includeTypeChanges },
    };
    const record = writeRecovery(store.storeDir, store.cwd, sessionId, prior?.revision ?? 0, {
      undo: kind === "rewind" ? before : previousUndo ?? target, journal,
    });
    state.recovery = record;
    // An explicit restore supersedes any still-pending after-operation observation.
    state.operationEntryId = null;
    if (kind === "rewind") state.undo = before;
    return { generation, cwd: store.cwd, storeDir: store.storeDir, sessionId, record, prior, originalUndo };
  } catch (error) {
    // A rename may have succeeded before a later sync error. Read the actual
    // record before releasing anything; uncertainty keeps every potential pin.
    try {
      const actual = readRecovery(store.storeDir, store.cwd, sessionId);
      const keep = new Set(points(actual).map(point => point.refId));
      if (previousUndo) keep.add(previousUndo.refId);
      for (const point of [before, target]) {
        if (!keep.has(point.refId)) await ws?.deleteSnapshotRefLocked(sessionId, point.refId);
      }
    } catch { /* retain pins until a successful retry or session retention */ }
    throw error;
  }
}

/** Coverage-only diagnostics describe unmanaged data, not a missing Undo target. */
export function hasRequiredUndoItems(items: readonly PlanItem[]): boolean {
  return items.some(item => !item.coverageOnly);
}

/** Finishes inside the same lock as content/chmod. Pending remains on any failure. */
export async function finishRestoreTransaction(state: RewindState, tx: RestoreTransaction, result: ApplyResult, ws: Workspace | null): Promise<void> {
  const journal = tx.record.journal!;
  const incomplete = result.errors.length > 0 || (journal.kind === "undo" && hasRequiredUndoItems(result.skipped));
  let undo = tx.record.undo;
  if (!incomplete && journal.kind === "undo") {
    await ws?.replaceSnapshotRefLocked(journal.before.snapshot, tx.originalUndo?.snapshot, tx.sessionId, "undo");
    undo = journal.before;
  }
  const record = writeRecovery(tx.storeDir, tx.cwd, tx.sessionId, tx.record.revision, {
    undo,
    journal: incomplete ? { ...journal, phase: "failed", error: (result.errors[0] ?? "Undo skipped a required path; the original destination remains retryable").slice(0, 8192) } : null,
  });
  if (state.gen === tx.generation) {
    state.recovery = record;
    if (!record.journal && state.lastGap === RECOVERY_GAP) state.lastGap = null;
    // Preserve object identity as well as destination on a failed Undo.
    state.undo = incomplete && journal.kind === "undo" ? tx.originalUndo : record.undo;
  }
  const keep = new Set(points(record).map(point => point.refId));
  for (const ref of new Set([...points(tx.prior), ...points(tx.record)].map(point => point.refId))) {
    if (!keep.has(ref)) await ws?.deleteSnapshotRefLocked(tx.sessionId, ref).catch(() => {});
  }
}

/** An explicitly requested recovery already at its exact managed target needs no writes. */
export async function finishRecoveryNoop(state: RewindState, plan: RestorePlan, ws: Workspace | null): Promise<void> {
  if (!state.recovery?.journal || hasRequiredUndoItems(plan.items)) return;
  assertRecoveryReady(state, true);
  assertUndoTargetsAvailable(state);
  const store = state.outside!;
  const prior = state.recovery;
  const sessionId = state.sessionId!;
  state.recovery = writeRecovery(store.storeDir, store.cwd, sessionId, prior.revision, { undo: prior.undo, journal: null });
  if (state.lastGap === RECOVERY_GAP) state.lastGap = null;
  for (const ref of new Set(points(prior).map(point => point.refId))) {
    if (ref !== prior.undo?.refId) await ws?.deleteSnapshotRefLocked(sessionId, ref).catch(() => {});
  }
}

/** Recovery consent must describe the current managed state, not an older preview. */
export async function assertRecoveryPreview(state: RewindState, preview: RestorePlan, fresh: RestorePlan, ws: Workspace | null): Promise<void> {
  if (!state.recovery?.journal) return;
  if (!sameMap(preview.outsideFrom, fresh.outsideFrom) || !sameMap(preview.projectModesFrom, fresh.projectModesFrom) ||
      JSON.stringify(preview.items) !== JSON.stringify(fresh.items) ||
      (ws && !await ws.sameTrees(preview.from, fresh.from))) {
    throw new Error("Files changed after the recovery preview. Run Undo last rewind again to review the current changes.");
  }
}
