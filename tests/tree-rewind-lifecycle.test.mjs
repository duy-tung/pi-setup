import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkpointCurrentUserEntry } from "../extensions/tree-rewind/src/index.ts";
import { pickCheckpointForEntry, projectModeChangeCount, restoreProjectModes, toRelPath } from "../extensions/tree-rewind/src/checkpoints.ts";

function state() {
  return {
    currentPrompt: "current prompt",
    currentEntryId: "previous-entry",
    lastGap: null,
  };
}

test("T1 turn_start binds the checkpoint to the current persisted user entry", async () => {
  const rewind = state();
  const calls = [];
  const leaf = {
    type: "message",
    id: "current-user-entry",
    timestamp: "2026-09-02T12:00:00.000Z",
    message: { role: "user" },
  };
  const ctx = {
    sessionManager: { getLeafEntry: () => leaf },
    hasUI: false,
  };
  const checkpoint = { entryId: leaf.id };

  const result = await checkpointCurrentUserEntry(rewind, ctx, async (...args) => {
    calls.push(args);
    return checkpoint;
  });

  assert.equal(result, checkpoint);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "current-user-entry");
  assert.equal(calls[0][2], "current prompt");
  assert.equal(calls[0][3], Date.parse(leaf.timestamp));
  assert.equal(rewind.currentEntryId, "current-user-entry");
});

test("T1 does not bind a checkpoint to the previous non-user leaf", async () => {
  const rewind = state();
  let called = false;
  const ctx = {
    sessionManager: {
      getLeafEntry: () => ({ type: "message", id: "previous-assistant", message: { role: "assistant" } }),
    },
    hasUI: false,
  };

  const result = await checkpointCurrentUserEntry(rewind, ctx, async () => {
    called = true;
    return {};
  });

  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(rewind.currentEntryId, "previous-entry");
});

test("T5 restores only the exact checkpointed user target, never an ancestor", () => {
  const exact = { entryId: "user" };
  const rewind = { checkpoints: new Map([["user", exact]]) };
  const entries = new Map([
    ["tool", { id: "tool", type: "message", parentId: "assistant", message: { role: "toolResult" } }],
    ["assistant", { id: "assistant", type: "message", parentId: "user", message: { role: "assistant" } }],
    ["user", { id: "user", type: "message", message: { role: "user" } }],
  ]);
  assert.equal(pickCheckpointForEntry(rewind, "user", id => entries.get(id)), exact);
  for (const id of ["tool", "assistant", "missing"]) {
    assert.equal(pickCheckpointForEntry(rewind, id, id => entries.get(id)), undefined);
  }
});

// 0.4.0 captures modes inside the checkpoint/first-touch path itself, covered end
// to end by the package's own spike/preimage-test.mts. What stays testable through
// the public API here is the half that actually writes to disk.
test("T10 detects and restores non-Git project permission bits", () => {
  const root = mkdtempSync(join(tmpdir(), "rewind-project-mode-"));
  try {
    const file = join(root, "private.txt");
    writeFileSync(file, "private");
    chmodSync(file, 0o600);
    const checkpoint = { entryId: "user-1", projectModes: { "private.txt": 0o600 } };
    const rewind = {
      cwd: root,
      checkpoints: new Map([[checkpoint.entryId, checkpoint]]),
      dirty: false,
    };

    chmodSync(file, 0o644);
    assert.equal(projectModeChangeCount(rewind, checkpoint), 1);
    const result = { restored: 0, deleted: 0, skipped: [], errors: [] };
    restoreProjectModes(rewind, checkpoint, result);

    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 canonical force-track paths never pass through a symlink pathspec", () => {
  const root = mkdtempSync(join(tmpdir(), "rewind-force-track-"));
  try {
    const project = join(root, "project");
    const inside = join(project, "real");
    const outside = join(root, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(inside, "a.txt"), "inside");
    writeFileSync(join(outside, "b.txt"), "outside");
    symlinkSync(inside, join(project, "inside-link"));
    symlinkSync(outside, join(project, "outside-link"));

    assert.equal(toRelPath(project, "inside-link/a.txt"), "real/a.txt");
    assert.equal(toRelPath(project, "outside-link/b.txt"), join(realpathSync(outside), "b.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
