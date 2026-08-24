export const CUSTOM_TYPE = "pi-rewind-cp";
export const MUTATING_TOOLS = new Set(["write", "edit"]);

/** Bound so a pathological vendor tree cannot spawn unbounded shadow repos. */
export const MAX_NESTED_REPOS = 32;

export const ROOT = "";

/** Sentinel repo id for files outside the project. No shadow repo owns them —
 *  they live in the content store of `outside.ts` — so this must never collide
 *  with a real subpath, hence the NUL. */
export const OUTSIDE = "\0outside";

/** repo subpath ("" = project root) -> shadow commit sha */
export type WorkspaceSnapshot = Record<string, string>;

/** A file outside the project, as it stood at a checkpoint. `absent` is a
 *  state, not a gap: it is what makes "the agent created this file" revertible. */
export type OutsideEntry = { sha: string; mode: number } | { absent: true };

/** absolute path -> state at the checkpoint */
export type OutsideSnapshot = Record<string, OutsideEntry>;

export type PlanAction =
  /** content differs; safe to rewrite */
  | "restore"
  /** present now, absent in the target snapshot */
  | "delete"
  /** on-disk type differs from the snapshot type (file <-> dir <-> symlink).
   *  Restoring these can `rm -rf` a directory, so they need confirmation. */
  | "type-change"
  /** knowingly outside the checkpoint's coverage; never silently applied */
  | "unprotected";

export type Writer = "checkout" | "in-place";

export interface PlanItem {
  /** which shadow repo owns this path ("" = root) */
  repo: string;
  /** path relative to that repo's worktree */
  path: string;
  /** path relative to the project root, for display */
  display: string;
  action: PlanAction;
  /** `in-place` preserves the inode so hardlinks survive; see DECISIONS.md §3 */
  writer?: Writer;
  targetSha?: string;
  targetMode?: string;
  reason?: string;
}

export interface RestorePlan {
  items: PlanItem[];
  /** snapshot of the worktree taken immediately before applying, for undo */
  from: WorkspaceSnapshot;
  to: WorkspaceSnapshot;
  /** target state for tracked files outside the project, if any */
  outsideTo?: OutsideSnapshot;
  /** current outside state captured for undo, published only when apply begins */
  outsideFrom?: OutsideSnapshot;
  /** label and temporary ref used by a preview that has not yet been applied */
  undoLabel?: string;
  pendingRef?: string;
}

export interface ApplyResult {
  restored: number;
  deleted: number;
  skipped: PlanItem[];
  errors: string[];
}

export interface PromptCheckpoint {
  entryId: string;
  parentEntryId: string | null;
  prompt: string;
  timestamp: number;
  snapshot: WorkspaceSnapshot;
  /** Written lazily and back-filled: a path appears here as soon as the agent
   *  first writes to it, including in checkpoints taken before that. */
  outside?: OutsideSnapshot;
}

export interface PersistedIndex {
  version: 3;
  sessionId: string;
  checkpoints: PromptCheckpoint[];
}

export interface Coverage {
  /** paths that cannot be represented on this filesystem (case collisions) */
  unrepresentable: string[];
  /** nested repos we chose not to shadow (over the cap or over budget) */
  skippedNested: string[];
  /** ignore rules seeded because the project has neither .git nor .gitignore;
   *  these paths are not checkpointed unless the agent writes to them */
  defaultExcluded: string[];
  caseInsensitive: boolean;
  nestedCount: number;
}

export type RestoreMode =
  | "all"
  | "files"
  | "conversation"
  | "summarize-up"
  | "summarize-from"
  | "cancel";
