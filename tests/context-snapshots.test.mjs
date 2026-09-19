import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PERMISSION_MODE_CONTEXT_TYPE,
  RUNTIME_CONTEXT_TYPE,
  keepLatestContextSnapshots,
  projectCurrentContextSnapshots,
} from "../extensions/lib/context-snapshots.ts";
import runtimeContext, { createRuntimeSnapshotter } from "../extensions/runtime-context.ts";

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
    ],
  );
  assert.equal(filtered.some((message) => message.role === "compactionSummary"), true);

  let handler;
  runtimeContext({ on(name, candidate) { if (name === "context") handler = candidate; } });
  assert.deepEqual(handler({ messages }).messages, filtered);
});

test("current snapshots are reinserted when compaction removed their durable messages", () => {
  const compacted = [{ role: "compactionSummary", summary: "older context", tokensBefore: 100, timestamp: 3 }];
  const projected = projectCurrentContextSnapshots(compacted, "runtime-current");
  assert.deepEqual(
    projected.filter((message) => message.role === "custom").map((message) => [message.customType, message.content]),
    [[RUNTIME_CONTEXT_TYPE, "runtime-current"]],
  );
  assert.deepEqual(projectCurrentContextSnapshots(projected, "runtime-current"), projected, "repeated projection must not duplicate snapshots");

  const stale = projectCurrentContextSnapshots([
    custom(RUNTIME_CONTEXT_TYPE, "runtime-stale"),
    custom(PERMISSION_MODE_CONTEXT_TYPE, "mode-stale"),
  ], "runtime-current");
  assert.deepEqual(stale.map((message) => message.content), ["runtime-current"]);
  assert.deepEqual(projectCurrentContextSnapshots(compacted, null), compacted);
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

test("runtime context recovers the active branch after tree navigation and omits duplicate cwd", async () => {
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
    const current = await createRuntimeSnapshotter().build(cwd);
    assert.equal(current.includes(cwd), false);
    assert.equal(current.includes("Working directory:"), false);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: current }];
    handlers.get("session_start")({}, ctx);
    assert.equal(await handlers.get("before_agent_start")({}, ctx), undefined);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: "stale" }];
    handlers.get("session_tree")({}, ctx);
    const emitted = await handlers.get("before_agent_start")({}, ctx);
    assert.equal(emitted.message.customType, RUNTIME_CONTEXT_TYPE);
    assert.equal(emitted.message.content, current);

    branch = [{ type: "custom_message", customType: RUNTIME_CONTEXT_TYPE, content: current }];
    handlers.get("session_tree")({}, ctx);
    assert.equal(await handlers.get("before_agent_start")({}, ctx), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("async git snapshot reuses the last good value after a bounded query failure", async () => {
  let now = new Date("2026-09-02T10:00:00Z").getTime();
  let calls = 0;
  const snapshots = createRuntimeSnapshotter(async (_cwd, timeoutMs) => {
    assert.equal(timeoutMs, 2_000);
    calls++;
    if (calls === 1) return "## main...origin/main\n M changed.ts\n";
    throw new Error("synthetic timeout");
  }, () => now, 10);

  const first = await snapshots.build("/synthetic/repo");
  assert.match(first, /Git: branch main, 1 dirty file/);
  now += 11;
  const second = await snapshots.build("/synthetic/repo");
  assert.equal(second, first, "a timeout must not churn the emitted snapshot");
  assert.equal(calls, 2);
});
