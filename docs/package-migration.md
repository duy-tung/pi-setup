# Package migration — September 2026

The setup replaces custom ask-user, todos and subagent extensions with
rpiv-ask-user-question 2.9.0, rpiv-todo 2.9.0 and pi-subagents 0.19.0, and adds
pi-background-tasks 2.5.0. Custom permission modes/gate and Seatbelt Bash are retired.
Pi uses normal host access. Project trust remains a resource-loading decision.

## Preserved behavior

Goal, fast mode, statusline, image attachment, context snapshots, spill, redaction and tree-rewind remain. The advisory-only repeat reminder and the
unused `lib/effects.ts` helper have been removed; identical tool calls no longer
receive custom loop advisories. `compaction-prune.ts` was removed as well: Pi 0.85.1 caps
tool results during summarization, and its remaining `!command` pruning was not worth an
extension. Present and its private RPC helpers have also been
removed; use `/wait-what` for an on-demand explanation.
Legacy Present entries are left intact,
and the footer still includes their recorded costs without a separate token segment.
Old permission snapshots are filtered only from outgoing model context. Stored transcripts,
auth, trust, historical custom children and rewind stores are not migrated or deleted.

Snapshot creation and context projection now live in the same `runtime-context.ts` extension
instance. `context-snapshots.ts` moved under `extensions/lib/` as a stateless helper; relying
on shared module state across two extension entrypoints did not work with Pi's actual loader.
This preserves reinsertion after compaction and isolation across cached factory instances.

Spill now processes core's raw Bash output even when its line-truncated preview fits the
32 KiB inline budget. Raw locators are replaced or withheld in both text and metadata.
When Bash errors discard metadata, recognized text-only locators are suppressed without
following them; those raw temporary files may remain on disk.
Offline scrub covers background `.output` logs and the structured inline-redaction families;
the ambiguous unlabelled AWS-40 heuristic is explicitly excluded from archive rewriting.
No existing transcript or background log is scrubbed automatically during this update.

AGENTS permits the requested task and its necessary steps without redundant approval,
including paths outside cwd. Unrequested publishing/deployment or unrelated deletion still
requires a scope decision. This is model guidance, not a per-tool enforcement layer.

## Provider and package boundaries

The main session loads only the background-tasks entrypoint from pi-background-tasks.
Its attribution entrypoint would register the same Anthropic provider, so it is excluded.
pi-anthropic-oauth-plus 0.3.2 retains its one-hour cache, technical-safe prompt rewriting,
and keepalive. Isolated delegate/Fusion children explicitly load their package provider
inside their own process; this does not replace the main session's provider.

Use Agent for coding/investigation and bg_run for shell jobs. Fusion/delegate tools are
available for their specialized contracts. Do not create recurring schedules implicitly.
Package defaults control concurrency and UI. Worktree mode can auto-commit child changes.
Background logs persist, but running jobs stop on reload/shutdown.

The pi-subagents activity patch adds one read-only EventBus query. Rewind checks it
alongside the background registry before file restore/undo and rechecks after dialogs.
All active/queued agents and workflows and all running jobs block restore in this session.
The probe does not stop jobs or impose write/network restrictions. It does not provide
a global lock against another Pi process or an external program writing concurrently.
The parent's checkpoint does not cover every child worktree or arbitrary host shell write.

## Verification and activation

The doctor runs unit/regression tests, the bundled rewind backend and package-smoke.mjs.
The smoke uses a separate temporary home/config, synthetic credentials and a fake model;
it checks real package loading and tools without real provider calls. TUI rendering and
live provider cache residency require separate evidence; mock results are not proof of them.

Start a new Pi session after switching configuration. Historical todo snapshots and custom
child IDs remain history and are not imported into the new packages. Do not reload a session
whose background work must continue.

## Rollback

Before migration, keep a private snapshot under
~/.local/state/pi-setup/migration-<date>.<id>/ containing:

- source/: the entire pre-migration repo, including dirty/untracked work and Git metadata;
- live/: the six managed live resources;
- npm/: the pre-migration package store.

The migration's rollback-live.sh restores live managed resources and the npm store, first
preserving the current live content in another directory beside the backup. It does not
touch auth, trust, sessions, rewind history or the working source repository. Restore source
from source/ separately only after preserving any newer edits. Do not run the new installer
again after a rollback until source and intended configuration agree.

Package pins and both source patches are checked on reinstall. Changing a package version
requires revalidating its patch and running the doctor.
