# pi-tree-rewind

Worktree checkpoints for [Pi](https://pi.dev). Rewind **code**, **conversation**,
or both — from any node in the session tree, not just backwards along a list.

Backed by shadow git repos that never touch your project's `.git`. The original
before-only backend measured **228 ms** per checkpoint on the linux kernel
(94.8k files). Version 0.4 adds pre-write protection and an internal after snapshot;
that historical benchmark is not a measurement of the upgraded end-to-end cost.

## Install

This package is bundled by `duy-tung/pi-setup` under
`extensions/tree-rewind/`. Run the setup repository's `./install.sh`; Pi loads
`src/index.ts` from this package manifest automatically. Use `/reload` after
applying source changes.

The standalone repository at commit `65fa4fa` is retained only as historical
provenance; a new machine does not need to clone it.

## Use

Use `/tree` to navigate the conversation (the extension offers to bring the
worktree along), or `/rewind` to manage file checkpoints: restore code only,
undo the last file restore, or inspect coverage. `⏺` marks prompts that have a
checkpoint; only that exact user entry offers code restore. Assistant/tool nodes
and uncheckpointed prompts never substitute an ancestor's before-state. `Esc Esc` on an empty
input is Pi's own `/tree` (`doubleEscapeAction`), which reaches the same restore
menu.

```
Rewind files (2 restore, 1 delete, 1 replace · +9 −48, 1 uncounted):

  restore   src/auth.ts      +3 −41
  restore   src/session.ts   +6 −7   (in place: hardlinked)
  restore   assets/logo.png  (binary)
  delete    src/scratch.ts   −27
  REPLACE   build/           directory with 84 file(s) → file
```

Counts read current → target, so `+` is what applying adds. They come from
`git diff --no-index --numstat` over the current bytes and the checkpoint blob
(the shadow repos declare `-diff`, so their own numstat cannot be used), are
bounded to 1 MiB per side and 200 files per preview. Current bytes are read through
a no-follow descriptor, with a bounded read even if the file grows after stat.
Counts are best effort: binary, oversized, symlink, unreadable
and missing-blob entries are listed as uncounted rather than guessed, and a
failed count never blocks the restore. Totals in apply notifications are labelled
**preview estimates**: equal file counts do not prove equal paths or bytes after
the locked re-plan. Restored/deleted file counts are actual apply results.

`Compact, focusing on this prompt` runs Pi's ordinary compaction with the
selected prompt as the summary's focus. Pi chooses the cut point from its token
budget; the extension cannot pin it, so Claude Code's "summarize up to / from
here" is not offered.

Type changes need a second confirmation, including during Undo, in both
directions: a directory where the checkpoint has a file, and a file where the
checkpoint has a directory (the restores beneath it are gated with it). Apply
re-snapshots and re-plans under the write lock after confirmation, so same-type
edits made while the dialog is open become the exact next Undo point. Consent is
bound to the items the dialog listed: a type change or outside path that appeared
after the dialog is skipped and reported, never swept in by the earlier "yes".
Every ordinary checkout path is also revalidated after the preview, the promised
blobs are verified intact before anything is published or written, and the
activity check is repeated under the lock immediately before the first write. A promised file/symlink
replacement is materialized beside the current path before the current directory
is moved; a missing/corrupt snapshot leaves the directory untouched. A target
that is truly absent still means confirmed deletion. Cancelling a preview does
not replace the previous Undo point. For project files first named by `write` or
`edit`, the checkpoint also back-fills Unix permission bits that Git cannot store,
so restoring a private `0600` file does not recreate it as `0644`.

`/rewind → coverage report` describes known workspace gaps (including which
`.gitignore`d paths were present but not copied); it is reachable before the
first prompt. Each restore preview also reports paths whose original state is
unknown, target paths that collide by case with each other, and paths that are
now hardlinked together but have different checkpoint targets.

Inside Pi's own `/tree` and `/fork` dialogs the host reports itself busy for
the duration of the navigation; the extension does not mistake that for an
active response (Pi already refuses to navigate while one runs), but the
background-activity check still applies.

### First-touch safety

Before a named project `write`/`edit`, the extension captures an ignored file's
pre-write contents and permission bits into the **current prompt's** checkpoint.
It does not rewrite older project checkpoints with newly discovered contents.
Backfill only supplements unknown coverage: a file created by bash after a known
pre-prompt absence stays absent in that checkpoint. Each new checkpoint records
absence for previously named paths too, including deleted ignored files.
Explicit absence is distinct from unknown coverage: ambiguous deletions from
legacy or incompletely covered checkpoints are skipped, not guessed. Ignored
names are inventoried without copying every ignored file. Tracking survives reload
and deletion/recreation. Failure to publish the preimage blocks the tool.
If Git reports incomplete indexing, the guarded checkpoint/restore capture is
refused: omitted files and stale index blobs must not masquerade as a before-state.
Raw backend snapshots retain their historical partial-capture behavior.

This is not time travel: bash/manual edits made before the first named touch of an
ignored file cannot be reconstructed. Regular eligible worktree contents still
use the pre-prompt snapshot. Existing outside-file tracking retains its first-touch
baseline convention; it cannot prove what an untracked outside file contained at
older prompts.

### Durable Undo and interrupted restores

The existing **↩ Undo last rewind** now survives reload/restart for that session.
After a combined fork/restore, Undo belongs to the parent that performed the file
restore; the child does not inherit that Undo destination.
Before any restore write, immutable before/target refs and a private journal are
published under the same project lock. Content, permissions and Undo promotion
finish under that lock. A failed/interrupted restore keeps its retry destination.

Reload **never replays files automatically**. A pending journal blocks another
file rewind; use the existing Undo entry, review the current preview, and confirm.
Recovery refuses managed changes made after that preview and asks for a fresh one.
Every outside Undo target is validated even if planning classified a missing blob
as unprotected. Missing/corrupt targets refuse all writers and retain the original
Undo. A skipped managed Undo target keeps its destination and journal retryable.
Coverage-only warnings for never-checkpointed nested repositories remain visible,
but do not prevent completed Undo or no-op recovery.
After SIGKILL, the existing conservative lock policy still requires manual lock
resolution (see Concurrency). Malformed or conflicting private state fails closed
and is preserved. Undo history from pre-0.4 RAM-only versions cannot be recovered.

A current outside path that cannot be captured (for example a directory or an
oversized file) is not overwritten without a reversible preimage: preserve/resolve
it first. Missing/corrupt outside blobs also stop the affected restore before writes.
The guarantee is **process interruption/reload**, not power-loss durability, a
filesystem-wide transaction, or exclusion of arbitrary external writers.

### Internal operation snapshots

An after snapshot is recorded at `agent_settled`, after automatic retries and
continuations, or at the next queued user-prompt boundary. It is a private,
per-session observation—not a new tree node, menu item or restore target. The
checkpoint's before snapshot and navigation ancestry remain unchanged. A new run
waits for an in-flight observation; generation changes invalidate stale work.
Forks retain before targets but start their own private operation history. Failed
after capture leaves the before checkpoint intact; coverage/retention limits still
apply, and independently running writers are not frozen by an observation.

## Versus Claude Code

| | Claude Code | this |
|--|--|--|
| navigation | flat list of prompts | any node in the session tree |
| granularity | `Write`/`Edit` only | whole worktree |
| bash: `sed -i`, codegen, formatters | not rewound | rewound (unless `.gitignore`d) |
| bash into ignored dirs (`npm install` → ignored `node_modules/`) | not rewound | **not rewound either** — declared, only `write`/`edit` paths are force-tracked |
| `write`/`edit` outside the project | rewound, silently | rewound, but as a separate confirmation |
| symlinked target outside the project | skipped since v2.1.216 | resolved and rewound |
| `.env`, `~/.ssh`, `~/.aws` outside the project | rewound like any other file | refused, and the refusal is listed |
| nested repos / submodules | not rewound | one shadow repo each |
| `+/−` per file before restoring | no | yes, bounded and best effort |
| summarize up to / from a prompt | yes | no — Pi's compaction cannot pin a cut point; `Compact, focusing on this prompt` instead |
| point-to-point diff / one-file cross-branch restore | no | backend-only; no command or UI |
| your `.git` | untouched | untouched |

## Concurrency

Cooperating Pi snapshot/restore operations in the same directory are serialized:
an owner-token advisory lock protects snapshots and restores, and a former holder cannot remove a successor's
lock. Pi owns hosted shutdown: rewind installs **no process signal/exit cleanup**
there. It stops new work, cancels queued acquisition and cold prime, then drains
accepted backend jobs (including metadata publication) before releasing leases.
An open menu/confirmation is not a backend job; late replies cannot act on a new
session. Cold workspaces/leases are published only after successful prime and a
generation check. Standalone helpers drain held writers on catchable signals;
normal completion releases locks, but forced `process.exit`, SIGKILL or a crash
leave uncertain locks in place. There is intentionally no racy automatic stale
takeover: after forced exit/crash, the exact lock path in the
error must be removed manually only after confirming no Pi session or leftover writer uses the
project. Managed background activity also blocks restores; arbitrary editors and
other non-cooperating writers are not excluded. In-place hardlink writes affect
all sibling links, including siblings outside the project—this is not a sandbox.
Without locking, measured, two processes taking 8 checkpoints each lost
13 of 16 — silently, recording empty snapshots as valid checkpoints. Worktree and outside-file
checkpoint/apply paths use the same store lock; projectless outside state uses it too.
Lock timeouts bound acquisition only; work already holding the lock is not given a
false deadline. Git defaults to a 120-second termination deadline and 64 MiB
captured-output cap. Cancellation/deadline sends SIGTERM, then SIGKILL after one
second if needed, but the promise still waits for actual child closure. This can
delay shutdown; signalling alone is not proof that a writer has stopped.

## Disk

Maintenance bounds old sessions while you keep using a project: after backend
drain, session end drops checkpoints past 20 sessions or 30 days, then repacks.
Shutdown maintenance and lease release use nonwaiting lock acquisition; contention
skips the work (retaining an uncertain lease), not an in-flight writer. Once
maintenance acquires the lock, shutdown awaits its actual completion. Count pressure never removes
a session active within the previous 24 hours; if an already-missing parent is
encountered, the next checkpoint recovers as a new shadow root. This is not a hard byte cap
for one very long current session—its referenced checkpoints remain live even above
the 2 GiB GC trigger. Start a new session when a long task no longer needs every
old rewind point.

Unfinished recovery journals pin their sessions and outside blobs, even if the
project disappears. Unsafe recovery metadata disables pruning. Completed Undo
follows normal session retention; projectless completed Undo follows the 30-day
outside-store age policy, excluding the current session and recently updated
checkpoint state. Ordinary outside checkpoint/after blobs can still age out.
Private checkpoint state is bounded to 64 MiB per session and recovery records to
4 MiB; exceeding a bound fails closed rather than publishing incomplete metadata.

That leaves the case it cannot reach — a project you never open again.
Measured: opening pi in a 7.4k-file project and quitting *without typing a
prompt* left 44 MB of staged blobs under a shadow repo with zero refs, and no
later session would ever run maintenance on it. So stores record which project
they belong to, and every session start sweeps `~/.pi/agent/rewind` for ones
that hold no restorable state: no refs, outside blobs, private checkpoint/recovery
records or session leases. A missing project may be renamed or unmounted and
**never** authorizes deletion by itself. Normal per-session maintenance owns
metadata retention; the whole-store sweep conservatively retains uncertainty.

Only after 24 hours untouched, never with any existing lock (including a stale
one), never the running session's store, and only for real directories named like
a store. The sweep acquires the store lock without waiting, checks references
under it, then atomically renames an empty store out of its namespace before
removing it. A failed removal leaves a `.reaping-*` quarantine for inspection,
never a half-deleted live store. Symlinks, unreadable/unexpected entries and scan
limits retain the store. The sweep uses metadata and bounded marker/ref reads,
without Git.

## What is not protected

Rather than pretend to cover everything, the extension measures what it cannot
and says so:

- paths that differ only by case, on a case-insensitive filesystem — they are
  one file on disk, so restoring either would overwrite the other
- nested repos beyond the cap of 32 or five nested levels (listed as skipped)
- outside the project root: only files a `write`/`edit` names, capped at 64
  paths of 8 MiB each — a bash command out there is not covered, and neither is
  a path the guard refuses (see below)
- a prompt issued while a very large repo is still being indexed (bounded at
  2 s, then reported)

## Files outside the project

The shadow repos stop at the worktree, so a second mechanism covers files an
edit tool names elsewhere: content-addressed blobs keyed by absolute path,
captured in `tool_call` before the write lands.

Restoring them is always its own confirmation — "restore my project" is not
consent to rewrite a file in a home directory — and these are refused outright,
listed under `/rewind → coverage report`:

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gcloud`,
  `~/.pi`, `~/.claude`, `Library`, `/dev`, `/proc`, `/sys`
- credential-shaped names: `.env*`, `.netrc`, `.npmrc`, `id_*`, `*.pem`,
  `*.key`, `credentials.*`
- anything over 8 MiB, or past the 64-path cap

Paths are resolved before those rules are applied, so an alias cannot walk
round them. Persisted session entries are revalidated against the current deny
list, strict SHA/mode schema, and a private on-disk registry of paths that this
extension actually captured before they can form a restore plan. Older outside
entries created before this registry existed fail closed after upgrade and must be
captured again:  `~/.Claude Code` is a symlink to `~/.pi` on the author's machine,
and `~/.Claude Code/agent/auth.json` is refused as `inside ~/.pi`.

## Where there is no project

In `~`, `Downloads`, or anything else `eligibility.ts` refuses to stage, the
same per-file store becomes the whole of rewind: the directory is never snapshotted, but
every path a `write`/`edit` names is tracked individually, under the same deny
list and the same 64-path cap. That is Claude Code's model, and the only
honest one when `git add -A` is off the table — previously these directories
got no code rewind at all.

The status line says which mode you are in:

```
◆ 12 checkpoints, 2 outside     project, worktree snapshotted
◆ 3 files tracked               no project, per-file store
(nothing)                      no project, nothing edited yet
◆ rewind off (inside ~/.ssh)    nothing here can ever be tracked
```

The last two both mean zero tracked files and are opposite facts: in `~` the
next edit is covered, in `~/.ssh` no edit ever is. Only the one worth acting on
gets a line.

## Development

```bash
npm test           # backend, preimages, recovery, retention, operations and UX
npm run test:hazards   # the git-behaviour probes the design rests on
npm run bench -- ~/some/big/repo
npm run spike -- ~/some/big/repo   # standalone measurement + hazard report
```

Restore tests use disposable HOME/workspaces; never run backend fixtures against
your real HOME (their cleanup removes its rewind store). The recovery suite uses
a real SIGKILL child and explicitly removes only that dead child's fixture lock.
The UX suite is a mock-host contract test, not a terminal-keypress test.

`spike/README.md` has the historical measurements behind the design and
`spike/DECISIONS.md` the reasoning for each coverage rule. Both are worth
reading before changing the backend: several obvious-looking implementations
corrupt data silently.
