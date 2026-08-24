# Worktree checkpoints for Pi

Claude Code rewinds a flat list of prompts. Pi has a real session *tree*, so
this aims one step further: **the worktree is a function of the node you are
standing on.**

## Model

Each user prompt gets a checkpoint of the whole worktree, taken *before* the
agent acts, bound to the user message id. The checkpoint is a commit in a
shadow git repo whose parent is the point we last stood at, so the shadow DAG
is isomorphic to the session tree:

```
session   P1 ── P2 ── P3            shadow   c1 ── c2 ── c3
                └──── P4                           └──── c4

navigateTree(X) → conversation = path(root→X) + worktree = restore(commit(X))
```

Consequences that a flat prompt list cannot give:

- rewind to any node, including one on another branch
- diff any two points (`git diff c3 c7`, ~5 ms)
- restore a single file from another branch
- bash is covered for everything `.gitignore` does not hide: `sed -i`, codegen
  and formatters land in the snapshot because the whole worktree does. Inside
  *ignored* directories only paths touched via the `write`/`edit` tools are
  force-tracked — bash writes there carry no tool path, so `npm install` into
  an ignored `node_modules/` is **not** captured. A declared gap, not an
  accident.

## Storage

One shadow repo per worktree under `~/.pi/agent/rewind/<hash(project)>/`,
keyed by project rather than by session, so the expensive first snapshot is
paid once per project and later sessions start warm (~60 ms).

It never touches the project's own `.git`: no `git reset`, no rewritten
commits, no staged changes. `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
point elsewhere and `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL=/dev/null` keep
the user's config — including any git-lfs filter — out of the capture path.

Measured (M-series Mac, APFS, git 2.53), through the real code path:

| | linux 94.8k files | vscode 17.9k | terminal 3.7k |
|--|--|--|--|
| prime (once per project, background) | 42.3 s | 6.4 s | 1.7 s |
| **checkpoint** | **228 ms** | **105 ms** | **31 ms** |
| build restore plan | 6 ms | 5 ms | 5 ms |
| apply | 239 ms | 143 ms | ~30 ms |

Checkpoints are taken while the model is thinking, so the cost is hidden.

Priming is bounded, not blocking: a prompt waits at most 2 s for the cold
snapshot, then proceeds and says the prompt is unprotected. Stalling the agent
for 42 s would be worse than one declared gap.

## Concurrency

Two pi sessions in the same directory shadow the same worktree, so they share
the store — which is correct, but git serialises index writes with `index.lock`
and a losing writer simply fails. Measured without a lock: two processes taking
8 checkpoints each **lost 13 of 16, silently**, and the empty snapshots were
recorded as valid checkpoints that restored nothing.

So: an owner-token advisory lock (`snapshot.lock`) wraps prime, snapshot,
restore-apply and maintenance. Only the current owner may release it; process-wide
signal handlers exist only while at least one lock is held, and normal exit or
catchable signals clean it up before termination. There is
no automatic stale takeover: POSIX cannot compare-and-unlink, so a contender can
judge dead lock A stale and accidentally remove newly acquired live lock B.
After SIGKILL/crash, operations fail closed with the exact path for manual removal
after confirming no session owns it. Root initialization, worktree/outside checkpoints, restores, projectless outside
state, and maintenance all use that store lock. Restores go through a private
throwaway index, so a concurrent snapshot can never rewrite the index between `read-tree` and
`checkout-index`. Git failures throw instead of degrading into an empty
result: any `add` failure beyond unreadable individual files aborts the
checkpoint, because a stale index commits the *previous* worktree while
looking valid. On the hot path a snapshot waits at most 5 s for the lock,
then declares the prompt unprotected. 3 processes × 8 checkpoints on vscode:
24/24 succeed in 2.4 s.

## Maintenance

`gc.auto` is 0, so nothing repacks on its own. At session shutdown the store
prunes checkpoint refs for sessions beyond 20 kept or 30 days old, then repacks
if anything was pruned, loose objects exceed 5,000, or the store exceeds 2 GB.
The 2 GB threshold triggers GC, not a hard cap: current-session refs remain and a
single very long session can exceed it until that session ages out. Everything worth keeping carries a ref — including the undo point exposed through `/rewind` — and the
ref is written inside the snapshot lock, so no commit is ever visible
unreferenced. Maintenance itself runs under the store lock and prunes with a
30-minute grace (`--prune=30.minutes.ago`): a parallel session's in-flight
objects are never collected. (`--prune=now` deleted a seconds-old commit the
instant it was unreferenced; measured.)

## Coverage rules

The design rule is that **declared partial coverage beats silent partial
coverage**. Everything below was decided from measurement, not assumption; see
`spike/DECISIONS.md`.

| what | rule | why |
|--|--|--|
| `.gitignore` | track {project's tracked set} ∪ {non-ignored} ∪ {paths the agent touched via `write`/`edit`} | ignore rules are relative to an existing index; a fresh one drops files the project tracks — 1,365 of them in linux. Bash writes into ignored dirs carry no path and are not captured |
| `.git/info/exclude` | mirrored into the shadow's `info/exclude` at init | invisible to the shadow otherwise (GIT_DIR points elsewhere): a repo-local excluded build cache would be swallowed whole into the store — measured |
| `.gitattributes` | `$GIT_DIR/info/attributes` sets `* -text -diff -filter -crlf -working-tree-encoding -ident` | it outranks in-tree rules; without it `text=auto eol=lf` stores CRLF as LF, `filter=lfs` stores a pointer, and `* ident` squashes `$Id: … $` to `$Id$` |
| nested repos | one shadow repo each, recursive, capped at 32; repos appearing after prime (`git clone` mid-session) are detected from the root diff and declared unprotected | git refuses to stage inside them (`Pathspec ... is in submodule`), so a parent-only snapshot silently misses every edit there |
| hardlinks | restore content and mode by truncate/chmod in place, keeping the inode | `checkout-index` gives the file a new inode and leaves siblings holding stale content |
| symlinks | no special handling inside the project; resolved to their target outside it | git restores file, dir and dangling links correctly, and does not write through them |
| outside the project | separate content store, keyed by absolute path, fed only by `write`/`edit`; capped at 64 paths × 8 MiB; deny list and credential-shaped names refused; restore is its own confirmation | there is no directory above a project that is safe to `git add -A`, but edits out there still happen — and an absolute path in the force-track list made `git add -f` fatal, which failed the *whole* checkpoint |
| case collisions | detect, declare, refuse | on APFS/Windows the pair is one file; restoring either overwrites the other, with no error from git |
| type changes | separate confirmation; materialize promised replacement before atomically moving the current path, rollback on install failure | `checkout-index -f` will `rm -rf` a directory before proving the replacement can be installed |

`/rewind → coverage report` lists everything currently unprotected.

## Files outside the project

A second mechanism, deliberately not a bigger repo. Blobs under
`~/.pi/agent/rewind/<hash(project)>/outside/<sha>`, mode 0600, pruned by age.

Capture is in `tool_call`, which pi awaits before running the tool
(`agent.beforeToolCall`), so the blob is the pre-write content. That baseline
is then back-filled into every existing checkpoint that has not already
recorded the path — before this write, that is what the file looked like at
each of those points — which is what makes a rewind to *any* earlier node
restore it, not just the most recent one. `absent` is a recorded state, so a
file the agent created is removed on rewind rather than silently left behind.

Where `eligibility.ts` refuses the directory outright (`~`, `Downloads`, a
folder with no project marker), this store becomes the entire mechanism:
`state.ws` stays null, checkpoints carry an empty shadow snapshot, and every
path a `write`/`edit` names goes to the store instead of to `forceTrack`. The
trade is stated rather than hidden — the directory is not snapshotted, so a
bash command out there is not covered — but refusing to stage `~` is not a
reason to protect nothing in it.

The path is resolved (`realpath` of the deepest existing ancestor) *before* the
deny list is applied. Without that, an alias walks straight round it:
`~/.Claude Code` is a symlink to `~/.pi`, and a string match on `~/.pi` never
sees `~/.Claude Code/agent/auth.json`. Resolving also means a symlink is
tracked as its target, so restoring writes to a real path instead of through a
link.

## Restore

```
1. snapshot the worktree now              → this is the undo point in /rewind
2. diff now..target                       → O(changed files), not O(repo)
3. classify: restore | delete | type-change | unprotected
4. preview, then apply
     bulk        git checkout-index from the target tree (private index)
     hardlinked  write/chmod the blob in place
     type change only after confirmation; pre-materialize then swap/rollback
     outside     only after its own confirmation, written in place
     unprotected never
```

After confirmation, Apply and Undo re-snapshot/re-plan under the same lock as
the writes, making intervening same-type edits the exact reverse point. They also
re-check on-disk shape before every bulk checkout, delete, or in-place write; any
newly detected type change is skipped until separately confirmed. Cancelling a preview preserves the prior undo. Persisted outside
entries are canonicalized through the current deny list and strict SHA/mode
schema before planning. The disk may have changed while the confirm dialog sat
open, and Node's
`rmSync`/`writeFileSync` follow a symlinked parent straight out of the
worktree (git's own writers are immune; reproduced with the Node ones). A
mismatch is refused and reported, never guessed at.

## Not covered

- `/share` does not upload the shadow store; it is a sidecar, not part of the
  session JSONL.
- A prompt issued during the cold prime of a very large repo is not
  checkpointed. It is reported, not hidden.
- Pi's `compact()` cannot pin an exact cut entry from a command context, so
  "summarize from/up to here" passes custom instructions only. The
  `session_before_compact` hook can return `firstKeptEntryId`, so exact parity
  is reachable if it ever proves worth it.
- `Esc Esc` opens `/tree`, and the `session_before_tree` hook offers the
  restore menu there, so it already works. A dedicated `doubleEscapeAction:
  "rewind"` would only swap the tree for a flat prompt list — which is Claude
  Code's limitation, not a feature — and would require patching a built file
  inside `node_modules` that every `pi update` overwrites. Deliberately not done.
