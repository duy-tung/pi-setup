---
description: Compact this session into a handoff document a fresh agent can pick up
argument-hint: "[focus]"
---
Read and apply ~/.pi/agent/skills/handoff/SKILL.md if it exists; otherwise write the handoff yourself: goal, current state, decisions made (with reasons), files touched, what remains, and the exact next step. No conversation narration — only what a fresh agent needs.

Focus: ${@:-the current task}

Write it to a temp path and print the path.
