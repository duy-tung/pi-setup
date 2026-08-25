# Standards review rubric

Apply documented repository standards first. A documented repo rule overrides this baseline, and tooling-enforced rules do not need manual findings. Baseline smells are judgement calls, never hard violations by themselves.

## Smell baseline

- **Mysterious Name** — a function, variable, or type whose name does not reveal what it does or holds. Rename it; if no honest name emerges, the design is unclear.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file. Extract the shared shape and call it from both.
- **Feature Envy** — a method reaches into another object's data more than its own. Move the behavior toward the data it uses.
- **Data Clumps** — the same fields or parameters repeatedly travel together. Bundle the concept into one type.
- **Primitive Obsession** — a primitive or string stands in for a domain concept. Introduce a small domain type when it clarifies invariants.
- **Repeated Switches** — the same switch or conditional cascade recurs for the same concept. Centralize the mapping or use polymorphism.
- **Shotgun Surgery** — one logical change requires scattered edits across many files. Gather what changes together.
- **Divergent Change** — one module changes for several unrelated reasons. Split responsibilities.
- **Speculative Generality** — abstractions, parameters, or hooks serve needs the spec does not have. Remove or inline them until a real need appears.
- **Message Chains** — callers navigate long object chains. Hide the traversal behind the object that owns it.
- **Middle Man** — a layer mostly delegates without adding policy or abstraction value. Call the real target directly.
- **Refused Bequest** — a subtype ignores most inherited behavior. Prefer composition or a narrower contract.

## Review axes

Walk the diff across:

- **Correctness** — claimed behavior, edge cases, and error paths.
- **Readability** — understandable names, control flow, and local reasoning.
- **Architecture** — fit with existing structure and absence of needless machinery.
- **Security** — input validation, secrets, injection, and authority boundaries.
- **Performance** — obvious hot-loop waste, unnecessary I/O, or N+1 behavior.

Label each finding:

- **Critical** — blocks merge: security hole, data loss, or broken behavior.
- **Important** — should be fixed before merge.
- **Suggestion** — worth considering but not required.

Lead with Critical and Important findings. Do not bury a real issue under style nits.
