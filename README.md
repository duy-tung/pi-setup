# pi-setup

Personal [pi](https://github.com/badlogic/pi-mono) coding-agent configuration:
extensions (statusline, subagent orchestration, secret-guard, sandbox-bash,
goal driver, todos, ...), skills, prompts, AGENTS.md, and settings.

Secrets are deliberately excluded: `auth.json`, `sessions/`, `cache/`,
`trust.json`, `models-store.json`, `npm/`.

## Restore on a new machine

```bash
rsync -a extensions skills prompts AGENTS.md settings.json subagent.tmux.conf ~/.pi/agent/
```
