# Machine snapshot before Pi removal — 2026-09-19

The repository root preserves the previously uncommitted development state.
`agent/` captures the actual live managed configuration, including a newer tree-rewind
working copy and models.json context-window overrides. These copies deliberately
remain separate: installing the repository root alone does not restore this snapshot.

- Pi: @earendil-works/pi-coding-agent 0.85.1; Node: 24.15.0.
- `rpiv-advisor/`: companion advisor configuration.
- `oauth-installed-source/`: actual installed OAuth source, including local edits.
- `oauth-local-source/`: separate local OAuth development working copy.
- `terminal/`: terminal configuration references and Pi environment variables.
- `notes/`: standalone Pi setup and review notes.

To restore, clone the repository and follow the root installation instructions,
then copy the desired snapshot agent files to ~/.pi/agent and advisor files to
~/.config/rpiv-advisor. The archived OAuth sources may require dependency installation.
Review the terminal references before merging into existing terminal configuration.
Machine home paths in this snapshot were normalized to `/Users/user`.

Credentials, sessions, task outputs, trust state, model caches, rewind data,
dependencies, and old runtime backups were intentionally excluded from this public
repository and are not recoverable from it after local removal. Authenticate again
after restoration. This is a source/configuration archive, not a claim that all
archived development changes have passed the complete runtime test suite.
