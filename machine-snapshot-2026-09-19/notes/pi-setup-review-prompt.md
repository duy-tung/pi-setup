# Review the full Pi setup on this machine

You are performing an independent, read-only review of my Pi coding-agent setup.
Do not edit, delete, install, commit, push, or `/reload` anything. Do not open
`auth.json`, `sessions/`, `spill/`, `rewind/`, `trust.json`, or any credential-shaped
file; never print secret values. Read only what the review needs.

## What to review

Live installation: `~/.pi/agent/` (managed resources: `AGENTS.md`, `settings.json`,
`zentui.json`, `scrub-session-secrets.sh`, `extensions/`, `skills/`, `prompts/`).
Portable source: `~/repos/pi-setup/` (installer `install.sh`, `doctor.sh`,
`sync-from-live.sh`, `scripts/`, `tests/`, `patches/`, `docs/`, `README.md`).
Pi itself: `@earendil-works/pi-coding-agent` 0.85.1 under mise Node 24.15.0
(`~/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/`);
its `docs/` folder is the authority for extension/settings/package APIs.
Advisor config: `~/.config/rpiv-advisor/advisor.json` (single source of truth for
advisor model/effort; do not propose duplicating its values elsewhere).
Agent definitions: `~/.pi/agent/agents/*.md` (`final-reviewer` is pinned to
`openai-codex/gpt-6-astra` at `max`; keep that).

## Current intended state (verify, do not assume)

- Daily models: `openai-codex/gpt-6-astra` at `high` (default) and
  `anthropic/claude-fable-5-1` at `medium`. Fast mode (`/fast`) is opt-in per session.
- 9 local extensions remain: `context-snapshots`, `fast-mode`, `goal`,
  `paste-image-attach`, `runtime-context`, `secret-guard`, `spill` (inline cap 32 KiB),
  `statusline`, and the bundled `tree-rewind/` package; shared libs
  `lib/{package-activity,redact,statusline-usage}.ts`.
- Recently removed on purpose: `present.ts` + `lib/subagent-rpc.ts` +
  `lib/pi-invocation.ts`, `repeat-reminder.ts`, `lib/effects.ts`, `compaction-prune.ts`.
  Flag any dangling reference to them.
- External packages (exact pins, see `settings.json`): pi-anthropic-oauth-plus v0.3.2
  (local patched), pi-web-search 1.4.0 (patched), @upstash/context7-pi 0.1.2,
  rpiv ask-user-question / todo / advisor 2.9.0, @tintinweb/pi-subagents 0.19.0
  (patched), pi-zentui 0.22.3, pi-background-tasks 2.5.0 (only the
  `background-tasks.ts` entrypoint), plus a live-only themes bundle.
- Live and source intentionally differ in some places (source default model/theme,
  OAuth source form, themes bundle). Report divergences, but classify them as
  intentional vs. accidental rather than demanding a full sync.

## Questions to answer

1. **Correctness against Pi 0.85.1**: does every extension use only documented
   events/APIs? Note any reliance on private methods (e.g. paste-image's editor
   override) and whether the fallback is safe if Pi changes.
2. **Redundancy**: does any remaining extension duplicate what Pi core or an installed
   package already does? Cite the core/package code that makes it redundant.
3. **Context cost**: which extensions/packages add tool schemas or per-turn text to
   requests? Estimate order of magnitude and say which are worth it.
4. **Failure modes**: what happens on reload, session resume, `/tree` navigation,
   compaction, background jobs, and provider switch (Anthropic ⇄ Codex)? Look for
   state that leaks across sessions or branches.
5. **Security/privacy**: secret handling (redact patterns, spill files, statusline
   cache, scrub script), what leaves the machine and to which provider, and any path
   where credentials could reach logs, docs, or a third-party model.
6. **Installer/doctor/tests**: are managed paths, patch checksums, package pins, and
   smoke/regression tests consistent with what is actually installed? Do the docs
   (`README.md`, `docs/pi-setup-tieng-viet.md`, `docs/package-migration.md`) describe
   the current state accurately?
7. **Instructions quality**: is `AGENTS.md` internally consistent, free of stale
   references, and not duplicating advisor/reviewer settings that live elsewhere?

## Output

Vietnamese, result-first. Structure:

1. Verdict in one paragraph.
2. Findings table: severity (blocker / should-fix / nice-to-have / info), file:line,
   what is wrong, evidence, recommended change. Only include findings you verified
   by reading code or docs; label inferences explicitly.
3. Intentional live/source divergences you confirmed (short list).
4. Items you could not verify and why (e.g. needs a paid provider call or TUI).

Do not pad with praise. Do not propose new machinery unless it fixes a verified
problem. Prefer "remove" or "one-line change" over "add a layer".
