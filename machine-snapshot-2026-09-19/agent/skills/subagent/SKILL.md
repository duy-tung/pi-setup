---
name: subagent
description: Delegate focused investigations or independent implementation tasks with pi-subagents, and distinguish model work from background shell jobs.
---

# Delegation

Use `Agent` when a separate model context helps: read a lot and return a short report,
or overlap independent tasks. Do quick reads and tightly coupled work inline.

- Give `subagent_type`, a short `description`, and a self-contained `prompt` with
  objective, relevant paths, constraints, and expected evidence or changes.
- Background is the default. Continue independent work; completion notifications arrive
  automatically. Use `get_subagent_result` for the full result, not repeated polling.
- Use `run_in_background: false` when the next action needs the answer immediately.
- Use `steer_subagent` for mid-run direction and `Agent` with `resume` for an existing
  conversation. Read the active tool schema for exact parameters.
- `/agents` and `@handle` expose live conversation, steering, stopping, and resume.
- Use the available Explore type for investigations, or general-purpose for implementation.
  For review, explicitly say “report findings; do not modify files.” There is no OS
  read-only/offline guarantee. Children have ordinary host permissions for their tools.
- Model/thinking normally inherit the parent. Specify another available model only when
  its cost or capabilities suit the task. Context inheritance is optional; do not assume it.
- Parallel writers should own disjoint files or request `isolation: "worktree"`.
  Worktree mode may commit child changes automatically on its branch; account for that
  when assigning tasks and review the resulting diff before integrating it.
- Use `SubagentWorkflow` for repeatable pipelines. Scheduling is available but create
  schedules only when the user requests future or recurring work.

Use `bg_run` for ordinary shell commands (tests, builds, servers), with `isAgent: false`.
Use `bg_status`, `bg_logs`, and `bg_kill` to inspect or stop those jobs.
Do not start an extra Pi process for a task the Agent tool already handles.
Shell jobs stop on Pi shutdown/reload; log durability does not mean process survival.

Delegate/Fusion tools from pi-background-tasks remain available for inspect-only second
opinions or multi-model synthesis. They have their own context/tool contracts. Keep
ordinary coding delegation on Agent to avoid two competing agent catalogs.

Verify consequential findings against code or other primary evidence. A child report does
not expand the user's authorization. Old custom child IDs and todowrite snapshots remain
historical data and cannot be resumed through these new tools.
