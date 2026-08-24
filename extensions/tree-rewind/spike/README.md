# Spike: shadow-git as the checkpoint backend

Answers one question before v0.3 commits to an architecture:

> Can a shadow git repo snapshot someone else's worktree **fast enough** and
> **completely and byte-exactly enough** to back per-node worktree checkpoints?

```bash
node spike/shadow-git-spike.mjs <repoPath> [--force-all] [--full-restore]
                                           [--sample N] [--new-files N]
                                           [--no-attr-override] [--no-seed]
                                           [--keep] [--json out.json]
```

Non-destructive. It appends a marker to 3 small tracked text files to measure a
realistic incremental snapshot, then rewrites their exact original bytes and
verifies the sha256; it creates 3 throwaway files and deletes them. It never
touches the target's own `.git`.

## Results (M-series Mac, APFS case-insensitive, git 2.53)

| | linux | vscode | terminal | ~/go |
|--|--|--|--|--|
| files / size | 94,843 / 1.50 GB | 17,877 / 240 MB | 3,673 / 74 MB | 91,699 / 1.96 GB |
| cold `add -A` | 46.5 s | 7.4 s | 1.6 s | 34.8 s |
| delta-seed | 1.5 s | 25 ms | 47 ms | – |
| warm snapshot | **212 ms** | **84 ms** | **23 ms** | **502 ms** |
| **full commit cycle** | **224 ms** | **112 ms** | **31 ms** | **376 ms** |
| tree↔tree diff | 5 ms | 5 ms | 5 ms | 4 ms |
| per file restored | 0.18 ms | 0.16 ms | 0.12 ms | 0.69 ms |
| shadow store | 1.51 GB | 239 MB | 68 MB | 1.30 GB |

**Verdict: shadow git wins.** A checkpoint costs 31–376 ms even on a 95k-file
kernel tree, and the worktree is idle while the LLM thinks, so the cost is fully
hideable. Restore is diff-driven and therefore O(changed files) — the 13.9 s
full-tree checkout is a path production never takes.

Config that matters: `core.compression=0` (25% faster cold, ~50% more disk),
`core.fsync=none`, `index.version=4`, `core.untrackedCache=true`, `gc.auto=0`.

For contrast, measured on the same 91k tree: APFS `clonefile` via `cp -c -R`
costs **11.8 s every time** — it is a per-file syscall, not an O(1) directory
snapshot, and has no incremental path. The common advice that CoW clone is the
fast option is wrong at this scale.

## Finding 1 — `.gitignore` alone silently drops tracked files

Git never ignores a file it already tracks, so `.gitignore` semantics are
*relative to the existing index*. A fresh shadow index tracks nothing, so ignore
rules apply to everything — **including files the target repo tracks**.

In linux.git on a case-insensitive filesystem, the rule `*.s` swallows **1,365
tracked `.S` assembly files**. They would never be checkpointed and never
restored. The same class of bug hits any repo that tracks a file matching its
own ignore rules (a committed `dist/` bundle, a pinned lockfile, …).

Fix, measured: after `git add -A`, diff the shadow index against the target's
own `git ls-files -z` and `git add -f` only the delta.

```
add -A            46.9 s   93,491 captured   1,365 tracked files lost
delta-seed        +1.5 s   94,843 captured   13 lost (case collisions)
full forced seed  117.6 s  same result as delta-seed
```

Run with `--no-seed` to see the gap.

## Finding 2 — in-tree `.gitattributes` silently corrupts content

`$GIT_DIR/info/attributes` outranks every `.gitattributes` in the worktree.
Without it, a CRLF file under `* text=auto eol=lf` is stored as LF and **every
restore silently corrupts it**. vscode ships 11 such rules, including
`*.sqlite filter=lfs` — an LFS filter would replace file contents with pointer
text. Writing

```
* -text -diff -filter -crlf -working-tree-encoding
```

into `$GIT_DIR/info/attributes` makes capture byte-exact. `--no-attr-override`
reproduces the corruption:

```
byte-exact  ✗ 2/4 MISMATCH
  ! src/win.txt (6B disk vs 4B stored)
```

Hermetic env (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) keeps the
user's global config — including their LFS filter definitions — out of the
capture path.

## Ignore policy, verified

`git add -A` in the shadow repo honours the target's `.gitignore`, and
`git add -f <path>` forces single ignored paths back in. That validates the
hybrid policy: track {target's tracked set} ∪ {non-ignored files} ∪ {paths the
agent touched via the `write`/`edit` tools}, without swallowing `node_modules`
into every snapshot. The limit of that third set: bash writes carry no tool
path, so `npm install` into an *ignored* `node_modules/` is not captured —
the extension declares this rather than implying coverage.

## Open issues this spike surfaced

- **Case-only path collisions.** linux.git has 13 pairs like
  `xt_CONNMARK.h` ↔ `xt_connmark.h`. On APFS/Windows they are one file;
  restoring either overwrites the other. Must be detected and refused, not
  silently mishandled.
- **Nested repos / submodules** are recorded as gitlinks; their *contents* are
  not snapshotted. Verified with a fixture. Needs an explicit v0.3 decision.
- **Symlinks**: 99 in linux, 1 in vscode. Restore must recreate the link, not
  materialise the target.
- **Hardlinks** (`nlink > 1`) cannot be restored by rewrite without breaking
  the link.
- `write-tree` costs 3.0 s cold on 95k files but 26 ms warm (cached trees).

## Self-tests

Three fixtures the spike is checked against, each asserting a hazard it must
catch:

| fixture | asserts |
|--|--|
| `* text=auto eol=lf` + CRLF files, `--no-attr-override` | reports 2/4 byte-exact MISMATCH |
| same fixture, guard on | reports byte-exact ✓ |
| vendored repo with its own `.git` | reports the gitlink hazard |

## Next

Run against the largest monorepo you actually work in. The corpus here has no
LFS-materialised objects and no live submodules; a real monorepo may have both.
