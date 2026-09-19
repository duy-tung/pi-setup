import { closeBackend, createBackendLifetime, type BackendLifetime } from "./backend-lifetime.js";
import type { Workspace } from "./workspace.js";
import type { OutsideStore } from "./outside.js";
import type { RecoveryRecord } from "./recovery.js";
import type { OutsideSnapshot, PromptCheckpoint, WorkspaceSnapshot } from "./types.js";

export interface UndoPoint {
  snapshot: WorkspaceSnapshot;
  outside?: OutsideSnapshot;
  projectModes?: Record<string, number>;
  projectUnknown?: string[];
  projectAbsent?: string[];
  timestamp: number;
  label: string;
}

export interface RewindState {
  /** bumped on every session_start; in-flight async work from an older
   *  generation must not write into this state (a slow prime from the
   *  previous session used to clobber the new session's workspace) */
  gen: number;
  lifetime: BackendLifetime;
  /** Only cold prime is actively cancelled; accepted file transactions drain. */
  primeAbort: AbortController | null;
  cwd: string;
  sessionId: string | null;
  ws: Workspace | null;
  /** resolves when the cold snapshot and capability probe have finished */
  ready: Promise<void> | null;
  readyError: string | null;
  /** set when this directory is out of scope by policy (see eligibility.ts).
   *  Distinct from readyError, which means "should have worked, did not": a
   *  disabled session stays quiet instead of warning on every prompt */
  disabled: string | null;
  /** set when a prompt went unprotected, with the reason, so the UI can say so
   *  instead of implying coverage */
  lastGap: string | null;
  checkpoints: Map<string, PromptCheckpoint>;
  checkpointRevision: number;
  indexRevision: number;
  /** Serialized before-state per published checkpoint ID; detects real changes. */
  publishedIndex: Map<string, string>;
  /** Public batch revision that supplied each loaded object; private state
   * repairs an object only when strictly newer than that object's batch. */
  indexObjectRevision: Map<string, number>;
  /** Last published batch token and owner; a delta may only chain from these. */
  publishedBatch: { token: string; sessionId: string } | null;
  /** parent for the next shadow commit, so the shadow DAG follows the path
   *  actually taken through the session tree */
  head: WorkspaceSnapshot | null;
  currentEntryId: string | null;
  currentPrompt: string;
  operationEntryId: string | null;
  operationCapture: Promise<boolean> | null;
  /** paths the agent wrote to, force-tracked even when .gitignore'd.
   *  Project-relative only: an absolute pathspec makes `git add -f` fatal and
   *  takes the whole checkpoint with it. */
  forceTrack: Set<string>;
  /** files the agent wrote outside the project; null when rewind is off here */
  outside: OutsideStore | null;
  undo: UndoPoint | null;
  recovery: RecoveryRecord | null;
  recoveryError: string | null;
  suppressTreeHook: boolean;
  /** True while a /tree or /fork hook dialog is open: the host reports
   *  non-idle there by construction, not because an agent is running. */
  hostNavigating: boolean;
  dirty: boolean;
  /** Optional restore-time activity probe installed by the host integration. */
  restoreBlocker?: () => Promise<string | null>;
}

/** An event already queued by an old host context must not enter a new lifetime.
 * Partial standalone/test contexts may omit these host identity fields. */
export function isCurrentSession(state: RewindState, ctx: any): boolean {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  return !state.lifetime?.closed &&
    (sessionId === undefined || state.sessionId == null || sessionId === state.sessionId) &&
    (!ctx?.cwd || !state.cwd || ctx.cwd === state.cwd);
}

export function createInitialState(hostManaged = false): RewindState {
  return {
    gen: 0,
    lifetime: createBackendLifetime(hostManaged),
    primeAbort: null,
    cwd: "",
    sessionId: null,
    ws: null,
    ready: null,
    readyError: null,
    disabled: null,
    lastGap: null,
    checkpoints: new Map(),
    checkpointRevision: 0,
    indexRevision: 0,
    publishedIndex: new Map(),
    indexObjectRevision: new Map(),
    publishedBatch: null,
    head: null,
    currentEntryId: null,
    currentPrompt: "",
    operationEntryId: null,
    operationCapture: null,
    forceTrack: new Set(),
    outside: null,
    undo: null,
    recovery: null,
    recoveryError: null,
    suppressTreeHook: false,
    hostNavigating: false,
    dirty: false,
  };
}

export function resetState(state: RewindState): void {
  const gen = state.gen + 1;
  const restoreBlocker = state.restoreBlocker;
  const hostManaged = state.lifetime?.hostManaged ?? false;
  if (state.lifetime) closeBackend(state.lifetime);
  state.primeAbort?.abort();
  Object.assign(state, createInitialState(hostManaged));
  state.gen = gen;
  state.restoreBlocker = restoreBlocker;
}
