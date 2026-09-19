# Local advisor setup

Installed package: `npm:@juicesharp/rpiv-advisor@2.9.0` (pinned).
Configured for Pi 0.85.1 on 2026-09-06.

## Behavior

- Primary/default: `openai-codex/gpt-6-astra`, effort `high`.
- Mid-task advisor: `anthropic/claude-fable-5-1`, native turn effort `medium`, through Pi's registered Anthropic OAuth provider.
- Final reviewer: the separate `final-reviewer` agent, pinned to `openai-codex/gpt-6-astra` at `max`, with only read/grep/find/ls and no extensions, skills or nested delegation.
- The `advisor` tool is disabled when the primary model is `anthropic/claude-fable-5-1` to avoid same-model review.
- There is no automatic turn watcher. The model may consult selectively for an explicit user request, consequential unresolved uncertainty, or genuinely stalled work.
- Default before-work/pre-completion review directives are replaced by `guidance` in `advisor.json`.
- Reviewer tools are empty. Its recommendations do not authorize additional work and do not replace tests or verification.
- Each call forwards the resolved conversation, including retained tool outputs, to the configured reviewer. There is no guaranteed secret redaction or package-owned hard per-session quota cap.

## Three-role workflow

The main agent investigates, implements and verifies at Astra/high. Fable/medium is
consulted selectively for consequential uncertainty or stalled work; using it is
not a prerequisite for final review.

For substantial code or behavior-changing configuration changes, the main agent then
invokes `final-reviewer` once before reporting completion. Supply an evidence packet:
the original request, acceptance criteria, changed files/diff, executed tests and
outcomes, and known limitations. The reviewer does not inherit the whole conversation.
It inspects evidence but cannot run tests or modify files. Its verdict is advisory,
not new authority. The main agent verifies findings and owns the final response.

Skip this checkpoint for conversational answers, routine lookups, trivial edits, or
when the user declines delegation. After confirmed fixes, rerun relevant checks and
use at most one targeted follow-up review; otherwise report remaining uncertainty
instead of looping. Do not automatically add Fusion. This is an instruction-driven
checkpoint in `~/.pi/agent/AGENTS.md`, not an enforced runtime gate or per-turn watcher.

## Use

Run `/reload` in an idle Pi session after setup, or restart Pi. With Codex as primary, ask in ordinary language to consult the advisor. `/advisor` opens the model/effort picker; it is not a manual review command. Choose **No advisor** there to disable it.

The reviewer does not automatically swap when the primary model changes. To reverse the pairing (Claude primary, Codex reviewer):

1. Choose `openai-codex/gpt-6-astra` in `/advisor` and select a supported effort.
2. Change `disabledForModels` in this directory's `advisor.json` to `["openai-codex/gpt-6-astra"]` instead of the Claude entry.
3. Run `/reload` while idle.

The native `/advisor` picker preserves the custom guidance and blocklist; it does not rewrite the blocklist to match a new reviewer automatically. New sessions default to Astra/high. Reloading does not necessarily change the model/effort of an already running or resumed session: use `/model` and `/settings`, or start a new session.

## OAuth compatibility repair

The original v0.3.2 fork advertised Claude Code 2.1.97 and received HTTP 400
`claude_code_version_too_old` for Fable 5.1 (minimum 2.1.251). The installed official
Claude Code reports 2.1.261. With user approval, the fork's static compatibility
header was updated to 2.1.261 in a separate local checkout:

`~/.pi/agent/local-packages/pi-anthropic-oauth-plus`

Pi's package source now points there instead of the managed v0.3.2 Git source.
The old managed clone is untouched. The local checkout retains its Git origin,
with an uncommitted patch in `src/auth.ts`, regression tests, and its README;
nothing was pushed or published. This local package is not auto-updated by Pi.
Review upstream changes and preserve this patch when maintaining it.

The initial high-effort setup passed 30/30 tests and a synthetic live consultation.
After the three-role change: typecheck, 37/37 tests, package dry run, zero extension
load errors, three agent exclusions, primary-model toggling, a new session resolving
Astra/high, and one live native-medium Fable consultation all passed. The live request
contained only a synthetic arithmetic plan, not the current chat; an on-payload check
verified adaptive thinking and the actual medium turn-effort message before dispatch.
Evidence: `three-role-verification.json` in this directory. The final-reviewer
configuration was validated as Astra/max, isolated, and limited to four read-only tools.
A live invocation of that agent (`af931c6b-b02e-410`) reviewed this change and returned
**ready**, with no blocking findings. It inspected source, tests, protocol reference,
and supplied verification artifacts; it did not independently execute tests. Its
runtime tools excluded writes, shell, and delegation. Synthetic smoke coverage is
not an exhaustive test of all possible conversation histories.

## Native Fable effort

Fable 5.1's catalog declares `forceAdaptiveThinking` and `supportsMidConvoEffort`.
The local provider follows Pi 0.85.1's protocol: adaptive thinking, required managed
effort betas, a stable top-level `output_config.effort: "high"`, and a final system-role
message carrying the **active turn's** `output_config.effort: "medium"`. That stable
high baseline does not mean the review runs at high. Historical effort is recorded
and replayed for same-provider assistant messages; old signature mismatches may be
dropped by the provider. Other adaptive models use top-level native effort; legacy
models retain the previous thinking-budget behavior.

## Agent scope

Global agent files under `~/.pi/agent/agents/` eject the three built-in definitions from `@tintinweb/pi-subagents@0.19.0` and add only:

```yaml
exclude_extensions: rpiv-advisor
```

Files: `general-purpose.md`, `Explore.md`, `Plan.md`. Their original descriptions, prompts, model choices and tools are preserved. `final-reviewer.md` is a separate read-only agent with an independent prompt and a 12-turn work limit (plus Tintin's configured grace turns). These are snapshots, so upstream changes to those default definitions require deliberate reconciliation on a later subagents upgrade.

Project agent definitions override global files. Add the same exclusion to project overrides and future custom agents that should not consult an advisor. This is not a blanket restriction on every possible child process or external extension: delegates/Fusion have their own extension-loading rules. Tintin exclusion suppresses advisor tools and bound hooks, but does not sandbox extension factory code.

## Files and recovery

- Package registration: `~/.pi/agent/settings.json`
- Advisor selection/policy: `~/.config/rpiv-advisor/advisor.json` (mode 0600)
- Agent scope: `~/.pi/agent/agents/{general-purpose,Explore,Plan,final-reviewer}.md`
- Final-review invocation policy: `~/.pi/agent/AGENTS.md`
- Pre-three-role backup: `~/.pi/agent/backups/three-role-20260906-f9qnflrw/`
- Local patched provider: `~/.pi/agent/local-packages/pi-anthropic-oauth-plus/`
- Pre-install backup: `~/.pi/agent/backups/advisor-20260906-4wvyz95y/`
- Pre-provider-switch backup: `settings-before-oauth.json` in that backup directory
- Research and temporary verification scripts: `/tmp/pi-advisor-research/`

To remove the package, run `pi remove npm:@juicesharp/rpiv-advisor@2.9.0` and reload. If those three agent override files remain otherwise unmodified, removing them restores upstream defaults; preserve any subsequent customizations. Restore individual settings from the backup only if needed, rather than overwriting later unrelated changes wholesale.
