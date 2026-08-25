---
name: grilling
description: Stress-test a plan, decision, or idea through a bounded design-tree interview. Use when the user explicitly asks to grill or challenge their thinking.
---

Interview the user until you reach a shared understanding of the **material** decisions: choices whose answer could change the recommendation, scope, risk, or implementation. Map those choices as a **design tree**; omit branches that cannot affect the outcome.

Work the tree in **rounds**. The **frontier** is every material decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you have not heard yet. Ask at most four highest-impact frontier questions in one round, number each question, and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer, with a rough confidence — e.g. "~70%, because…">
```

Attaching your best guess and confidence to each question lets the user react instead of generate — a wrong guess gets corrected faster than a blank question gets answered.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. Inspect quick facts inline. Start a background `subagent` with profile `explore` only when the fact-finding is high-volume or genuinely independent enough to benefit from a separate context; give it a complete standalone prompt and follow the Pi subagent skill (`~/.pi/agent/skills/subagent/SKILL.md`). A running exploration is an unsettled prerequisite, so only downstream questions wait for its automatic completion notice; ask other ready material questions now. The _decisions_ are the user's: put each to them and wait.

The session is done when no unresolved material decision remains. Summarize the settled design and any explicitly accepted uncertainty, then wait for the user to confirm shared understanding before acting on it.
