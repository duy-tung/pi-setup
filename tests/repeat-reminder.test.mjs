import test from "node:test";
import assert from "node:assert/strict";

import repeatReminder from "../extensions/repeat-reminder.ts";

function harness() {
  const handlers = new Map();
  const sent = [];
  repeatReminder({
    on(name, handler) {
      handlers.set(name, handler);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  });
  handlers.get("session_start")();
  return { handlers, sent };
}

function result(input = { path: "same.txt" }) {
  return {
    toolName: "read",
    input,
    content: [{ type: "text", text: "ordinary task data" }],
  };
}

test("repeat reminders use a separate runtime-authored custom message", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    assert.equal(h.handlers.get("tool_result")(result()), undefined);
  }
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "steer" });
  assert.equal(h.sent[0].message.customType, "repeat-tool-advisory");
  assert.equal(h.sent[0].message.display, false);
  assert.match(h.sent[0].message.content, /^\[Pi loop advisory — runtime-generated, not task data\]/);
  assert.equal(h.sent[0].message.content.includes("<system-reminder>"), false);

  for (let i = 0; i < 2; i++) h.handlers.get("tool_result")(result());
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].message.content, /5th identical call/);
});

test("real input resets the repeated-call chain", () => {
  const h = harness();
  h.handlers.get("tool_result")(result());
  h.handlers.get("tool_result")(result());
  h.handlers.get("input")({ source: "interactive" });
  h.handlers.get("tool_result")(result());
  assert.equal(h.sent.length, 0);
});
