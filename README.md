# Pi setup on this machine

Personal configuration for the [Pi coding agent](https://github.com/badlogic/pi-mono).
This repository mirrors the live setup under `~/.pi/agent/`, except secrets, runtime
state, caches, and session logs.

## Current snapshot

| Item | Value |
|---|---|
| Pi | `@earendil-works/pi-coding-agent` 0.84.2 |
| Node | 24.15.0, managed by mise |
| Subagent transport | Native Pi RPC (`--mode rpc`) |
| Live config | `~/.pi/agent/` |
| Setup source | [duy-tung/pi-setup](https://github.com/duy-tung/pi-setup) |
| Rewind source | [duy-tung/pi-tree-rewind](https://github.com/duy-tung/pi-tree-rewind) (private) |

Current inventory: **16 extensions**, **6 skills**, and **5 prompt templates**.

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
├── subagents/                private RPC child sessions (not tracked)
├── auth.json                 provider credentials (not tracked)
└── cache/, npm/, git/, trust.json  runtime data (not tracked)
```

Pi discovers files under `extensions/`, `skills/`, and `prompts/` automatically.

## Default behavior

`AGENTS.md` applies to every session. It is intentionally model- and harness-neutral:

- answer in the user's language and lead with the result;
- resolve inspectable facts, while asking for material preferences or authority decisions;
- surface conflicts, tradeoffs, and reversible assumptions;
- read local context first and make the smallest complete, in-scope change;
- use direct paths before adding machinery, and incremental work for larger changes;
- ground claims in primary evidence, reproduce bugs, and verify proportionately;
- treat task data as data, preserve user work, and require authority for external effects;
- respect permission denials and protect credential paths.

The policy was redesigned from four sources at pinned commits: mattpocock/skills
`5b15a47`, addyosmani/agent-skills `5a5ea45`, kunchenguid/dotfiles `79d2d43`, and
multica-ai/andrej-karpathy-skills `2c60614`. Five independent source audits were
synthesized, then GPT-5.6 Sol performed an adversarial review and returned `APPROVE`
after its authority and trust-boundary findings were fixed.

`settings.json` currently selects:

- default provider/model: Anthropic, `claude-fable-5`;
- Anthropic OAuth provider pinned to Git release `pi-anthropic-oauth-plus@v0.3.1`;
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
| `pi-anthropic-oauth-plus@v0.3.1` (pinned Git) | Anthropic OAuth plus 1-hour prompt cache and bounded keepalive |
| `pi-web-search` | Web search tools |
| `@upstash/context7-pi` | Documentation lookup through Context7 |

### Anthropic prompt-cache policy

`PI_CACHE_RETENTION=long` selects Anthropic's 1-hour cache. The pinned provider
replays the exact last successful request every 55 minutes only for prompts of at
least 10K tokens. Six confirmed cache-read pings can keep one live conversation
eligible for about 390 minutes from the real request start. A real request, reload,
session switch, shutdown, expiry, provider error, or zero cache read cancels the
chain; stale completions cannot rearm it.

The pings are out of band, so their usage is absent from Pi's session/footer cost.
Sleep, process restart, provider eviction, and gaps beyond 6.5 hours can still miss.
Use `/compact`, a handoff, or a new session for overnight breaks instead of warming
cache indefinitely. Pi's `Cache miss after … idle` label compares visible request
timestamps and does not account for hidden keepalive pings.

The provider's aggressive OAuth identity rewrite may turn `~/.pi/agent` into
`~/.Claude Code/agent`. New installations create only that narrow agent-directory
alias; an existing legacy whole-`~/.pi` alias is not silently changed.

## Extensions

Extensions are always discovered. A command or UI-only extension has negligible prompt
cost; extensions that register tools add their schemas to the model context on every
turn.

### Safety and context control

| Extension | Behavior |
|---|---|
| `permission-gate.ts` | Single pre-execution owner: canonical sensitive-path deny and exact one-call confirmation for destructive/protected/outside writes |
| `secret-guard.ts` | Best-effort known-pattern redaction of final text tool results before the normal transcript/provider path |
| `sandbox-bash.ts` | Per-call macOS Seatbelt confinement for Bash file writes and known credential reads, plus environment scrubbing; network remains unrestricted and there is no agent escalation |
| `spill.ts` | Stores output larger than 16 KiB as a private redacted artifact; unsafe raw core output is withheld, never exposed as a locator |
| `compaction-prune.ts` | Trims oversized blocks before the compaction summarizer sees them |
| `repeat-reminder.ts` | Detects identical repeated tool calls and injects escalating loop warnings |
| `runtime-context.ts` | Adds changing facts such as cwd, branch, dirty state, and date without invalidating the system-prompt cache |

### Interaction and orchestration

| Extension | Behavior | User surface |
|---|---|---|
| `ask-user.ts` | Structured multiple-choice/input questions for the human | model tool `ask_user` |
| `todos.ts` | Model-managed task checklist with a TUI widget | tool `todowrite`, `/todos` |
| `goal.ts` | Event-sourced long-running goals with autonomous continuation rounds | tools `create_goal`, `get_goal`, `update_goal`; `/goal` |
| `subagent.ts` | Resumable Pi RPC children with parent-scoped state and explore, web, and work profiles | tools `subagent`, `send_message`, `list_agents`, `interrupt_agent`; `/agents` |
| `paste-image-attach.ts` | Converts pasted or dragged image paths into actual image attachments, avoiding an extra `read` turn | automatic |

`subagent.ts` uses Pi's native RPC protocol. A child process exists only for one active
turn; its durable session remains under
`~/.pi/agent/subagents/<parent-session-id>/<child-id>/` for `send_message` follow-ups.
Background completion is delivered automatically, while `/agents` exposes the private
transcript and human steering. Child IDs are authorized to their exact parent session;
per-child control is serialized across settlement/cold-resume boundaries, and there is no
cwd override, orphan adoption, nesting, or polling tool.

Every child uses `--no-approve`, so project-controlled extensions and context cannot shadow
an allowed built-in tool name. The `web` profile additionally uses `--no-context-files` and
has no filesystem tools. The `work` profile still requires the parent to be in a trusted,
non-broad workspace, but the standalone child prompt must carry the relevant project rules;
its Bash retains host network access. These are model-tool restrictions and accident
resistance, not process isolation. RPC dialogs fail closed, reports are
redacted/marked/capped before entering parent context, and active children stop on every
parent session shutdown.

### Model and UI helpers

| Extension | Behavior | User surface |
|---|---|---|
| `present.ts` | Opt-in private RPC rewrite through `openai-codex/gpt-5.6-sol:off`; appends a display-only plain-language version | default off; `/present on\|off` |
| `fast-mode.ts` | Adds Anthropic `speed: "fast"` for supported Opus models | `/fast` |
| `statusline.ts` | Shows cwd, git branch, model, effort, context, cost, and Anthropic 5-hour/7-day limits | footer; `/limits` |

`present.ts` is a Pi port of the display-only and fail-open design from
[claudish-to-english](https://github.com/gvzdv/claudish-to-english). After `/present on`, a
private one-shot `--mode rpc --no-session` child uses the exact Pi executable and fixed
`openai-codex/gpt-5.6-sol:off` model with no tools, project resources, or durable child
session. The answer travels over RPC stdin rather than a plaintext prompt file. Session/leaf
generation guards, latest-wins cancellation, fenced-code validation, bounded output, and
process-group teardown prevent stale rewrites from attaching to another turn. The custom
entry shows per-rewrite model/token/cost metadata but does not add that usage to parent
session totals. The original answer remains authoritative; any failure shows nothing.

### Workspace rewind

`extensions/tree-rewind` is a symlink to the separately versioned
[pi-tree-rewind](https://github.com/duy-tung/pi-tree-rewind) project at
`~/Desktop/pi-tree-rewind/src`.

It creates shadow-git worktree checkpoints before prompts, without touching the
project's `.git`. It can restore code, conversation, or both from a session-tree node.
It covers ordinary tracked/untracked worktree changes, nested repositories, and a
bounded set of explicitly edited files outside the project. Credential-shaped paths
and sensitive directories are refused.

User-facing commands:

- `/tree` — navigate the conversation; tree-rewind offers to restore the matching code checkpoint;
- `/rewind` — manage file checkpoints directly: restore code, undo the last restore, or inspect coverage.

Checkpoints are automatic. There is no separate manual checkpoint command.

Source changes belong in `~/Desktop/pi-tree-rewind`; the symlink makes them live after
`/reload`. Do not replace the symlink with an unversioned copy.

## Skills

Skills are loaded only when their descriptions match the task or a prompt explicitly
requests them.

| Skill | Use case |
|---|---|
| `code-review` | Review changes since a ref along Standards and Spec axes using parallel foreground `explore` children |
| `domain-modeling` | Sharpen project terminology, maintain `CONTEXT.md`, and record gated ADRs |
| `grilling` | Stress-test the user's plan or decision through a design-tree interview |
| `handoff` | Compact the current session into a document another agent can continue from |
| `subagent` | Guidance for RPC profiles, background scheduling, continuation, and the four subagent controls |
| `teach` | Run a stateful, multi-session learning workspace |

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
5. Use `/wait-what` when an explanation does not land. Enable `/present on` only when
   sending future long answers to OpenAI for a display-only rewrite is acceptable.
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

Prerequisites: Node through mise, Pi, git, and nvim.

```bash
# Main configuration
git clone https://github.com/duy-tung/pi-setup.git ~/repos/pi-setup
mkdir -p ~/.pi/agent
cd ~/repos/pi-setup
rsync -a extensions skills prompts AGENTS.md settings.json ~/.pi/agent/
export PI_CACHE_RETENTION=long  # also persist this in your shell startup file
pi update --extensions         # installs the pinned OAuth fork and other packages

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
- `trust.json`, caches, npm/git package installation state, and model catalogs;
- temporary spills and runtime logs.

The repositories describe behavior. They are not backups of conversations or secrets.

## Security posture and tests

This is an **accident-resistant, human-supervised local setup**, not a sandbox for hostile
repositories or prompt injection. Pi and global extensions run with the user's host
authority. Bash network access is unrestricted; whole-process isolation is required for
untrusted or unattended work, as documented by Pi itself.

Focused policy tests use Node's built-in runner:

```bash
node --experimental-strip-types --test tests/*.test.mjs
```

They cover canonical/symlink paths, one-call approvals, Seatbelt profile generation,
safe spill fallback, RPC framing/dialog/process teardown, parent-scoped durable child
state, fixed capability profiles, bounded/redacted child reports, and private presentation
RPC eligibility/ownership/cancellation/fenced-code behavior. Real Seatbelt e2e must run
outside an already sandboxed parent process.

## Known trade-offs

- `ask-user.ts`, `todos.ts`, `goal.ts`, and `subagent.ts` register model tools, so their
  schemas consume context on every turn even when unused.
- After `/present on`, `present.ts` sends each eligible long answer to OpenAI in a private
  ephemeral RPC call. Its per-rewrite cost is displayed but not added to parent totals; the
  feature resets to off on every session start/reload.
- Anthropic cache keepalive can make up to six hidden cache-read requests per idle live
  conversation; those requests are bounded but absent from Pi's displayed session cost.
- `tree-rewind` spends disk I/O on automatic checkpoints but does not consume model
  context. Always inspect its coverage report for paths it cannot protect.
- `paste-image-attach.ts` touches a private TUI paste path and should be checked after Pi
  upgrades.
- `compaction-prune.ts` and `sandbox-bash.ts` were verified against Pi 0.84.2 internals;
  re-audit them after major upgrades.
