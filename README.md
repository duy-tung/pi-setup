# Portable Pi setup for macOS

Personal configuration and bootstrap for the [Pi coding agent](https://github.com/badlogic/pi-mono).
This public repository is the source of truth for six managed resources under
`~/.pi/agent/`; credentials, runtime state, caches, and session logs stay local.
No root license is granted: public visibility alone does not authorize reuse, and bundled
components retain their own license notices.

## Current snapshot

| Item | Value |
|---|---|
| Pi | `@earendil-works/pi-coding-agent` 0.84.3 |
| Node | 24.15.0, managed by mise |
| Subagent transport | Native Pi RPC (`--mode rpc`) |
| Live config | `~/.pi/agent/` |
| Setup source | [duy-tung/pi-setup](https://github.com/duy-tung/pi-setup) |
| Rewind source | Bundled package under `extensions/tree-rewind/` (imported from `65fa4fa`) |

Current inventory: **18 extensions**, **6 skills**, and **5 prompt templates**.

## Install on another Mac

Prerequisites are Apple Command Line Tools and Homebrew; install them first if
`xcode-select -p` or `brew --version` fails (use the official instructions at
[brew.sh](https://brew.sh/)). The repository is public, so cloning it needs no GitHub login:

```bash
brew install gh mise neovim
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
git clone https://github.com/duy-tung/pi-setup.git ~/repos/pi-setup
cd ~/repos/pi-setup
./install.sh
```

Run `gh auth login` before authenticated GitHub operations such as creating repositories or pushing.

`install.sh` pins Node/Pi, three top-level package versions, long cache retention,
and technical-safe OAuth prompt rewriting; it then applies only the managed config and
runs no-cost verification. Replaced config is backed up under
`~/.local/state/pi-setup/backups/`. Normal errors and catchable signals restore
managed config, selected mise config/Pi version, and configured package stores;
a prior different Pi version is reconstructed from npm rather than byte-restored.
SIGKILL/power loss can leave the fail-closed operation lock and preserved transaction
for manual recovery. At most an inert, unselected mise Node download may remain.
Authentication, sessions, trust decisions, spills, and rewind state are never copied
or replaced.

Provider identity is deliberately not portable. Start Pi and use `/login` for
Anthropic and Codex on the new machine; make project trust decisions again.
The installer supports macOS only because the current Bash confinement depends
on Seatbelt.

## Runtime layout

```text
~/.pi/agent/
├── AGENTS.md                 global behavior rules
├── settings.json             models, packages, compaction, retry, TUI
├── extensions/               always-loaded TypeScript extensions
│   └── tree-rewind/          bundled extension package
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

The repository-root `AGENTS.override.md` is intentionally not installed. Inside this source
repo it replaces the identical project copy, so Pi loads the full managed global policy only
once; on a bootstrap machine it tells the agent to read the tracked `AGENTS.md` explicitly.

The policy was redesigned from four sources at pinned commits: mattpocock/skills
`5b15a47`, addyosmani/agent-skills `5a5ea45`, kunchenguid/dotfiles `79d2d43`, and
multica-ai/andrej-karpathy-skills `2c60614`. Five independent source audits were
synthesized, then GPT-5.6 Sol performed an adversarial review and returned `APPROVE`
after its authority and trust-boundary findings were fixed.

`settings.json` currently selects:

- portable npm wrapper: `mise --no-config exec node@24.15.0 -- npm` (ignores project config without changing package cwd);
- exact external package pins, including npm versions;
- exact initial built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` (no PowerShell);
- default provider/model: Anthropic, `claude-fable-5`;
- Anthropic OAuth provider pinned to Git release `pi-anthropic-oauth-plus@v0.3.2`;
- global OAuth identity rewriting pinned to `technical-safe`: standalone `Pi` identity text may become `Claude Code`, while `.pi`, `pi-setup`, and ordinary paths remain literal;
- default thinking: `xhigh`; `/model` and `/thinking` changes stay session-local unless Ctrl+S explicitly saves a global default;
- enabled model families: Claude Fable/Opus/Sonnet/Haiku and
  `openai-codex/gpt-5.6-*`;
- fullscreen dark TUI with nvim as the external editor;
- project-local trust policy: ask;
- compaction enabled (`reserveTokens: 16384`, `keepRecentTokens: 32000`);
- cache-miss notices enabled, including Pi 0.84.3 compaction and branch-summary usage notices;
- retries enabled, with provider calls allowed up to one hour;
- installation telemetry disabled.

## Installed packages

| Package | Purpose |
|---|---|
| `pi-anthropic-oauth-plus@v0.3.2` (pinned Git) | Anthropic OAuth, 1-hour cache/keepalive, Pi 0.84.3 request hooks, and server-side fallback pricing |
| `pi-web-search@1.3.1` (patched) | Web search tools; carries `patches/pi-web-search-oauth-system.patch` |
| `@upstash/context7-pi@0.1.2` | Context7 tools and explicit `/c7-docs`; its redundant package skill is filtered out |

These are exact top-level pins, not a hermetic supply-chain lock: Pi's published npm
package can resolve newer transitive versions allowed by its own ranges. `doctor.sh`
checks configured specs, installed top-level versions, OAuth commit/dirty state, and
isolated load health; it does not hash every installed npm implementation byte. OAuth
v0.3.2 honors Pi's request-body/tool-choice hooks, preserves required betas while rejecting
fine-grained tool streaming, and records the returned fallback model with its own pricing.

### Patched packages

A published package that needs a local source fix carries a unified diff under
`patches/`. `install.sh` applies each one after package reconciliation and `doctor.sh`
verifies the pinned post-image checksum of the patched file, so a reinstall, a version
bump, or a hand edit that drops the fix fails loudly instead of silently regressing.

`patches/pi-web-search-oauth-system.patch` is the only current entry.
`pi-web-search` bypasses the provider and calls `/v1/messages` directly for the
Anthropic-native `web_search` tool, but sends no `system` field. A Claude Pro/Max OAuth
token is only accepted when the first system block is the Claude Code identity, so
without it Anthropic answers `429 rate_limit_error` with a generic `"Error"` message and
no `anthropic-ratelimit-*` headers - a policy rejection that reads like an exhausted
quota. The patch adds that block for OAuth credentials only; API-key requests are
unchanged. Upstream has not been notified yet.

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

The provider still identifies the OAuth client as Claude Code, but the setup pins
`PI_ANTHROPIC_OAUTH_REWRITE_MODE=technical-safe` globally through mise. This rewrites
standalone identity prose without mutating technical tokens such as `~/.pi/agent` or
`pi-setup`. The provider still removes paragraphs containing its fixed Pi-identity anchors
before this regex runs; `technical-safe` does not alter that separate compatibility behavior.
The narrow `~/.Claude Code/agent` alias remains a fallback; an existing legacy whole-`~/.pi`
alias is not silently changed. Because environment variables are inherited at process start,
close and reopen an already-running Pi after a full install; `/reload` alone is insufficient.

## Extensions

Extensions are always discovered. A command or UI-only extension has negligible prompt
cost; extensions that register tools add their schemas to the model context on every
turn.

### Safety and context control

| Extension | Behavior |
|---|---|
| `permission-mode.ts` | User-owned Auto, Manual, Accept edits, Plan, and transient Bypass modes; branch-local state and footer status through `/mode` or `Ctrl+Alt+M` |
| `permission-gate.ts` | Single pre-execution owner: invariant credential/path denies, mode-aware one-call approvals, common commit/push/delete/deploy patterns, and defensive Plan/Bypass boundaries |
| `context-snapshots.ts` | Projects only the newest runtime and permission snapshot to each model call while preserving append-only session history |
| `secret-guard.ts` | Best-effort known-pattern redaction of final text tool results before the normal transcript/provider path |
| `sandbox-bash.ts` | Sequential per-call macOS Seatbelt confinement for Bash file writes and known credential reads, plus environment scrubbing; Plan has no writable roots, network remains unrestricted, and there is no agent escalation |
| `spill.ts` | Stores output larger than 16 KiB as a private redacted artifact; unsafe raw core output is withheld, never exposed as a locator |
| `compaction-prune.ts` | Trims oversized blocks before the compaction summarizer sees them |
| `repeat-reminder.ts` | Detects identical repeated tool calls and queues a separately marked runtime advisory instead of imitating a system tag inside tool output |
| `runtime-context.ts` | Adds branch, dirty state, and date snapshots without duplicating Pi core's cwd system instruction |

`/mode` opens a five-row selector; `Ctrl+Alt+M` opens the same UI. Auto is the default
and follows the permission model described under [Permission rules](#permission-rules):
recognized commit, deletion, publishing, deployment, and destructive command patterns ask,
and most of those prompts offer to stop asking. Pattern matching is deliberately not an
exhaustive shell policy, so the model must still obey `AGENTS.md` authority rules. Manual
asks once for every edit/write, every Bash call, and every mutation-capable work-child
activation. Accept edits allows ordinary
workspace edit/write calls but still asks for Bash, protected/outside writes, unknown
side-effect tools, and work-child activation. Plan removes `bash`, `edit`, and `write`,
blocks work children and unknown side-effect tools, and restores only the tools it disabled
when leaving. Auto, Manual, Accept edits, and Plan follow the active session branch.

Bypass requires an attended confirmation and active macOS Seatbelt. It skips gate prompts
for the current runtime only; it is not authorization to commit, push, deploy, publish, or
delete user work. Bash stays workspace-confined, built-in protected/outside writes and
credential access stay blocked, and RPC children retain their fixed independent policy.
Reload, resume, fork, or a new session returns Bypass to Auto. Mode changes and
conversation-tree navigation are refused while a work child is starting/running.

### Permission rules

`extensions/lib/permission-rules.ts` implements Claude Code's permission model. Rules are
`Tool(specifier)` strings — `Bash(git push *)`, `Edit(/path/**)` — in three tiers whose
precedence is **deny > ask > allow**. `Bash(prefix *)` matches a command and its arguments;
a path specifier ending in `/**` matches a subtree.

A command is matched after heredoc bodies and quoted literals are stripped, and each
`&&`/`;`/`|` segment is judged separately with the most severe decision winning. Writing a
test file whose body mentions `git commit` therefore no longer trips the commit prompt.

| Tier | Behavior |
|---|---|
| `deny` | Hard block. Credential reads (`gh auth token`, `op read`, keychain dumps) and device-destroying writes (`mkfs`, `shred`, `diskutil erase`). Never overridable. |
| `ask` | Prompts. Most entries offer **Always allow `<rule>`**, which files a learned rule that cancels the default. The `NEVER_REMEMBER` subset — `sudo`, `git push`, publish, deploy, `shutdown` — always re-asks, because it reaches outside this machine or cannot be undone from here. |
| `allow` | Silent. Read-only `git status`/`diff`/`log`/`show` and `gh pr view`/`diff`. |
| unmatched | Runs in Auto. Asks in Manual and Accept edits. |

Two places deliberately depart from Claude Code, both because this setup has layers Claude
Code does not:

- **Unmatched Bash runs in Auto.** Claude Code must ask about every unfamiliar command
  because nothing else confines it. Here `sandbox-bash.ts` gives each command a Seatbelt
  profile that limits writes to the workspace and temp and makes credentials unreadable,
  and `tree-rewind` checkpoints the workspace. Asking anyway would have cost 725 first-time
  prompts across this machine's session history.
- **`rm -rf` asks rather than being denied.** The same two layers make a confined,
  checkpointed delete recoverable.

Every prompt shows a clamped copy of the operation — bounded by terminal rows and columns,
keeping both ends of each line — because Pi renders an extension dialog as an unscrolled Text,
so a heredoc commit message would otherwise push the transcript off screen. Rule matching,
path resolution, and the model-facing message still use the complete command.

Auto treats the session's working directory as the workspace and does not re-ask inside it,
as Claude Code does. Protected writes (`~/.zshrc`, `~/.gitconfig`, `~/.pi/agent`, project
`.git/config` and hooks) and sensitive paths keep their own prompt and hard block
regardless, which is what keeps that safe when a session starts in `$HOME`.

Learned rules live in `~/.local/state/pi-setup/permission-rules.json`, deliberately outside
the parity-checked managed config so that remembering an answer never registers as install
drift. The file is re-read before each write so concurrent sessions do not discard one
another's answers, and a corrupt file degrades to no learned rules rather than failing the
gate. Delete it to forget every remembered answer.

### Interaction and orchestration

| Extension | Behavior | User surface |
|---|---|---|
| `ask-user.ts` | Structured multiple-choice/input questions with a bounded, PageUp/PageDown-scrollable long-question viewport | model tool `ask_user` |
| `todos.ts` | Model-managed task checklist with a TUI widget | tool `todowrite`, `/todos` |
| `goal.ts` | Event-sourced long-running goals with autonomous continuation rounds | tools `create_goal`, `get_goal`, `update_goal`; `/goal` |
| `subagent.ts` | Resumable Pi RPC children with parent-scoped state and explore, web, and work profiles | tools `subagent`, `send_message`, `list_agents`, `interrupt_agent`; `/agents` |
| `paste-image-attach.ts` | Converts pasted or dragged image paths into actual image attachments, avoiding an extra `read` turn | automatic |

`subagent.ts` uses Pi's native RPC protocol. A child process exists only for one active
turn; its durable session remains under
`~/.pi/agent/subagents/<parent-session-id>/<child-id>/` for `send_message` follow-ups.
Background completion is delivered automatically. The TUI status widget shows only active
turns and clears when the last child settles, while `/agents` and `list_agents` retain durable
children for transcript inspection and follow-ups. Child IDs are authorized to their exact
parent session; per-child control is serialized across settlement/cold-resume boundaries, and there is no
cwd override, orphan adoption, nesting, or polling tool.

Every child uses `--no-approve`, so project-controlled extensions and context cannot shadow
an allowed built-in tool name. The `web` profile additionally uses `--no-context-files` and
has no filesystem tools. The `explore` profile has Bash, but `PI_SUBAGENT_READONLY=1` gives it
a Seatbelt profile with `(deny network*)` whose only writable root is the child's own
`scratch/` directory, so `git log`/`git diff` and other inspection work while the workspace and
egress are denied by the OS; where that sandbox is unavailable, Bash is dropped from the
profile instead of running unconfined. Scratch is how a child returns more than its 16KB
report: the parent reads those files by path, which is the one child output that reaches
parent context without redaction and marking. It is deleted when the parent session ends, and
anything a crashed session left is swept after seven days. The `work`
profile still requires the parent to be in a trusted,
non-broad workspace, but the standalone child prompt must carry the relevant project rules.
Its Bash is offline unless the `subagent` call passes `network: true`, which asks for
confirmation in every mode except Bypass; the grant is recorded in the child's identity, so a
resume cannot add it. Manual and Accept edits treat each new/resumed work
activation as one broad approval scope because an unattended child cannot forward per-edit
prompts. Plan blocks those activations, and no parent mode is passed into the child. These are
model-tool restrictions and accident resistance, not process isolation. Because a profile names
its tools as strings, an uninstalled package would silently shrink a child: a partial gap is
reported once per session and a profile with nothing installed refuses to start. RPC dialogs fail closed, reports are
redacted/marked/capped before entering parent context, and active children stop on every
parent session shutdown.

### Model and UI helpers

| Extension | Behavior | User surface |
|---|---|---|
| `present.ts` | Opt-in private RPC rewrite through `openai-codex/gpt-5.6-sol:off`; appends a display-only plain-language version | default off; `/present on\|off\|status` |
| `fast-mode.ts` | Adds only Anthropic `speed: "fast"` and its beta; OAuth v0.3.2 merges required betas and blocks fine-grained streaming | `/fast` |
| `statusline.ts` | Shows cwd, git branch, model, effort, context, cost, and Anthropic 5-hour/7-day limits | footer; `/limits` |

`present.ts` is a Pi port of the display-only and fail-open design from
[claudish-to-english](https://github.com/gvzdv/claudish-to-english). After `/present on`, a
private one-shot `--mode rpc --no-session` child uses the exact Pi executable and fixed
`openai-codex/gpt-5.6-sol:off` model with no tools, project resources, or durable child
session. The answer travels over RPC stdin rather than a plaintext prompt file. Session/leaf
generation guards, latest-wins cancellation, exact fenced-code checks, literal
number/URL/path/inline-code validation, bounded output, and process-group teardown prevent
mutated or stale rewrites from attaching to another turn.

Literal validation asks that nothing disappears and that no quantity is invented; it does
not compare how often a literal recurs, because merging two sentences that cite the same
symbol is a rewrite doing its job. Bare `a/b` prose tokens (`yes/no`, `Pro/Max`) are not
treated as paths. Both rules come from running the real pipeline over answers from this
machine's history: exact repetition counts and prose slash tokens together caused every
rejection observed, on rewrites that had lost nothing. The thinking level is `off` and
derived into `PRESENT_MODEL` rather than restated — `low` passed the same 4 of 6 rewrites
at the same latency, and a drift between the spawn argument and the ownership check would
fail every rewrite silently.

Because the pipeline is fail-open, every way a turn can end without a rewrite used to be a
bare `return`, and a present that produced nothing was indistinguishable from a present that
was switched off. That opacity is why a broken literal validator went unnoticed while the
visible knobs got tuned instead. Each exit is now named, counted, and readable with
`/present status`: `source-unsettled`, `source-too-short` (which reports an unterminated
fence separately, since one can never be validated), `source-too-large`, `superseded`,
`child-invalid`, `child-error`, `result-empty`, `result-too-large`, `fences-changed`,
`literals-changed` (which names the literals lost or invented), `failed`, and `ok`. Counts
are session-scoped and never written to disk, and detail text passes through the shared
credential redactor before it can reach the screen. The custom
entry shows per-rewrite model/token/cost metadata but does not add that usage to parent
session totals. The original answer remains authoritative; any failure shows nothing.

### Workspace rewind

`extensions/tree-rewind/` is a regular bundled Pi package. It was imported
from the clean standalone commit `65fa4fa`; this repository is now its canonical
source for the installed setup.

It creates shadow-git worktree checkpoints before prompts, without touching the
project's `.git`. It can restore code, conversation, or both from a session-tree node.
It covers ordinary tracked/untracked worktree changes, nested repositories, and a
bounded set of explicitly edited files outside the project. Credential-shaped paths
and sensitive directories are refused.

User-facing commands:

- `/tree` — navigate the conversation; tree-rewind offers to restore the matching code checkpoint;
- `/rewind` — manage file checkpoints directly: restore code, undo the last restore, or inspect coverage.

Checkpoints are automatic. There is no separate manual checkpoint command.

Develop it under `extensions/tree-rewind/`, run its backend tests, then apply the
managed config and `/reload`. The old standalone repository is historical only and
is not part of restore.

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

For a stack-neutral project bootstrap workflow with a concrete Go service baseline, see the
[detailed Vietnamese new-project guideline](docs/new-project-setup-tieng-viet.md).

## Typical workflow

1. Start Pi in the project directory; keep default Auto or choose another policy with `/mode`.
2. Describe the task normally. Use `/grill` first when the design is unclear.
3. Watch assumptions, mode/operation confirmations, and the todo widget while Pi
   works.
4. Use `/review` before merging non-trivial changes.
5. Use `/wait-what` when an explanation does not land. Enable `/present on` only when
   sending future long answers to OpenAI for a display-only rewrite is acceptable.
6. Use `/handoff` before stopping an unfinished task.
7. Use `/rewind` only after previewing the restore plan.

## Apply and capture changes

The six managed resources are declared in `scripts/managed-paths.txt`. Apply a
repository change to the live setup without runtime or package work:

```bash
cd ~/repos/pi-setup
./install.sh --config-only
# In an already-running Pi TUI:
/reload
```

Run the full `./install.sh` instead when runtime or package pins changed. It also
runs `doctor.sh`. Doctor's Pi startup smoke uses a temporary HOME/config and local
package paths, so it cannot migrate live credentials. To verify managed/runtime
state without a model request:

```bash
./doctor.sh
```

The live directory remains convenient while developing extensions. Capture only
the managed allowlist back into a clean repository with:

```bash
./sync-from-live.sh
git diff --check
git status --short
```

Install and capture share one fail-closed operation lock, so they cannot mutate
or snapshot the live tree concurrently. The capture script refuses dirty managed
repo paths and all symlinks, runs the repository audit, and never stages or pushes. The tracked Vietnamese operational
runbook is `docs/pi-setup-tieng-viet.md`. Never manually mirror the whole
`~/.pi/agent`: it contains authentication, sessions, trust state, caches, package
stores, spills, and rewind data.

## Restore and update

After the stated Apple/Homebrew prerequisites, the quick install near the top is
the new-machine path. Later updates are:

```bash
cd ~/repos/pi-setup
git pull --ff-only
./install.sh
```

Keep this installer as the runtime authority. This setup is a global npm installation under
mise, not Pi's installer-managed layout, so Pi's managed atomic self-update path and
`pi update --self` do not replace the repository pin, package reconciliation, doctor checks,
or rollback transaction.

If SIGKILL/power loss leaves `~/.local/state/pi-setup/operation.lock`, first
confirm no install/sync process is alive, then remove that exact lock. Preserved
`transactions/` or `sync-transactions/` contain before-images for manual recovery;
a normal rerun reapplies the desired managed config but does not silently delete
those crash artifacts. If an install replaces existing managed config, its prior
copy is under `~/.local/state/pi-setup/backups/`. Runtime/private state is
not a repository backup; move sessions separately through Pi's JSONL export/import
only when needed. `auth.json` must never enter Git.

## Secrets and excluded state

This repository deliberately excludes:

- `auth.json` and provider credentials;
- `sessions/`, sub-agent sessions, and rewind stores;
- `trust.json`, caches, npm/git package installation state, and model catalogs;
- temporary spills and runtime logs.

The repository describes behavior. It is not a backup of conversations or secrets.

## Security posture and tests

This is an **accident-resistant, human-supervised local setup**, not a sandbox for hostile
repositories or prompt injection. Pi and global extensions run with the user's host
authority. The parent's Bash network access is unrestricted, while every subagent is offline
unless the user approved that activation; whole-process isolation is required for untrusted or
unattended work, as documented by Pi itself.

Focused policy tests use Node's built-in runner:

```bash
node --experimental-strip-types --test tests/*.test.mjs
```

They cover the five-mode decision/persistence/tool-restoration matrix, authority-sensitive
Auto command prompts, canonical/symlink paths, Seatbelt profile generation, runtime snapshot
projection, resource precedence, bounded skill prompts, safe spill fallback, RPC
framing/dialog/process teardown, parent-scoped durable child state, fixed capability profiles,
bounded/redacted child reports, private presentation literal/fence/ownership/cancellation
behavior, repository portability, and
installer rollback/runtime-state preservation. Bundled rewind backend tests run through
`npm --prefix extensions/tree-rewind test`. Real Seatbelt e2e must run outside an already
sandboxed parent process.

## Known trade-offs

- `ask-user.ts`, `todos.ts`, `goal.ts`, and `subagent.ts` register model tools, so their
  schemas consume context on every turn even when unused.
- The explicit default tool set also enables `grep`, `find`, and `ls`: Plan/Manual gain direct
  read-only search at the cost of three additional built-in schemas.
- Context7's two tool schemas remain recurring prompt cost; its broad package skill is filtered
  because the schemas already carry the resolve/query protocol, while `/c7-docs` stays explicit.
- After `/present on`, `present.ts` sends each eligible long answer to OpenAI in a private
  ephemeral RPC call. Its per-rewrite cost is displayed but not added to parent totals; the
  feature resets to off on every session start/reload.
- Anthropic cache keepalive can make up to six hidden cache-read requests per idle live
  conversation; those requests are bounded but absent from Pi's displayed session cost.
- `tree-rewind` spends disk I/O on automatic checkpoints but does not consume model
  context. Always inspect coverage. A very long current session has no hard byte cap;
  SIGKILL can leave a fail-closed lock requiring confirmed manual removal.
- `paste-image-attach.ts` touches a private TUI paste path and should be checked after Pi
  upgrades.
- `compaction-prune.ts` and `sandbox-bash.ts` were verified against Pi 0.84.3 internals;
  re-audit them after major upgrades.
