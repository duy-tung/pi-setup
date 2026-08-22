# Pi setup on this machine

Personal configuration for the [Pi coding agent](https://github.com/badlogic/pi-mono).
This repository mirrors the live setup under `~/.pi/agent/`, except secrets, runtime
state, caches, and session logs.

## Current snapshot

| Item | Value |
|---|---|
| Pi | `@earendil-works/pi-coding-agent` 0.84.2 |
| Node | 24.15.0, managed by mise |
| tmux | 3.6a; used by sub-agents |
| Live config | `~/.pi/agent/` |
| Setup source | [duy-tung/pi-setup](https://github.com/duy-tung/pi-setup) |
| Rewind source | [duy-tung/pi-tree-rewind](https://github.com/duy-tung/pi-tree-rewind) (private) |

Current inventory: **16 extensions**, **7 skills**, and **5 prompt templates**.

## Runtime layout

```text
~/.pi/agent/
├── AGENTS.md                 global behavior rules
├── settings.json             models, packages, compaction, retry, TUI
├── extensions/               always-loaded TypeScript extensions
│   └── tree-rewind -> ~/Desktop/pi-tree-rewind/src
├── skills/                   capabilities loaded on demand
├── prompts/                  explicit slash-command templates
├── sessions/                 local session logs (not tracked)
├── auth.json                 provider credentials (not tracked)
└── cache/, npm/, trust.json  runtime data (not tracked)
```

Pi discovers files under `extensions/`, `skills/`, and `prompts/` automatically.

## Default behavior

`AGENTS.md` applies to every session:

- keep responses focused and concise;
- verify by running tests/builds when cheap;
- answer in the user's language, while repository code and docs remain English;
- lead explanations with the one-sentence result;
- narrate decisions, not every tool call;
- treat credential directories and files as off limits.

`settings.json` currently selects:

- default provider/model: Anthropic, `claude-fable-5`;
- default thinking: `xhigh`;
- enabled model families: Claude Fable/Opus/Sonnet/Haiku and
  `openai-codex/gpt-5.6-*`;
- fullscreen dark TUI with nvim as the external editor;
- project-local trust policy: ask;
- compaction enabled (`reserveTokens: 16384`, `keepRecentTokens: 32000`);
- retries enabled, with provider calls allowed up to one hour;
- installation telemetry disabled.

## Installed packages

| Package | Purpose |
|---|---|
| `pi-anthropic-oauth` | Anthropic OAuth/provider integration |
| `pi-web-search` | Web search tools |
| `@upstash/context7-pi` | Documentation lookup through Context7 |

## Extensions

Extensions are always discovered. A command or UI-only extension has negligible prompt
cost; extensions that register tools add their schemas to the model context on every
turn.

### Safety and context control

| Extension | Behavior |
|---|---|
| `secret-guard.ts` | Blocks credential-path access and redacts secret-shaped text before it reaches the transcript or provider |
| `sandbox-bash.ts` | Replaces the built-in bash tool with macOS Seatbelt sandboxing, environment scrubbing, and explicit one-shot escalation |
| `permission-gate.ts` | Requests confirmation before destructive commands, publication, force-push, or writes outside the project |
| `spill.ts` | Spills tool output larger than 16 KiB to disk and keeps only a head/tail preview in context |
| `compaction-prune.ts` | Trims oversized blocks before the compaction summarizer sees them |
| `repeat-reminder.ts` | Detects identical repeated tool calls and injects escalating loop warnings |
| `runtime-context.ts` | Adds changing facts such as cwd, branch, dirty state, and date without invalidating the system-prompt cache |

### Interaction and orchestration

| Extension | Behavior | User surface |
|---|---|---|
| `ask-user.ts` | Structured multiple-choice/input questions for the human | model tool `ask_user` |
| `todos.ts` | Model-managed task checklist with a TUI widget | tool `todowrite`, `/todos` |
| `goal.ts` | Event-sourced long-running goals with autonomous continuation rounds | tools `create_goal`, `get_goal`, `update_goal`; `/goal` |
| `subagent.ts` | Detached Pi workers in tmux with read-only, web-only, reviewer, and implementer roles | six `agent_*` tools; `/agents` |
| `paste-image-attach.ts` | Converts pasted or dragged image paths into actual image attachments, avoiding an extra `read` turn | automatic |

`subagent.ts` deliberately separates web access from filesystem access to reduce
exfiltration risk. Sub-agents run on the private tmux socket `piagents`, with maximum
nesting depth 1.

### Model and UI helpers

| Extension | Behavior | User surface |
|---|---|---|
| `present.ts` | Rewrites assistant answers longer than 200 prose characters through `openai-codex/gpt-5.6-sol:off` and appends a display-only plain-language version | automatic; `/present on\|off` |
| `fast-mode.ts` | Adds Anthropic `speed: "fast"` for supported Opus models | `/fast` |
| `statusline.ts` | Shows cwd, git branch, model, effort, context, cost, and Anthropic 5-hour/7-day limits | footer; `/limits` |

`present.ts` is a Pi port of the display-only and fail-open design from
[claudish-to-english](https://github.com/gvzdv/claudish-to-english). It runs the exact
Pi executable that launched the current session, disables reasoning for the rewrite,
and performs the request in the background. The original answer remains authoritative;
a failed or timed-out rewrite shows nothing.

### Workspace rewind

`extensions/tree-rewind` is a symlink to the separately versioned
[pi-tree-rewind](https://github.com/duy-tung/pi-tree-rewind) project at
`~/Desktop/pi-tree-rewind/src`.

It creates shadow-git worktree checkpoints before prompts, without touching the
project's `.git`. It can restore code, conversation, or both from a session-tree node.
It covers ordinary tracked/untracked worktree changes, nested repositories, and a
bounded set of explicitly edited files outside the project. Credential-shaped paths
and sensitive directories are refused.

Commands:

- `/rewind` — choose checkpoint, preview, coverage report, or undo;
- `/checkpoint` — alias for `/rewind`;
- `/undo` — undo the last file rewind or open the rewind menu.

Source changes belong in `~/Desktop/pi-tree-rewind`; the symlink makes them live after
`/reload`. Do not replace the symlink with an unversioned copy.

## Skills

Skills are loaded only when their descriptions match the task or a prompt explicitly
requests them.

| Skill | Use case |
|---|---|
| `code-review` | Review changes since a ref along Standards and Spec axes using parallel reviewer sub-agents |
| `domain-modeling` | Sharpen project terminology, maintain `CONTEXT.md`, and record gated ADRs |
| `grilling` | Stress-test the user's plan or decision through a design-tree interview |
| `handoff` | Compact the current session into a document another agent can continue from |
| `subagent` | Guidance for choosing roles and using the `agent_*` extension tools |
| `teach` | Run a stateful, multi-session learning workspace |
| `writing-for-agents` | Write or edit skills and `AGENTS.md` effectively |

The intentionally removed skills remain recoverable from git commit `937ea32`; they
were not kept in the live setup because their triggers were too broad or because they
were not needed.

## Prompt templates

| Command | Purpose |
|---|---|
| `/review [since-ref]` | Run the two-axis code-review skill |
| `/grill [topic]` | Stress-test a plan, decision, or idea |
| `/handoff [focus]` | Produce a compact pickup document for another agent |
| `/teach [topic]` | Start or continue a teaching workspace |
| `/wait-what` | Re-explain the last answer in plain language, using project vocabulary |

These are convenience entry points. Skills can still activate from natural-language
requests.

## Typical workflow

1. Start Pi in the project directory.
2. Describe the task normally. Use `/grill` first when the design is unclear.
3. Watch assumptions, destructive-action confirmations, and the todo widget while Pi
   works.
4. Use `/review` before merging non-trivial changes.
5. Use `/wait-what` when an explanation does not land; long answers also receive the
   automatic GPT presentation layer.
6. Use `/handoff` before stopping an unfinished task.
7. Use `/rewind` only after previewing the restore plan.

## Sync changes

The live directory is authoritative while developing. Mirror it into this repository
before committing:

```bash
cd ~/repos/pi-setup
rsync -a --delete ~/.pi/agent/prompts/ prompts/
rsync -a --delete --links ~/.pi/agent/skills/ skills/
rsync -a --delete --links ~/.pi/agent/extensions/ extensions/
cp ~/.pi/agent/AGENTS.md AGENTS.md
cp ~/.pi/agent/settings.json settings.json
cp ~/.pi/agent/subagent.tmux.conf subagent.tmux.conf
git add -A
git diff --cached --stat
```

Never copy `auth.json`, sessions, credentials, caches, or trust state into git.

Commit and push `pi-tree-rewind` separately when its source changes:

```bash
cd ~/Desktop/pi-tree-rewind
git add -A
git commit
git push
```

## Restore on a new machine

Prerequisites: Node through mise, Pi, tmux, git, and nvim.

```bash
# Main configuration
git clone https://github.com/duy-tung/pi-setup.git ~/repos/pi-setup
mkdir -p ~/.pi/agent
cd ~/repos/pi-setup
rsync -a extensions skills prompts AGENTS.md settings.json subagent.tmux.conf ~/.pi/agent/

# Rewind extension (private repository; authenticate with GitHub first)
git clone https://github.com/duy-tung/pi-tree-rewind.git ~/Desktop/pi-tree-rewind
rm -rf ~/.pi/agent/extensions/tree-rewind
ln -s ~/Desktop/pi-tree-rewind/src ~/.pi/agent/extensions/tree-rewind
```

The absolute mise/npm path in `settings.json` assumes the same home directory and may
need adjustment on another account.

Run `pi list`, open a short session, and use `/reload` after changing extensions.

## Secrets and excluded state

This repository deliberately excludes:

- `auth.json` and provider credentials;
- `sessions/`, sub-agent sessions, and rewind stores;
- `trust.json`, caches, package installation state, and model catalogs;
- temporary spills and runtime logs.

The repositories describe behavior. They are not backups of conversations or secrets.

## Known trade-offs

- `ask-user.ts`, `todos.ts`, `goal.ts`, and `subagent.ts` register model tools, so their
  schemas consume context on every turn even when unused.
- `present.ts` adds one GPT request for each sufficiently long assistant answer; turn it
  off with `/present off` when latency or usage matters.
- `tree-rewind` spends disk I/O on automatic checkpoints but does not consume model
  context. Always inspect its coverage report for paths it cannot protect.
- `paste-image-attach.ts` touches a private TUI paste path and should be checked after Pi
  upgrades.
- `compaction-prune.ts` and `sandbox-bash.ts` were verified against Pi 0.84.2 internals;
  re-audit them after major upgrades.
