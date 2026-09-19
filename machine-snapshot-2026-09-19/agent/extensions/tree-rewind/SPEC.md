# Worktree checkpoints for Pi

Claude Code rewinds a flat list of prompts. Pi has a real session *tree*, so
this aims one step further: **the worktree is a function of the node you are
standing on.**

## Model

Each user prompt gets a checkpoint of the whole worktree, taken *before* the
agent acts, bound to the user message id. The checkpoint is a commit in a
shadow git repo whose parent is the point we last stood at. Its before-checkpoint
ancestry follows the session tree (private safety/operation refs also exist):

```
session   P1 ── P2 ── P3            shadow   c1 ── c2 ── c3
                └──── P4                           └──── c4

navigateTree(X) → conversation = path(root→X) + worktree = restore(commit(X))
```

Capabilities exposed by the current command and tree hooks:

- rewind conversation and files to a listed user prompt, including one on another branch
- preview all affected files before applying, with best-effort `+/−` line counts
  per restore/delete item (`git diff --no-index --numstat` over current bytes and
  the target blob; ≤ 1 MiB per side, ≤ 200 files; binary/large/symlink/missing are
  reported as uncounted, never guessed), then undo an applied rewind
- code restore options require the exact checkpointed user entry; assistant/tool
  nodes and uncheckpointed prompts never fall back to an ancestor's before-state
- line totals in apply notifications remain labelled preview estimates; equal
  file counts do not prove that the locked re-plan applied identical bytes
- point-to-point diff and one-file cross-branch restore are backend capabilities only;
  no command or UI currently exposes them
- bash is covered for everything `.gitignore` does not hide: `sed -i`, codegen
  and formatters land in the snapshot because the whole worktree does. Inside
  *ignored* directories only paths touched via the `write`/`edit` tools are
  force-tracked — bash writes there carry no tool path, so `npm install` into
  an ignored `node_modules/` is **not** captured. A declared gap, not an
  accident.

## Private operation observations

The user-facing target remains `PromptCheckpoint.snapshot`, the before-prompt
snapshot. A private optional `after` stores a bounded snapshot/outside/mode/unknown
observation with an immutable `op-UUID` ref. `agent_settled` completes the current
operation; a newly persisted queued user prompt first closes the preceding prompt's
boundary. Intermediate `turn_end` does not close it. After capture does not move
`state.head`, add commands/options, or append a session JSONL entry.

The next `before_agent_start` awaits an in-flight capture: Pi exposes idle before
awaiting settled extension handlers. Generation, checkpoint identity, head and
recovery-revision checks reject stale publication. An explicit file restore
supersedes a pending observation. Failure retains the original before checkpoint.
After metadata is private per session; it is not copied into a fork's JSONL.
These are observations of managed contents, not a freeze of external/background
writers or proof that every file in the directory was captured.

## Storage

One shadow repo per worktree under `~/.pi/agent/rewind/<hash(project)>/`,
keyed by project rather than by session, so the expensive first snapshot is
paid once per project and later sessions start warm (~60 ms).

It never touches the project's own `.git`: no `git reset`, no rewritten
commits, no staged changes. `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
point elsewhere and `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL=/dev/null` keep
the user's config — including any git-lfs filter — out of the capture path.

Historical measurements of the original before-only backend (M-series Mac,
APFS, git 2.53); not remeasured for the 0.4 protection/recovery/after pipeline:

| | linux 94.8k files | vscode 17.9k | terminal 3.7k |
|--|--|--|--|
| prime (once per project, background) | 42.3 s | 6.4 s | 1.7 s |
| **checkpoint** | **228 ms** | **105 ms** | **31 ms** |
| build restore plan | 6 ms | 5 ms | 5 ms |
| apply | 239 ms | 143 ms | ~30 ms |

The pre-prompt checkpoint is awaited at `turn_start` after the user entry is
persisted, before the model/tools act. Cold priming starts in the background.

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
restore-apply and maintenance. Only the current owner may release it. Hosted
lifetimes install no process signal/exit cleanup: Pi owns termination. Shutdown
closes admission, cancels queued locks and cold-prime Git, then drains complete
accepted backend jobs before final index publication. UI dialogs are not drain
jobs, and generation/lifetime guards suppress their late replies and UI updates.
Before-checkpoint Git and private metadata publish under one transaction lock.
A workspace and its per-instance session lease publish together only after prime
and a generation check; marking/releasing leases also holds the store lock.
Standalone helpers install handlers only while holding locks and drain writers on
catchable signals. Forced exit/crash retains uncertain locks. There is
no automatic stale takeover: POSIX cannot compare-and-unlink, so a contender can
judge dead lock A stale and accidentally remove newly acquired live lock B.
After SIGKILL/crash, operations fail closed with the exact path for manual removal
after confirming no session owns it. Root initialization, worktree/outside checkpoints, restores, projectless outside
state, and maintenance all use that store lock. Restores go through a private
throwaway index, so a concurrent snapshot can never rewrite the index between `read-tree` and
`checkout-index`. Git failures throw instead of degrading into an empty
result: any `add` failure beyond unreadable individual files aborts even a raw
backend snapshot. Guarded frontend captures also reject partial indexing (including
warnings), because omitted files imply unknown absence and retained index blobs may
contain *previous* contents. They must not become a valid checkpoint or Undo. On the hot path a snapshot waits at most 5 s for the lock,
then declares the prompt unprotected. 3 processes × 8 checkpoints on vscode:
24/24 succeed in 2.4 s (historical measurement).

The lock coordinates cooperating store operations, not arbitrary filesystem
writers. Package-reported background activity blocks restores. In-place hardlink
restores also affect sibling links outside the project; path checks and outside
confirmation do not provide an OS sandbox.

## Maintenance

`gc.auto` is 0, so nothing repacks on its own. At session shutdown the store
prunes checkpoint refs for sessions beyond 20 kept or 30 days old, then repacks
if anything was pruned, loose objects exceed 5,000, or the store exceeds 2 GB.
The 2 GB threshold triggers GC, not a hard cap: current-session refs remain and a
single very long session can exceed it until that session ages out. Everything worth keeping carries a ref — including the undo point exposed through `/rewind` — and the
ref is written inside the snapshot lock, so no commit is ever visible
unreferenced. Shutdown maintenance has zero-wait acquisition (busy means skip),
using a separate hosted lifetime after ordinary admission closes. Once acquired,
it drains to completion; a timeout is never treated as proof of writer termination.
Contended lease release conservatively retains the lease. Maintenance itself runs
under the store lock and prunes with a 30-minute grace (`--prune=30.minutes.ago`): a parallel session's in-flight
objects are never collected. (`--prune=now` deleted a seconds-old commit the
instant it was unreferenced; measured.)

Unfinished recovery sessions are exempt from retention, including outside-only
journals and missing projects. Malformed/unreadable recovery metadata prevents
pruning. Completed Undo follows ordinary workspace session retention; its timestamp
counts toward recency. Projectless completed Undo follows outside blob age, excluding
the current session and newer checkpoint/record activity. Normal outside checkpoint
and operation-observation blobs may age out; Undo/journal blobs remain pinned.

Whole-store sweeping is stricter: missing origins never authorize deletion. It
retains refs, blobs, private metadata, leases, any lock, and unreadable/symlinked
or otherwise uncertain state. Eligible ref-less stores are checked under a
nonwaiting exclusive lock and atomically renamed before recursive removal, so a
new writer cannot enter a half-deleted namespace. Per-session maintenance owns
metadata retention; failed removals leave a `.reaping-*` quarantine.

## Project first-touch coverage

New checkpoints inventory ignored names (bounded to 4,096 entries, otherwise
root-unknown) without copying all ignored contents. A named `write`/`edit` patches
only the current checkpoint's owned shadow with the immediate pre-write file or
symlink, mode, and explicit absence. It never retroactively asserts newly observed
project contents at every older checkpoint. Older/missing coverage is unknown, not
proof of absence: ambiguous delete/type-to-absence actions become unprotected.
Backfill only supplements unknown coverage: known pre-prompt absence remains absent
if bash creates a file before a later named edit. Every guarded capture records
explicit absence for previously named paths under the same snapshot lock, including
Undo preimages. Force-tracked paths persist across reload and are re-staged after
recreation. Bash/manual edits of unknown files before first named touch remain
outside this guarantee.

Private checkpoint JSON is authoritative when its revision is newer than the
JSONL index; at equal revision the later JSONL flush wins for before data, while
private-only after metadata is merged separately. Atomic pre-tool publication is
required, otherwise the tool is blocked. After rename, a sync/close error is marked
published: callers must preserve the new ref, not roll it back under a live pointer.
The file remains untouched and reload resolves the published revision.

The public JSONL index (custom `pi-rewind-cp`, version 5) is dirty-gated and
incremental: a `base` carries every before checkpoint; a `delta` carries only the
complete objects that changed plus removed IDs, chained by `parent` token. A base
is republished when the previous batch is not on the active branch (tree
navigation), when the session owner changes (fork child), or when no branch is
available; a fork whose branch skipped an older batch would otherwise lose that
checkpoint. Replay is file-ordered; legacy version 3/4 full arrays still load. A
delta whose parent is not the preceding batch applies its complete objects, skips
removals, and reports an incomplete chain. After-only changes never append.
Published objects are detached copies. Growth per new checkpoint is bounded by
that checkpoint's size except at the base exceptions above; private per-session
full-state writes remain O(N) and synchronous before tools.

## Coverage rules

The design rule is that **declared partial coverage beats silent partial
coverage**. Everything below was decided from measurement, not assumption; see
`spike/DECISIONS.md`.

| what | rule | why |
|--|--|--|
| `.gitignore` | track {project's tracked set} ∪ {non-ignored} ∪ {paths the agent touched via `write`/`edit`} | ignore rules are relative to an existing index; a fresh one drops files the project tracks — 1,365 of them in linux. Bash writes into ignored dirs carry no path and are not captured |
| `.git/info/exclude` | mirrored into the shadow's `info/exclude` at init | invisible to the shadow otherwise (GIT_DIR points elsewhere): a repo-local excluded build cache would be swallowed whole into the store — measured |
| `.gitattributes` | `$GIT_DIR/info/attributes` sets `* -text -diff -filter -crlf -working-tree-encoding -ident` | it outranks in-tree rules; without it `text=auto eol=lf` stores CRLF as LF, `filter=lfs` stores a pointer, and `* ident` squashes `$Id: … $` to `$Id$` |
| nested repos | one shadow repo each, recursive, capped at 32; repos appearing after prime (`git clone`, or `git init` over an already-indexed directory) are declared unprotected; a nested root that is no longer a real directory inside the project is refused | git refuses to stage inside them (`Pathspec ... is in submodule`), so a parent-only snapshot silently misses every edit there |
| hardlinks | restore content and mode by truncate/chmod in place, keeping the inode; paths now sharing one inode but promised different targets are refused together | `checkout-index` gives the file a new inode and leaves siblings holding stale content |
| symlinks | no special handling inside the project; resolved to their target outside it | git restores file, dir and dangling links correctly, and does not write through them |
| outside the project | separate content store, keyed by absolute path, fed only by `write`/`edit`; capped at 64 paths × 8 MiB; deny list and credential-shaped names refused; restore is its own confirmation | there is no directory above a project that is safe to `git add -A`, but edits out there still happen — and an absolute path in the force-track list made `git add -f` fatal, which failed the *whole* checkpoint |
| case collisions | detect, declare, refuse — in the current index at startup and in every target tree at plan time | on APFS/Windows the pair is one file; restoring either overwrites the other, with no error from git |
| type changes | separate confirmation in both directions (dir → file, file → dir); consent bound to the listed items; materialize promised replacement before atomically moving the current path, rollback on install failure | `checkout-index -f` will `rm -rf` a directory before proving the replacement can be installed |

`/rewind → coverage report` describes workspace gaps; the target-specific preview
also reports unknown/unprotected paths.

## Files outside the project

A second mechanism, deliberately not a bigger repo. Blobs under
`~/.pi/agent/rewind/<hash(project)>/outside/<prefix>/<sha>`, mode 0600, pruned by age
except when pinned for Undo/recovery.

Capture is in `tool_call`, which pi awaits before running the tool
(`agent.beforeToolCall`), so the blob is the pre-write content. That baseline
is then back-filled into every existing checkpoint that has not already
recorded the path. This retained outside-file convention uses first-touch state
for older prompts too; it is not evidence of historical contents before earlier
untracked manual/bash changes. `absent` is a recorded state, so a
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
1. snapshot the worktree now              → preview only; prior Undo stays intact
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
the writes, making captured intervening same-type edits the reverse point. They also
re-check on-disk shape before every bulk checkout, delete, or in-place write; any
newly detected type change is skipped until separately confirmed. Cancelling a preview preserves the prior undo. Persisted outside
entries are canonicalized through the current deny list and strict SHA/mode
schema before planning. The disk may have changed while the confirm dialog sat
open, and Node's
`rmSync`/`writeFileSync` follow a symlinked parent straight out of the
worktree (git's own writers are immune; reproduced with the Node ones). A
mismatch is refused and reported, never guessed at.

### Durable restore transaction

Private `recovery/<sha256(sessionId)>.json` records identity, monotonic revision,
Undo, and an optional pending/failed journal. Schema/path/registry checks and
bounded private JSON reads fail closed. Writes use a private temp file, file fsync,
and same-directory rename; checkpoint JSON is limited to 64 MiB and recovery JSON
to 4 MiB. These are process-interruption guarantees, not power-loss guarantees.

Inside `snapshot.lock`: validate current recovery revision and re-run the activity
check; capture current managed state; verify every promised project/outside blob is intact; pin immutable transaction before/target/previous-Undo refs; publish the
journal; write content/outside/modes; then publish the final Undo and clear the
journal. Failure keeps the retry target. Mutable legacy `undo` refs are compatibility
aliases, never authoritative over the private record. Unpublished temporary refs
are cleaned only when metadata proves they are not owned; uncertainty retains them.

Startup never replays files. Pending recovery blocks a new file rewind; the
existing Undo menu previews and explicitly confirms recovery. Changes to managed
state after that recovery preview require a new preview. Verified no-op recovery
can clear a journal. All outside Undo targets must remain intact, even when a
missing blob was classified unprotected by planning; refusal occurs before writers.
Skipped managed Undo targets remain retryable instead of retiring an incomplete
destination. Coverage-only diagnostics for nested repositories absent from the
target tuple are not managed targets: they remain visible but do not block Undo
completion, verified no-op recovery, or head advancement. A missing formerly managed
nested target is still required, not coverage-only.
Current outside
paths that cannot provide an authorized, intact preimage are refused before any
write, even if type replacement was confirmed. Preserve/resolve those paths first.

Undo remains per-session and reversible after successful use; cancellation preserves
its previous destination. A combined fork's file restore belongs to the parent;
the child's copied before-checkpoint history does not transfer the parent's Undo. A crash can leave the deliberately non-stealable store
lock; operator resolution is still required. No new slash command, tree option,
double-Escape action, or after-state navigation target is introduced.

## Not covered

- `/share` does not upload the shadow store; it is a sidecar, not part of the
  session JSONL.
- A prompt issued during the cold prime of a very large repo is not
  checkpointed. It is reported, not hidden.
- Pi's `compact()` cannot pin an exact cut entry from a command context, and
  `session_before_compact` can only cancel or supply a finished `CompactionResult`
  (which means reproducing `prepareCompaction` in the extension). So the menu
  offers `Compact, focusing on this prompt` — ordinary compaction with the prompt
  as the summary's focus — rather than promising Claude Code's "summarize up to /
  from here". "From here" (keep earlier, summarize the tail) has no representation
  in Pi's compaction model at all.
- `Esc Esc` opens `/tree`, and the `session_before_tree` hook offers the
  restore menu there, so it already works. A dedicated `doubleEscapeAction:
  "rewind"` would only swap the tree for a flat prompt list — which is Claude
  Code's limitation, not a feature — and would require patching a built file
  inside `node_modules` that every `pi update` overwrites. Deliberately not done.
