import assert from "node:assert/strict";
import test from "node:test";
import { packageRestoreBlocker } from "../extensions/lib/package-activity.ts";

function bus({ active = false, jobs = [], reply = true } = {}) {
  const handlers = new Map();
  return {
    on(name, fn) {
      const set = handlers.get(name) ?? new Set();
      set.add(fn); handlers.set(name, set);
      return () => set.delete(fn);
    },
    emit(name, payload) {
      if (name === "pi-setup:subagents:activity" && active !== undefined) payload.reply({ active });
      if (name === "pi-background-tasks:request:v1" && reply) {
        assert.equal(payload.operation, "status", "restore integration must never control jobs");
        queueMicrotask(() => this.emit("pi-background-tasks:response:v1", {
          request_id: payload.request_id, ok: true, result: { tasks: jobs },
        }));
      }
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
    count: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

test("rewind permits settled packages and rejects queued agents or live shell jobs", async () => {
  assert.equal(await packageRestoreBlocker(bus()), null);
  assert.match(await packageRestoreBlocker(bus({ active: true })), /running\/queued/);
  assert.match(await packageRestoreBlocker(bus({ jobs: [{ status: "running" }] })), /Background jobs/);
  assert.equal(await packageRestoreBlocker(bus({ jobs: [{ status: "completed" }, { status: "failed" }] })), null);
});

test("missing package state refuses restore and query listeners are cleaned up", async () => {
  const missing = { emit() {}, on() { throw new Error("must not query jobs without agent status"); } };
  assert.match(await packageRestoreBlocker(missing), /unavailable/);
  const timeout = bus({ reply: false });
  assert.match(await packageRestoreBlocker(timeout, 10), /timed out/);
  assert.equal(timeout.count(), 0);
  const settled = bus();
  await packageRestoreBlocker(settled);
  assert.equal(settled.count(), 0);
});
