---
description: Implement incrementally — build, test, verify, commit. "auto" runs the whole plan in one approved pass
argument-hint: "[auto]"
---
Read and apply /Users/tung/.pi/agent/skills/incremental-implementation/SKILL.md, together with /Users/tung/.pi/agent/skills/tdd/SKILL.md for the test-first loop.

Mode: ${1:-single}

- `single` — implement the next pending task or slice, then stop for review.
- `auto` (or `all`) — present the full plan once, get my approval, then implement every task without stopping between them. Autonomous mode runs the same per-slice loop (implement → test → verify → commit); it only removes me stepping between tasks.
