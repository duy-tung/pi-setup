import type { Workspace } from "./workspace.js";
import type { OutsideStore } from "./outside.js";
import type { OutsideSnapshot, PromptCheckpoint, WorkspaceSnapshot } from "./types.js";

export interface UndoPoint {
  snapshot: WorkspaceSnapshot;
  outside?: OutsideSnapshot;
  timestamp: number;
  label: string;
}

export interface RewindState {
  /** bumped on every session_start; in-flight async work from an older
   *  generation must not write into this state (a slow prime from the
   *  previous session used to clobber the new session's workspace) */
  gen: number;
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
  /** parent for the next shadow commit, so the shadow DAG follows the path
   *  actually taken through the session tree */
  head: WorkspaceSnapshot | null;
  currentEntryId: string | null;
  currentPrompt: string;
  /** paths the agent wrote to, force-tracked even when .gitignore'd.
   *  Project-relative only: an absolute pathspec makes `git add -f` fatal and
   *  takes the whole checkpoint with it. */
  forceTrack: Set<string>;
  /** files the agent wrote outside the project; null when rewind is off here */
  outside: OutsideStore | null;
  undo: UndoPoint | null;
  suppressTreeHook: boolean;
  dirty: boolean;
}

export function createInitialState(): RewindState {
  return {
    gen: 0,
    cwd: "",
    sessionId: null,
    ws: null,
    ready: null,
    readyError: null,
    disabled: null,
    lastGap: null,
    checkpoints: new Map(),
    head: null,
    currentEntryId: null,
    currentPrompt: "",
    forceTrack: new Set(),
    outside: null,
    undo: null,
    suppressTreeHook: false,
    dirty: false,
  };
}

export function resetState(state: RewindState): void {
  const gen = state.gen + 1;
  Object.assign(state, createInitialState());
  state.gen = gen;
}
