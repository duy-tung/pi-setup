import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import contextSnapshots, {
  PERMISSION_MODE_CONTEXT_TYPE,
  RUNTIME_CONTEXT_TYPE,
  keepLatestContextSnapshots,
  projectCurrentContextSnapshots,
  setCurrentContextSnapshot,
} from "../extensions/context-snapshots.ts";
import runtimeContext, { buildRuntimeSnapshot } from "../extensions/runtime-context.ts";

const custom = (customType, content) => ({
  role: "custom",
  customType,
  content,
  display: false,
  timestamp: 1,
});

test("outgoing context keeps only each newest managed snapshot without mutating history", () => {
  const messages = [
    { role: "user", content: "start", timestamp: 1 },
    custom(RUNTIME_CONTEXT_TYPE, "runtime-old"),
    custom("unrelated", "keep-one"),
    custom(PERMISSION_MODE_CONTEXT_TYPE, "mode-old"),
    { role: "compactionSummary", summary: "opaque", tokensBefore: 10, timestamp: 2 },
    custom(RUNTIME_CONTEXT_TYPE, "runtime-new"),
    custom("unrelated", "keep-two"),
    custom(PERMISSION_MODE_CONTEXT_TYPE, "mode-new"),
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },
  ];
  const before = structuredClone(messages);
  const filtered = keepLatestContextSnapshots(messages);

  assert.deepEqual(messages, before);
  assert.deepEqual(
    filtered.filter((message) => message.role === "custom").map((message) => [message.customType, message.content]),
    [
      ["unrelated", "keep-one"],
      [RUNTIME_CONTEXT_TYPE, "runtime-new"],
      ["unrelated", "keep-two"],
      [PERMISSION_MODE_CONTEXT_TYPE, "mode-new"],
    ],
  );
  assert.equal(filtered.some((message) => message.role === "compactionSummary"), true);

  let handler;
  contextSnapshots({ on(name, candidate) { if (name === "context") handler = candidate; } });
  assert.deepEqual(handler({ messages }).messages, filtered);
});

test("current snapshots are reinserted when compaction removed their durable messages", () => {
  try {
    setCurrentContextSnapshot(RUNTIME_CONTEXT_TYPE, "runtime-current");
    setCurrentContextSnapshot(PERMISSION_MODE_CONTEXT_TYPE, "mode-current");
    const compacted = [{ role: "compactionSummary", summary: "older context", tokensBefore: 100, timestamp: 3 }];
    const projected = projectCurrentContextSnapshots(compacted);
    assert.deepEqual(
      projected.filter((message) => message.role === "custom").map((message) => [message.customType, message.content]),
      [
        [RUNTIME_CONTEXT_TYPE, "runtime-current"],
        [PERMISSION_MODE_CONTEXT_TYPE, "mode-current"],
      ],
    );
    assert.deepEqual(projectCurrentContextSnapshots(projected), projected, "repeated projection must not duplicate snapshots");

    const stale = projectCurrentContextSnapshots([
      custom(RUNTIME_CONTEXT_TYPE, "runtime-stale"),
      custom(PERMISSION_MODE_CONTEXT_TYPE, "mode-stale"),
    ]);
    assert.deepEqual(stale.map((message) => message.content), ["runtime-current", "mode-current"]);
  } finally {
    setCurrentContextSnapshot(RUNTIME_CONTEXT_TYPE, null);
    setCurrentContextSnapshot(PERMISSION_MODE_CONTEXT_TYPE, null);
  }
});

test("snapshot projection is branch-local", () => {
  const branchA = keepLatestContextSnapshots([
    custom(RUNTIME_CONTEXT_TYPE, "a-old"),
    custom(RUNTIME_CONTEXT_TYPE, "a-new"),
  ]);
  const branchB = keepLatestContextSnapshots([
    custom(RUNTIME_CONTEXT_TYPE, "b-old"),
    custom(RUNTIME_CONTEXT_TYPE, "b-new"),
  ]);
  assert.equal(branchA[0].content, "a-new");
  assert.equal(branchB[0].content, "b-new");
});

test("runtime context recovers the active branch after tree navigation and omits duplicate cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-runtime-context-"));
  try {
    const handlers = new Map();
    runtimeContext({
      on(name, handler) {
        handlers.set(name, handler);
      },
    });
    let branch = [];
    const ctx = {
      cwd,
      sessionManager: { getBranch: () => branch },
    };
    const current = buildRuntimeSnapshot(cwd);
    assert.equal(current.includes(cwd), false);
    assert.equal(current.includes("Working directory:"), false);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: current }];
    handlers.get("session_start")({}, ctx);
    assert.equal(handlers.get("before_agent_start")({}, ctx), undefined);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: "stale" }];
    handlers.get("session_tree")({}, ctx);
    const emitted = handlers.get("before_agent_start")({}, ctx);
    assert.equal(emitted.message.customType, RUNTIME_CONTEXT_TYPE);
    assert.equal(emitted.message.content, current);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: current }];
    handlers.get("session_tree")({}, ctx);
    assert.equal(handlers.get("before_agent_start")({}, ctx), undefined);
  } finally {
    setCurrentContextSnapshot(RUNTIME_CONTEXT_TYPE, null);
    setCurrentContextSnapshot(PERMISSION_MODE_CONTEXT_TYPE, null);
    rmSync(cwd, { recursive: true, force: true });
  }
});
