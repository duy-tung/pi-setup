---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?

Both axes run as **parallel subagents** so they do not pollute each other's context, then this skill aggregates their findings. Use the Pi subagent skill (`~/.pi/agent/skills/subagent/SKILL.md`): issue both `subagent` calls together with profile `explore` and `run_in_background: false`. Pi executes the independent tool calls concurrently and returns both reports in the same parent step.

Locate the spec/requirements using step 2. Ask the user only if those inspectable sources do not identify it. If there is no spec, review the Standards axis only and note that the Spec axis was skipped.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via whatever issue-tracker workflow the repo documents, or ask the user for the issue contents.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

Read and apply [STANDARDS-RUBRIC.md](./STANDARDS-RUBRIC.md). It contains the shared smell baseline, review axes, and severity vocabulary. Documented repository standards override its heuristic baseline, and tooling-enforced rules do not need manual findings.

### 4. Start both subagents in parallel

Issue both `subagent` calls in the same assistant message with profile `explore` and `run_in_background: false`. The fixed profile is read-only, so neither child can "helpfully" fix what it finds. Each `prompt` must be self-contained because a fresh child sees none of this conversation. Use a short axis name as `description`.

**Standards sub-agent brief** — include:

- The full diff command and commit list.
- The exact resolved path to `STANDARDS-RUBRIC.md` beside this skill (normally `~/.pi/agent/skills/code-review/STANDARDS-RUBRIC.md`); tell the child to read it before reviewing instead of copying the rubric into the tool argument.
- The list of standards-source files you found in step 3.
- The brief: "Apply the rubric's axes and severity vocabulary. Per relevant file/hunk, report documented-standard violations with the cited rule and baseline smells with the quoted hunk. Distinguish hard violations from judgement calls, skip tooling-enforced rules, and lead with Critical/Important findings. Under 400 words."

**Spec sub-agent brief** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
