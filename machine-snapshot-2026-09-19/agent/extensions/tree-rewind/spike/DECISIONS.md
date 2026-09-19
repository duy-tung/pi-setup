# v0.3 decisions

Resolved empirically by `spike/hazards.sh` and `spike/hazards2.sh`. Each
decision cites the test that forced it.

Guiding rule: **declared partial coverage beats silent partial coverage.** Every
case below is one where the naive implementation looks like it works.

---

## 1. Case-only path collisions → detect, declare, never guess

**Evidence**

| test | result |
|--|--|
| A1 | `add -f inc/xt_CONNMARK.h` when only `xt_connmark.h` exists → index stays 1 entry. Delta-seed **cannot** inject a phantom path or wrong content. |
| A2 | A tree holding *both* cases, checked out on APFS → one file on disk, `LOWER` silently won, **exit 0, no warning**. |
| I | Detecting collisions over linux's 95k-file index costs **0.31 s**. |

Capture is safe; the damage is (a) one of each pair is simply absent from every
checkpoint, (b) a snapshot taken on a case-sensitive FS (CI, devcontainer,
remote) and restored on macOS/Windows loses one side without a word.

**Decision**

- At `session_start`, case-fold the target index and build an `unrepresentable`
  set. 0.31 s worst case, runs inside the async cold snapshot.
- Those paths are **excluded from checkpointing and declared**: status widget
  and `/rewind` preview both show `13 paths not protected (case collision)`.
- If the agent edits one, warn inline instead of implying it is covered.
- Before applying a restore, re-check the target tree for case-folded
  duplicates; refuse **those paths only**, never the whole restore.
- Do **not** set `core.ignorecase=false` to "fix" it — that breaks path
  handling on APFS generally.

---

## 2. Nested repos / submodules → recursive shadow repos

**Evidence**

| test | result |
|--|--|
| B1 | `add -A` records `vendor/dep` as mode `160000` (gitlink), contents invisible. |
| B2/B3 | `git add -f vendor/dep/lib.go` → `fatal: Pathspec 'vendor/dep/lib.go' is in submodule 'vendor/dep'`. No config bypasses it. |
| H1 | Full restore over an agent-modified nested repo: **the edit survives**. Silently unprotected. |
| H2 | The gitlink materialises only an empty `vendor/dep/` directory. |
| B4 | A shadow repo pointed at the nested worktree captures its contents perfectly. |

There is no way to fold a nested repo into the parent index. The only options
are "give up on it" or "give it its own shadow".

**Decision — recursive shadows.** A checkpoint becomes a tuple:

```
{ "": <commit>, "vendor/dep": <commit>, "third_party/x": <commit> }
```

- Discovery is free: gitlinks appear as mode `160000` in the root
  `ls-files -s`. Recurse one level at a time until no new gitlinks appear.
- Bounded: cap at 32 nested repos and skip any whose worktree exceeds the
  per-repo size budget; report every skip rather than hiding it.
- Restore applies the root first, then each nested shadow.
- **The root plan must never delete a path under a gitlink** — the root
  snapshot knows nothing about those contents.

Measured cost: linux, vscode and terminal have **zero** nested repos, so the
common case pays nothing. Where they exist, cost is proportional to their size,
and it is the same code path applied recursively.

Rejected: "detect and warn only". H1 is precisely the silent-non-coverage
failure this feature exists to eliminate.

---

## 3. Symlinks → no special handling; hardlinks → in-place write

**Evidence**

| test | result |
|--|--|
| C | Symlinks stored as mode `120000`; `checkout-index` restores file, dir **and dangling** links correctly as links. |
| F | Restoring over a symlink pointing outside the repo **replaces the link**; the outside file was untouched. No write-through. |
| E | Exec bit restored from mode `100755` automatically. |
| D1 | `checkout-index` on a hardlinked file: inode changes, `nlink` 2→1, and the sibling `b.txt` keeps the **modified** content while `a.txt` gets the **restored** content — silent divergence. |
| D2 | Writing the blob in place (open + truncate, inode preserved): `nlink` stays 2, both names see the restored content. |

**Decision — hybrid writer.**

| path class | writer |
|--|--|
| default | `git checkout-index -f -- <paths>` |
| `lstat().nlink > 1` | bypass git, write blob in place (O_TRUNC, keep inode) |

`nlink` is checked at plan time over the changed set only, so it is cheap.

Two rules from v0.2 are now obsolete and should be deleted:

- `skip: "symlink"` — unnecessary; git handles all three symlink shapes and is
  not vulnerable to write-through.
- manual `chmodSync` on the default checkout path — `checkout-index` already
  applies the stored mode. The hardlink in-place path must still chmod the
  shared inode explicitly.

---

## 4. (New) Restore can silently `rm -rf` a directory

**Evidence** — test G1: snapshot says `thing` is a file; disk has `thing/` as a
directory containing `inner.txt`. `checkout-index -f` **deleted the whole
directory** to place the file, exit 0, no warning. `inner.txt` is gone. G2 shows
the reverse swap also succeeds silently.

This is the "unsafe directory-structure change" the original SPEC listed but
never defined.

**Decision** — at plan time, compare the on-disk type against the snapshot type
for every path in the change set. Any mismatch (file ↔ dir ↔ symlink) is a
**type change**, rendered as its own line in the preview:

```
replace  thing/            directory with 1 file  →  regular file
```

Type changes require explicit confirmation and are never included in a
one-keystroke restore. The target blob/link is materialized first; only then is
the current path moved aside and the prepared target renamed into place. A
missing target leaves the original untouched, and install failure renames it
back.

---

## Consequences for the v0.3 plan

1. The `FileImage` model in `types.ts` grows a per-nested-repo dimension; a
   checkpoint is a commit **tuple**, not a single commit.
2. `applyPlan` splits into: `checkout-index` bulk path, in-place content/mode
   path for hardlinks, pre-materialized swap/rollback for confirmed type
   changes, and refused paths for case-collisions and skipped nested repos.
3. The preview UI needs four categories, not two: restore, delete, **type
   change**, **not protected**.
4. `session_start` gains a capability probe — case sensitivity, nested repo
   discovery, collision scan — all inside the existing async cold snapshot.
