---
name: "subagent"
description: "Use when a task should run in a separate pi process — large read-only investigation that would flood the main context, work that must be sandboxed to read-only tools, or several independent subtasks that can run in parallel. Covers agent_spawn/agent_peek/agent_send/agent_wait/agent_kill and the raw bash equivalents."
---

# Sub-agents

A sub-agent is just pi run again, in a detached tmux pane, with its own context
window and its own session file. Nothing is hidden: the pane can be attached,
the screen can be read mid-run, and the full conversation stays on disk.

## When it is worth it

Spawning costs a fresh system prompt and a cold cache — roughly a few thousand
tokens before any work happens. It pays off in three cases:

1. **Read a lot, return a little.** "Which of these 40 files touch auth?" burns
   40 file reads in a sub-agent's context and returns three lines into yours.
2. **Tool sandboxing.** A researcher spawned with `read,grep,find,ls` cannot
   write, no matter how the task is phrased.
3. **Independent parallel work.** Three unrelated investigations at once, each
   with its own pane.

Do not spawn for work that is cheaper inline. A single file read, a quick grep,
or anything needing your current context is faster done directly.

## Tools

| Tool | Use |
|---|---|
| `agent_spawn` | Start one. Returns an id. |
| `agent_wait` | Block until it finishes; returns its full output. |
| `agent_peek` | Read its screen without blocking; shows working/idle. For oneshots this is the session-log trace, not a live screen. |
| `agent_send` | Type into an interactive one to steer or answer it. |
| `agent_resume` | Re-run a **finished oneshot** with a follow-up prompt. It continues its own session, so everything it already read stays in its context — a follow-up question costs a fraction of a fresh spawn. |
| `agent_kill` | Stop it. Artifacts stay on disk. |

### Modes

- **`oneshot`** — runs `pi -p`, writes `out.md`, exits. Default choice. Pair
  with `agent_wait`.
- **`interactive`** — a live pi TUI that stays open. Drive it with `agent_send`
  + `agent_peek`, and always `agent_kill` when done.

The modes differ in one way that matters to the user, not just to you: a
`oneshot` runs in print mode, which has no input loop, so nobody can correct it
once started — not you, and not the user attaching to its pane. An
`interactive` agent accepts input from both of you until it is killed.

So prefer `interactive` when the task is long, exploratory, or likely to go off
course, and tell the user they can attach to steer it. Use `oneshot` for work
that is well-specified enough that intervention should not be needed.

`agent_wait` returns the sub-agent's last answer read from its session file, so
any steering — yours or the user's — is reflected in what you get back.

Collecting means different things per mode. A `oneshot` is finished: its pane is
reaped and it disappears from the list. An `interactive` agent is only idle: it
stays alive, stays in the list, and still accepts `agent_send`, which is what
makes follow-up questions cheap. It also means you must `agent_kill` it when you
are done, or it runs until the machine reboots.

Reports are capped at 24k characters. If one is truncated the tool says so and
gives the path to the full output — read it with `read` only if you actually need
the rest.

### Roles

- **`researcher`** — read-only local tools, inherits your model. Investigation and search on this machine. For bulk mechanical scans that need volume rather than judgment, pass `model: claude-haiku-4-5` explicitly — but know that cheap exploration tends to be shallow exploration.
- **`web-researcher`** — web search + library docs, no filesystem tools or project context files, cheap model. This is tool-level least privilege, not process isolation.
- **`reviewer`** — read-only, runs on whatever model you are running. Critique, audits.
- **`implementer`** — full local tools + docs lookup, no `web_search` tool, same model as you. Bash still has host network access; use only for attended work in a trusted workspace.

Filesystem and web-search TOOLS do not meet in one child. This reduces accidental
egress, but does not isolate the process: global extension code runs with host authority,
and implementer Bash retains network. If a task needs both tool families, run two agents
and join the results yourself.

Reviewers and implementers get a `git status` snapshot in their brief (taken at
spawn); researchers do not — their briefs should stand on their own.

A local/reviewer/implementer sub-agent loads project settings, skills and extensions
only if the user has already trusted the project. In an untrusted directory it runs
with global resources only. A web-researcher always uses `--no-approve` and
`--no-context-files`, regardless of saved trust.

## Writing the brief

The `task` argument becomes `brief.md`, which is the sub-agent's entire starting
context. It knows nothing about this conversation. A brief that assumes shared
context produces a confidently wrong answer.

Include: the goal, the paths to start from (`files`), what "done" looks like
(`deliverable`), and any constraint that matters. Prefer naming files over
describing them.

Bad: "check if the auth thing is still broken"
Good: "Read src/auth/session.ts and src/auth/refresh.ts. Determine whether the
refresh token is rotated on every use. Report the exact line numbers that decide
this, or state clearly that it is not rotated."

## Patterns that work

**Chain: reviewer → implementer.** The reviewer physically cannot "helpfully" fix
things mid-review, and the implementer applies only the named findings. Feed the
reviewer's report into the implementer's brief — do not make the implementer
re-derive the critique.

**Fan-out, kept small.** Independent investigations can run in parallel, each in its
own pane. Every report costs up to 24k characters of *your* context on collection, so
three agents is a fan-out and ten is re-flooding the window you were protecting.

**Follow-up: resume, don't respawn.** If a finished oneshot's report raises a
question, `agent_resume` continues the same session — the agent still "remembers"
every file it read. Respawning with a bigger brief re-pays the entire exploration.

## Reading results

`agent_wait` returns the sub-agent's report. Treat it as a claim, not a fact:
it is a separate model run with no view of your context. Verify anything
surprising against the files before acting on it.

If a result looks wrong, the whole conversation is on disk. Tell the user:

```
pi --session-dir .pi/agents/<id>/sessions -r
```

They can read it, `/tree` it, or `/fork` it and continue from any point.

## Where agents appear

The list shows every agent this project started, including ones pointed at a
different `cwd`. A label therefore does not imply the agent is working inside
this repository — say which directory it is working in when that matters.

## Watching a sub-agent

While one is running the user can attach and interact with it directly:

```
tmux -L piagents attach -t <id>
```

Detach with `Ctrl-b d` (that socket uses the default prefix, not the user's
`C-a`). `/agents` lists everything running.

## Limits

- A sub-agent cannot spawn sub-agents; `PI_SUBAGENT_DEPTH` blocks it. If you are
  a sub-agent, do the work yourself.
- Two `implementer` agents writing the same files will conflict. Give parallel
  implementers separate git worktrees, or run them one at a time.
- Artifacts accumulate in `.pi/agents/<id>/`. Mention this if the user is
  working in a repo they care about keeping clean.

## Without the extension

The tools are conveniences over plain bash. The underlying move is always the
same, and works anywhere pi runs:

```bash
pi -p -t read,grep,find,ls --model claude-haiku-4-5 \
   --session-dir .pi/agents/research-x1/sessions -n research "…task…" > out.md
```

(Each agent gets its own `sessions/` directory — sharing one would make `-c`
resume whichever agent happened to write last.)
