import test from "node:test";
import assert from "node:assert/strict";
import { loadIndex, persistIndex } from "../extensions/tree-rewind/src/checkpoints.ts";
import { createInitialState } from "../extensions/tree-rewind/src/state.ts";
import { CUSTOM_TYPE } from "../extensions/tree-rewind/src/types.ts";

const sha = "a".repeat(40);
const cp = (entryId, extra = {}) => ({ entryId, parentEntryId: null, prompt: entryId, timestamp: 1, snapshot: { "": sha }, outside: {}, ...extra });
function session(sessionId = "s1") {
  const state = createInitialState();
  state.sessionId = sessionId;
  const entries = [];
  const pi = { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }) };
  const add = (id, extra) => { state.checkpoints.set(id, cp(id, extra)); state.dirty = true; };
  const publish = (branch = entries) => persistIndex(pi, state, branch);
  const loaded = (list = entries, sessionId = state.sessionId) => { const s = createInitialState(); s.sessionId = sessionId; loadIndex(s, list); return s; };
  return { state, entries, pi, add, publish, loaded };
}
const ids = state => [...state.checkpoints.keys()].sort();

test("legacy v3/v4 full arrays still load and seed the published signature set", () => {
  const list = [
    { type: "custom", customType: CUSTOM_TYPE, data: { version: 3, sessionId: "s1", checkpoints: [cp("u1")] } },
    { type: "custom", customType: CUSTOM_TYPE, data: { version: 4, localRevision: 7, sessionId: "s1", checkpoints: [cp("u1"), cp("u2", { after: { refId: "op-12345678-1234-4123-8123-123456789abc", timestamp: 2, snapshot: {}, outside: {} } })] } },
  ];
  const s = session();
  loadIndex(s.state, list);
  assert.deepEqual(ids(s.state), ["u1", "u2"]);
  assert.equal(s.state.checkpoints.get("u2").after, undefined);
  assert.equal(s.state.indexRevision, 7);
  assert.equal(s.state.publishedBatch, null, "legacy batches carry no token, so the next publication is a base");
  s.state.dirty = true;
  persistIndex(s.pi, s.state, list);
  assert.equal(s.entries.at(-1).data.kind, "base");
});

test("successive checkpoints append one complete object each instead of the whole array", () => {
  const s = session();
  for (let i = 0; i < 40; i++) { s.add(`u${i}`); s.publish(); }
  assert.equal(s.entries.length, 40);
  assert.equal(s.entries[0].data.kind, "base");
  assert.ok(s.entries.slice(1).every(entry => entry.data.kind === "delta" && entry.data.checkpoints.length === 1));
  const bytes = s.entries.map(entry => JSON.stringify(entry.data).length);
  assert.ok(Math.max(...bytes.slice(1)) < bytes[0] * 2, "delta size does not grow with the index");
  assert.deepEqual(ids(s.loaded()), ids(s.state));
});

test("after-only and no-op dirty flags never append; a changed before object republishes it completely", () => {
  const s = session();
  s.add("u1"); s.publish();
  s.state.checkpoints.get("u1").after = { refId: "op-1", timestamp: 2, snapshot: {}, outside: {} };
  s.state.dirty = true; s.publish();
  assert.equal(s.entries.length, 1);
  s.state.checkpoints.get("u1").outside = { "/tmp/x": { sha, mode: 0o600 } };
  s.state.dirty = true; s.publish();
  assert.equal(s.entries.length, 2);
  assert.deepEqual(s.entries[1].data.checkpoints.map(c => c.entryId), ["u1"]);
  assert.equal(s.entries[1].data.checkpoints[0].after, undefined);
  assert.deepEqual(s.loaded().checkpoints.get("u1").outside, { "/tmp/x": { sha, mode: 0o600 } });
});

test("published objects are detached from later in-memory mutation", () => {
  const s = session();
  s.add("u1"); s.publish();
  const appended = s.pi.appendEntry;
  const raw = [];
  s.pi.appendEntry = (type, data) => raw.push(data);
  s.add("u2"); s.publish();
  s.state.checkpoints.get("u2").outside["/tmp/late"] = { absent: true };
  assert.deepEqual(raw[0].checkpoints[0].outside, {});
  s.pi.appendEntry = appended;
  const s2 = s.loaded();
  s2.checkpoints.get("u1").outside["/tmp/alias"] = { absent: true };
  assert.deepEqual(s.loaded().checkpoints.get("u1").outside, {});
});

test("tree navigation off the last batch republishes a base so a fork keeps every checkpoint", () => {
  const s = session();
  s.add("u1"); s.publish();
  const [i1] = s.entries;
  // Navigate back before I1: the active branch no longer contains it.
  const branch = [{ type: "message", id: "a1" }];
  s.add("u2"); s.publish(branch);
  const i2 = s.entries[1];
  assert.equal(i2.data.kind, "base");
  assert.deepEqual(i2.data.checkpoints.map(c => c.entryId).sort(), ["u1", "u2"]);
  const child = s.loaded([...branch, i2], "child");
  assert.deepEqual(ids(child), ["u1", "u2"]);
  assert.ok(i1);
  // Staying on the branch that includes I2 keeps publishing deltas.
  s.add("u3"); s.publish([...branch, i2]);
  assert.equal(s.entries[2].data.kind, "delta");
  assert.equal(s.entries[2].data.parent, i2.data.token);
});

test("a fork child publishes a base under its own session before chaining", () => {
  const s = session();
  s.add("u1"); s.publish();
  const child = s.loaded(s.entries, "child");
  assert.equal(child.publishedBatch.sessionId, "s1");
  const childEntries = [...s.entries];
  child.checkpoints.set("u2", cp("u2")); child.dirty = true;
  persistIndex({ appendEntry: (customType, data) => childEntries.push({ type: "custom", customType, data }) }, child, childEntries);
  assert.equal(childEntries.at(-1).data.kind, "base");
  assert.equal(childEntries.at(-1).data.sessionId, "child");
});

test("a missing branch or an unknown previous batch falls back to a complete base", () => {
  const s = session();
  s.add("u1"); s.publish();
  s.add("u2"); persistIndex(s.pi, s.state);
  assert.equal(s.entries[1].data.kind, "base");
  s.add("u3"); s.publish([]);
  assert.equal(s.entries[2].data.kind, "base");
});

test("removed checkpoints are replayed only through an intact chain", () => {
  const s = session();
  s.add("u1"); s.add("u2"); s.publish();
  s.state.checkpoints.delete("u2"); s.state.dirty = true; s.publish();
  assert.deepEqual(s.entries[1].data.removed, ["u2"]);
  assert.deepEqual(ids(s.loaded()), ["u1"]);
  const broken = s.loaded([s.entries[0], { ...s.entries[1], data: { ...s.entries[1].data, parent: "unknown" } }]);
  assert.deepEqual(ids(broken), ["u1", "u2"], "an unverifiable removal is not applied");
  assert.match(broken.lastGap, /chain incomplete/);
});

test("malformed, truncated and unknown-parent deltas fail closed without losing complete objects", () => {
  const s = session();
  s.add("u1"); s.publish(); s.add("u2"); s.publish(); s.add("u3"); s.publish();
  const [base, d2, d3] = s.entries;
  const skipped = s.loaded([base, d3]);
  assert.deepEqual(ids(skipped), ["u1", "u3"]);
  assert.match(skipped.lastGap, /chain incomplete/);
  assert.deepEqual(ids(s.loaded([base, d2, d3])), ["u1", "u2", "u3"]);
  const junk = s.loaded([base, { type: "custom", customType: CUSTOM_TYPE, data: { version: 5, kind: "delta", checkpoints: "nope" } },
    { type: "custom", customType: CUSTOM_TYPE, data: { version: 5, kind: "delta", token: 1, parent: base.data.token, checkpoints: [cp("bad", { snapshot: { "../x": sha } })] } }, d2]);
  assert.deepEqual(ids(junk), ["u1", "u2"]);
  assert.equal(junk.lastGap, null, "ignored frames do not break a chain that still links");
  assert.deepEqual(ids(s.loaded([base, d2, { ...d3, data: { ...d3.data, checkpoints: [{ entryId: "x" }] } }])), ["u1", "u2"]);
});

test("a complete base after a gap clears the incomplete-chain report", () => {
  const s = session();
  s.add("u1"); s.publish(); s.add("u2"); s.publish();
  const [base, d2] = s.entries;
  const gapped = s.loaded([base, { ...d2, data: { ...d2.data, parent: "unknown" } }]);
  assert.match(gapped.lastGap, /chain incomplete/);
  s.add("u3"); s.publish([]);
  const healed = s.loaded([base, { ...d2, data: { ...d2.data, parent: "unknown" } }, s.entries[2]]);
  assert.equal(healed.lastGap, null);
  assert.deepEqual(ids(healed), ["u1", "u2", "u3"]);
  assert.equal(healed.indexObjectRevision.get("u1"), s.entries[2].data.localRevision);
});
