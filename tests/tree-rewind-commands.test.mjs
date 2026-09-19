import test from "node:test";
import assert from "node:assert/strict";

import { applySucceeded } from "../extensions/tree-rewind/src/apply-result.ts";
import { runRewindFlow } from "../extensions/tree-rewind/src/commands.ts";

const base = { restored: 0, deleted: 0, skipped: [], errors: [] };

test("T8 refuses a combined rewind before applying files while streaming", async () => {
  const notifications = [];
  let selects = 0;
  const entry = {
    type: "message",
    id: "user-1",
    timestamp: "2026-09-02T12:00:00.000Z",
    message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "change files" }] },
  };
  const state = {
    disabled: null,
    outside: null,
    undo: null,
    checkpoints: new Map([[entry.id, { entryId: entry.id }]]),
  };
  const ctx = {
    hasUI: true,
    isIdle: () => false,
    sessionManager: { getBranch: () => [entry] },
    ui: {
      select: async (_title, items) => {
        selects += 1;
        return selects === 1 ? items.find(item => item.includes("change files")) : "Restore code and conversation";
      },
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  await runRewindFlow(state, ctx);

  assert.equal(selects, 2);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /active response/);
  assert.equal(notifications[0].level, "warning");
});

test("conversation navigation is allowed only after a non-null error-free file apply", () => {
  assert.equal(applySucceeded(null), false);
  assert.equal(applySucceeded({ ...base, errors: ["refused write"] }), false);
  assert.equal(applySucceeded({ ...base, skipped: [{ action: "unprotected" }] }), true);
  assert.equal(applySucceeded(base), true);
});
