# Portable Pi setup for macOS

Personal configuration and bootstrap for the [Pi coding agent](https://github.com/badlogic/pi-mono).
This public repository is the source of truth for eight managed resources under
`~/.pi/agent/`; credentials, runtime state, caches, and session logs stay local.
No root license is granted: public visibility alone does not authorize reuse, and bundled
components retain their own license notices.

## Current snapshot

| Item | Value |
|---|---|
| Pi | `@earendil-works/pi-coding-agent` 0.85.1 |
| Node | 24.15.0, managed by mise |
| Subagent orchestration | `@tintinweb/pi-subagents@0.19.0` |
| Live config | `~/.pi/agent/` |
| Setup source | [duy-tung/pi-setup](https://github.com/duy-tung/pi-setup) |
| Rewind source | Bundled package under `extensions/tree-rewind/` (imported from `65fa4fa`) |

Current inventory: **8 local extensions**, **10 pinned external packages**, **6 skills**, **5 prompt templates**, and **4 agent definitions**.

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

`install.sh` pins Node/Pi, nine top-level package versions, long cache retention,
and technical-safe OAuth prompt rewriting; it then applies only the managed config and
runs no-cost verification. It honors `MISE_GLOBAL_CONFIG_FILE`, then `MISE_CONFIG_DIR`,
then the XDG/default mise path when selecting the global config to preserve. Replaced
config is backed up under `~/.local/state/pi-setup/backups/`. New backups carry an
ownership marker and expire after 30 days; existing unmarked backups are never adopted or
pruned. Cleanup traps are active before staging or transaction creation. Normal errors and
catchable signals restore managed config, selected mise config/Pi version, and configured
package stores. Package reconciliation updates the managed pins in a transactional copy, so
unrelated package-store entries survive, and patch checksum readiness is part of the transaction decision. A prior different Pi version
is reconstructed from npm rather than byte-restored. SIGKILL/power loss can leave the
fail-closed operation lock and preserved transaction for manual recovery. At most an inert,
unselected mise Node download may remain.
Authentication, sessions, trust decisions, spills, and rewind state are never copied
or replaced.

Provider identity is deliberately not portable. Start Pi and use `/login` for
Anthropic and Codex on the new machine; make project trust decisions again.
The installer remains verified on macOS. Pi uses ordinary host Bash/file access; no
custom sandbox or per-tool permission gate is installed.

## Runtime layout

```text
~/.pi/agent/
├── AGENTS.md                 global behavior rules
├── settings.json             models, packages, compaction, retry, TUI
├── zentui.json               editor/message appearance; preserves the custom footer
├── extensions/               always-loaded TypeScript extensions
│   └── tree-rewind/          bundled extension package
├── skills/                   capabilities loaded on demand
├── prompts/                  explicit slash-command templates
├── agents/                   subagent definitions (Explore, Plan, general-purpose, final-reviewer)
├── sessions/                 local session logs (not tracked)
├── subagents/                historical custom child sessions (not imported)
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
- execute already-authorized work without redundant confirmation, including outside cwd;
- keep secret values out of model output and logs.

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
- default provider/model: OpenAI Codex, `gpt-6-astra` at thinking `high` (matches the live
  profile; the advisor and final reviewer are configured separately, see AGENTS.md);
- Anthropic OAuth provider pinned to Git release `pi-anthropic-oauth-plus@v0.3.2`;
- global OAuth identity rewriting pinned to `technical-safe`: standalone `Pi` identity text may become `Claude Code`, while `.pi`, `pi-setup`, and ordinary paths remain literal;
- per-model thinking defaults: Fable 5.1 `medium`, GPT-6 Astra `high`; the default
  level is `high`. Explicit session choices still take precedence; `/fast` stays manual;
- scoped models: `anthropic/claude-fable-5-1` and `openai-codex/gpt-6-astra`;
- fullscreen TUI, `catppuccin-mocha` theme from the themes bundle, nvim as the external editor;
- project-local trust policy: ask;
- compaction enabled (`reserveTokens: 16384`, `keepRecentTokens: 32000`);
- cache-miss notices enabled, including Pi 0.84.3+ compaction and branch-summary usage notices;
- retries enabled, with provider calls allowed up to one hour;
- installation telemetry disabled.

## Installed packages

| Package | Purpose |
|---|---|
| `pi-anthropic-oauth-plus@v0.3.2` (pinned Git) | Anthropic OAuth, 1-hour cache/keepalive, Pi 0.84.3+ request hooks, and server-side fallback pricing |
| `pi-web-search@1.4.0` (patched) | Web search tools; carries `patches/pi-web-search-oauth-system.patch` |
| `@upstash/context7-pi@0.1.2` | Context7 tools, explicit `/c7-docs`, and the on-demand `context7-docs` skill |
| `@juicesharp/rpiv-ask-user-question@2.9.0` | Structured questions, previews, free text and review UI |
| `@juicesharp/rpiv-todo@2.9.0` | Task IDs, dependencies and persistent todo panel |
| `@tintinweb/pi-subagents@0.19.0` | Agent, steering/resume, FleetView, workflows, scheduling and worktrees |
| `pi-zentui@0.22.3` | Compact Accent Rail editor, framed user messages and themed selectors; footer stays native |
| `@juicesharp/rpiv-advisor@2.9.0` | Preserved user-installed advisor package |
| `pi-background-tasks@2.5.0` | Shell jobs, logs and completion; delegate/Fusion tools also available |
| `@firstpick/pi-themes-bundle@0.1.6` | Theme bundle providing `catppuccin-mocha` |

These are exact top-level pins, not a hermetic supply-chain lock: Pi's published npm
package can resolve newer transitive versions allowed by its own ranges. `doctor.sh`
checks configured specs, installed top-level versions, OAuth commit/dirty state, and
isolated load health; it does not hash every installed npm implementation byte. OAuth
v0.3.2 honors Pi's request-body/tool-choice hooks, preserves required betas while rejecting
fine-grained tool streaming, and records the returned fallback model with its own pricing.

### Advisor configuration

`~/.config/rpiv-advisor/advisor.json` is the single source of truth for advisor model
and effort. `AGENTS.md` references that file rather than duplicating its values.
The main-session thinking settings in `settings.json` are independent. Advisor config
remains machine-local and is not copied by this repository's installer.

### Patched packages

A published package that needs a local source fix carries a unified diff under
`patches/`. `install.sh` applies each one after package reconciliation and `doctor.sh`
verifies the pinned post-image checksum of the patched file, so a reinstall, a version
bump, or a hand edit that drops the fix fails loudly instead of silently regressing.

`patches/pi-web-search-oauth-system.patch` fixes the web-search path below.
`patches/pi-subagents-activity.patch` adds a read-only activity query for rewind, including
queued/nested agents and workflows between child activations. Both post-images are verified.
`patches/pi-background-tasks-theme.patch` replaces the background dock's fixed light-blue
palette with Pi theme colors, and removes nested status colors from selected rows so text
stays legible. Both patched files have pinned checksums.

Checksums prove a patch is applied, not that it is coherent: an earlier revision of
the theme patch deleted a colour helper and left one call behind, which only showed
up as a crash when the background-task log view was opened.
`tests/patched-packages-typecheck.test.mjs` therefore compiles each patched package
against the installed Pi types and against the same tree with the patch reversed,
failing only on errors the patch itself introduces. It needs a TypeScript compiler
(any one already resolvable from this repository, the agent directory, or
`PI_SETUP_TSC`); without one the gate skips and `doctor.sh` prints a warning.
`pi-web-search` bypasses the provider and calls `/v1/messages` directly for the
Anthropic-native `web_search` tool, but sends no `system` field. A Claude Pro/Max OAuth
token is only accepted when the first system block is the Claude Code identity, so
without it Anthropic answers `429 rate_limit_error` with a generic `"Error"` message and
no `anthropic-ratelimit-*` headers - a policy rejection that reads like an exhausted
quota. The patch adds that block only for OAuth credentials and updates the OAuth
search User-Agent to Claude Code 2.1.261 (Fable 5.1 rejects versions below 2.1.251).
It also selects `web_search_20260318` with full response inclusion and dynamic filtering
by default. If code execution returns a capacity/availability error without running search,
one fresh direct search is allowed using the same tool version; its result explicitly
reports the fallback. It never retries search quota errors by switching modes.
Paused server turns replay the original content (including encrypted data, caller metadata,
signatures and container identity), with at most four requests per tool invocation.
Incomplete streams and exhausted continuation budgets are explicit failures.
API-key authentication stays unchanged; the new server-tool version applies to both auth modes.
OpenAI/Codex still uses `web_search`, inheriting the live session's thinking level on
each call and applying Pi's model capability clamp and provider effort mapping. This
replaces upstream's hard-coded `none`, which GPT-6 Astra rejects; Astra at `high`
therefore searches at `high`. Non-reasoning models omit the reasoning field, as do
older contexts without a thinking level (leaving the server default intact).
Upstream has not been notified of the local patch.

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

### Context and host access

Pi's built-in Bash, read, edit and write tools use normal host permissions. There is no
custom Auto/Manual/Plan/Bypass mode and no Seatbelt wrapper. Project trust still controls
loading project resources. AGENTS asks only for missing material choices or actions beyond
the task; authorization already given covers its necessary implementation steps.

`runtime-context.ts` owns both snapshot creation and outgoing context projection. Its
instance-local state survives compaction and is recovered from the active branch on session
start or tree navigation. The pure `lib/context-snapshots.ts` helper keeps only the current
runtime facts and removes retired permission snapshots without editing session history.
It is not a separate extension: Pi loads separate entrypoints with separate module state.
Compaction uses
Pi's own preparation: 0.85.1 already caps serialized tool results at 2,000 characters, so
no custom pruning extension is installed. `secret-guard.ts` and `spill.ts` redact known credential patterns
in output; neither restricts host access or guarantees complete redaction. Spill keeps a 32 KiB
inline budget, but handles raw Bash output files even below that budget when core truncates by
line count. A bounded full output is copied to a private redacted file before best-effort removal
of the original. If copying fails or exceeds 8 MiB, the raw locator is withheld from both the
preview and result metadata; short previews remain intact. Nonzero exits/timeouts can drop
that metadata: recognized locators in error text are suppressed without reading or deleting
the named file. Such raw temporary files may remain on disk; text alone is not file authority.

### Interaction and orchestration

Use `ask_user_question` for decisions, `todo` for tasks, `Agent` for model delegation, and
`bg_run` for shell jobs. `/todos`, `/agents`, `/jobs`, and `/logs` belong to the packages.
Package defaults govern UI and concurrency. Worktree isolation is available on request;
it may auto-commit child changes to its branch. Review before integrating. Scheduling is
available but no recurring jobs are created by this setup.

`goal.ts` retains explicit goals and autonomous continuation. It defers to already-queued
package/user follow-ups instead of scheduling a duplicate next turn. `paste-image-attach.ts`
continues to handle pasted/dragged images.

The background package's attribution entrypoint is filtered out of the main session:
`pi-anthropic-oauth-plus@v0.3.2` remains its Anthropic provider, including long cache and
keepalive. Isolated package-owned delegate/Fusion/attested children use the provider
entrypoint they explicitly load. Shell jobs have durable logs but stop on reload/shutdown.

Existing custom todo snapshots and child IDs remain readable history; the new packages
do not import or resume them. Start new delegated work with the new API.

### Model and UI helpers

Zentui owns the input/message treatments, while `statusline.ts` remains the footer owner.
Keep Footer set to **Native** in `/zentui`; Starship or Hidden would replace the custom
statusline. Accent Rail renders a one-line input in three rows including two spacer rows
(OpenCode uses six); multiline text uses its own content rows. It does not duplicate
model/effort metadata from the footer. OpenCode's empty metadata format
is not a supported hiding mechanism: Zentui replaces it with the default format.
Experimental thinking and Working-line ownership are disabled.
`zentui.json` is a managed resource included in install, backup, rollback and sync.

| Extension | Behavior | User surface |
|---|---|---|
| `fast-mode.ts` | Requests OpenAI/Codex Fast mode via `service_tier: "priority"`; never changes model or thinking effort | `/fast [on\|off\|status]` |
| `statusline.ts` | Shows cwd, git branch, selected model, actual context capacity, effort, cost, and matching Anthropic/Codex quota windows | footer; `/limits` |

Fast mode is opt-in per session (`/fast on`, or `PI_FAST_MODE=1` at startup). It applies
only to `openai` Responses/Chat Completions and `openai-codex` Responses routes; Anthropic
and other providers receive no fast-mode fields or headers. Switching to an unsupported
provider hides the fast badge and suspends the override; switching back resumes it.
`/fast off` stops overriding the tier, leaving provider/project defaults intact. Reload or a
new session resets the toggle to the startup environment setting. `priority` is the
[OpenAI Fast mode alias](https://developers.openai.com/api/docs/guides/fast-mode).
Availability, extra API cost, and Codex credit usage depend on model/account; the badge
means requested, not confirmed by the server. The extension does not adjust cost accounting
or guarantee provider fallback, latency, or cache behavior.

Statusline quota follows the selected provider/model. Anthropic shows its account windows
and the matching model-family bucket (including the API's short "Fable" name), even when its
percentage equals the account-wide weekly usage. The footer omits provider-name prefixes;
`/limits` retains them for diagnostics. Codex uses the server's window durations, including
weekly-only plans. OpenAI API-key billing is shown as quota unavailable, not as a ChatGPT
subscription. Model changes abort old requests and clear old gauges immediately. The cache
is keyed by provider and, for Codex, its hashed account claim; Anthropic's opaque token
rotates hourly and names no account, so its readings are keyed per provider instead of by
credential. Entries carry the model and the hashed credential they were read under. A model
switch reuses the account-wide windows and drops the other model's scoped bucket along with
any severity that bucket raised — the model the reading was taken under decides that, not
whether a window happened to be dropped — while an account-wide limit survives the switch.
A reading whose credential no longer matches is marked and shown only while the request that
settles it is in flight: a response replaces it, any failure removes it, its severity raises
no alarm meanwhile, and a poll held back by backoff or throttle never displays it at all
rather than risk showing another account's numbers. Returning to the credential a reading was
taken under restores it. The cache expires after 30 minutes and
stores no tokens. A `*` on a quota label means the numbers are not confirmed by the credential
in hand: either the refresh failed and the last successful reading is shown, or the reading was
taken under a credential this one cannot vouch for; `/limits` explains the failure. A 429 waits a fixed three minutes rather
than escalating to the ten-minute step — the bucket is shared with other agents, so the wait
is not this client's fault to escalate — and the boot retry is scheduled for the first moment
backoff and throttle both allow a request, instead of expiring inside the first wait.
RPC/headless children do not poll.
The Anthropic poll sends `user-agent: claude-code/<version>`: that endpoint gates on the
agent prefix rather than on request rate, and every other agent (including Node's `fetch`
default) shares one bucket that answers 429 within a couple of reads, so without the header
the footer stays at `limits n/a` no matter how long the backoff waits.
Codex uses its authenticated usage-dashboard endpoint; a changed server response degrades to
unavailable rather than invented percentages. Official rate-window semantics are documented
in [Codex account rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

Present and its private RPC helpers have been removed. Answers are no longer automatically
sent to a second model for display-only rewriting; use `/wait-what` when an explanation needs
to be clearer. Historical Present session entries are not deleted or migrated. Their recorded
cost still contributes to the footer total, but the separate `p … tok` segment is gone.

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
Code restore is offered only for the exact checkpointed user entry (never an
ancestor's state). Shutdown drains accepted backend work without installing process
signal handlers inside Pi; forced exit/crash leaves an advisory lock that must be
removed manually. See `extensions/tree-rewind/README.md` for lifecycle, retention and
index-format details.

Develop it under `extensions/tree-rewind/`, run its backend tests, then apply the
managed config and `/reload`. The old standalone repository is historical only and
is not part of restore.

## Skills

Skills are loaded only when their descriptions match the task or a prompt explicitly
requests them. In addition to the six local skills below, the Context7 package supplies
`context7-docs` for current library documentation and code examples.

| Skill | Use case |
|---|---|
| `code-review` | Review changes since a ref along Standards and Spec axes using parallel Explore agents |
| `domain-modeling` | Sharpen project terminology, maintain `CONTEXT.md`, and record gated ADRs |
| `grilling` | Stress-test the user's plan or decision through a design-tree interview |
| `handoff` | Compact the current session into a document another agent can continue from |
| `subagent` | Agent delegation, steering/resume, workflows and background shell job guidance |
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

1. Start Pi in the project directory; approve project resource loading if Pi asks.
2. Describe the task normally. Use `/grill` first when the design is unclear.
3. Watch unresolved decisions, agent activity, and the todo widget while Pi
   works.
4. Use `/review` before merging non-trivial changes.
5. Use `/wait-what` when an explanation does not land.
6. Use `/handoff` before stopping an unfinished task.
7. Use `/rewind` only after previewing the restore plan.

## Apply and capture changes

The eight managed resources are declared in `scripts/managed-paths.txt`. Apply a
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

After Pi exits, `scrub-session-secrets.sh` can redact known credential families from
session text and background `.output` logs. Default discovery resolves a symlinked home,
prunes `Library` and `node_modules`, and includes extensionless rewind blobs; it does not
add general JSON files such as `auth.json`. Structured families match the inline redactor,
including Google OAuth, Stripe and legacy OpenAI keys with at least 32 suffix characters.
The unlabelled AWS-40 heuristic remains inline-only: offline scrub deliberately leaves such
ambiguous strings unchanged to avoid damaging ordinary archived data. This is a documented
coverage gap, not a guarantee that AWS secrets are absent. Each changed file gets a unique
mode-0600 plaintext backup. `~/.pi/agent/scrub-backups.txt` is cumulative and deduplicated,
so a later run cannot hide an earlier backup. Paths containing newlines are refused because
that cleanup list is line-delimited. A detector/replacer mismatch fails without changing the
source. Verify the redacted files, delete every listed backup, then rotate exposed credentials.

## Verification

`./doctor.sh` checks managed configuration parity, exact package versions, package patch
checksums, existing utility regressions and the tree-rewind backend. It also runs
`scripts/package-smoke.mjs` against a private fixture home/config and a fake zero-cost
provider, exercising the installed package combination without reading real credentials.

Rewind queries the live package registries before preparing/applying file restore or undo.
It refuses while any agent/workflow or background job is active, including queued/nested
agents, or if package activity cannot be determined. It never stops jobs on the user's behalf.
This query coordinates one Pi session; it is not a global filesystem lock against external
programs or other Pi processes. Child worktrees and shell writes outside the project do not
become universally covered by the parent's checkpoints.

Redaction is best effort. Raw streams, unknown secret formats, binary data and external
program effects are outside its guarantee. Keepalive tests and mock model tests do not
prove real provider cache residency.

## Known trade-offs

- Package tools add their schemas to each model request; more capabilities cost context.
  Goal, workflow and Fusion tools are deliberately kept; dropping them would save a few
  thousand tokens per request but was declined. Spill's inline budget (32 KiB) and the
  rewind index format were tuned instead; per-session private checkpoint writes remain
  O(N) by design (synchronous durability before tools).
- Upstream package updates stay pinned until their APIs and local patches are rechecked.
- A main-session checkpoint is not a backup of every child worktree or arbitrary host file.
- Background shell processes stop on Pi reload/shutdown.
- Old todo/agent state is retained as history, not converted.
- The permission/sandbox layer is intentionally retired; output redaction and rewind remain.
- Migration and rollback details: [Package migration](docs/package-migration.md).
