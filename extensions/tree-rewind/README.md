# pi-tree-rewind

Worktree checkpoints for [Pi](https://pi.dev). Rewind **code**, **conversation**,
or both — from any node in the session tree, not just backwards along a list.

Backed by shadow git repos that never touch your project's `.git`. A checkpoint
on the linux kernel (94.8k files) costs **228 ms**, taken while the model is
thinking.

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
checkpoint.

```
Rewind files (2 restore, 1 delete, 1 replace):

  restore   src/auth.ts
  restore   src/session.ts   (in place: hardlinked)
  delete    src/scratch.ts
  REPLACE   build/           directory with 84 file(s) → file
```

Type changes need a second confirmation, including during Undo. Apply re-snapshots
and re-plans under the write lock after confirmation, so same-type edits made while
the dialog is open become the exact next Undo point. Every ordinary checkout path
is also revalidated after the preview. A promised file/symlink
replacement is materialized beside the current path before the current directory
is moved; a missing/corrupt snapshot leaves the directory untouched. A target
that is truly absent still means confirmed deletion. Cancelling a preview does
not replace the previous Undo point.

`/rewind → coverage report` lists what is *not* protected. That list is the
point — see below.

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
| diff two points | no | `git diff`, ~5 ms |
| your `.git` | untouched | untouched |

## Concurrency

Two pi sessions in the same directory are safe: an owner-token advisory lock
serialises snapshots and restores, and a former holder cannot remove a successor's
lock. Normal exit and catchable signals clean it up. There is intentionally no
racy automatic stale takeover: after SIGKILL/crash, the exact lock path in the
error must be removed manually only after confirming no Pi session uses the
project. Without locking, measured, two processes taking 8 checkpoints each lost
13 of 16 — silently, recording empty snapshots as valid checkpoints. Worktree and outside-file
checkpoint/apply paths use the same store lock; projectless outside state uses it too.

## Disk

Maintenance bounds old sessions while you keep using a project: session end drops
checkpoints past 20 sessions or 30 days, then repacks. This is not a hard byte cap
for one very long current session—its referenced checkpoints remain live even above
the 2 GiB GC trigger. Start a new session when a long task no longer needs every
old rewind point.

That leaves the case it cannot reach — a project you never open again.
Measured: opening pi in a 7.4k-file project and quitting *without typing a
prompt* left 44 MB of staged blobs under a shadow repo with zero refs, and no
later session would ever run maintenance on it. So stores record which project
they belong to, and every session start sweeps `~/.pi/agent/rewind` for ones
that can no longer become useful:

- the project directory is gone
- the store holds no checkpoint at all — no refs, no blobs

Only after 24 hours untouched, never while a session holds the lock, never the
store of the running session, and only for directories named like a store. The
sweep is stat-only: no git process, nothing to wait for.

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
same per-file store becomes the whole of rewind: nothing is snapshotted, but
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
npm test           # 96 backend integration assertions, all hazard classes
npm run test:hazards   # the git-behaviour probes the design rests on
npm run bench -- ~/some/big/repo
npm run spike -- ~/some/big/repo   # standalone measurement + hazard report
```

`spike/README.md` has the measurements behind the design and
`spike/DECISIONS.md` the reasoning for each coverage rule. Both are worth
reading before changing the backend: several obvious-looking implementations
corrupt data silently.
