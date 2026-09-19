import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickCheckpointForEntry } from "../extensions/tree-rewind/src/checkpoints.ts";
import { reportApply } from "../extensions/tree-rewind/src/commands.ts";
import { readRegular } from "../extensions/tree-rewind/src/line-stats.ts";
import { reapStores } from "../extensions/tree-rewind/src/reaper.ts";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-rewind-safety-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function write(path, value = "fixture\n") {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, value);
}

test("tree targets never substitute an ancestor's before-state", () => {
  const user = { id: "u", type: "message", message: { role: "user" } };
  const nodes = new Map([
    ["u", user],
    ["a", { id: "a", type: "message", parentId: "u", message: { role: "assistant" } }],
    ["t", { id: "t", type: "message", parentId: "a", message: { role: "toolResult" } }],
    ["unprotected", { id: "unprotected", type: "message", parentId: "a", message: { role: "user" } }],
  ]);
  const cp = { entryId: "u" };
  const state = { checkpoints: new Map([["u", cp]]) };
  assert.equal(pickCheckpointForEntry(state, "u", id => nodes.get(id)), cp);
  for (const id of ["a", "t", "unprotected", "missing"]) {
    assert.equal(pickCheckpointForEntry(state, id, id => nodes.get(id)), undefined, id);
  }
  state.checkpoints.set("a", { entryId: "a" });
  assert.equal(pickCheckpointForEntry(state, "a", id => nodes.get(id)), undefined, "a malformed non-user checkpoint is not a target");
});

test("referenced stores survive a project disappearing and returning", () => {
  const f = fixture();
  try {
    const origin = join(f.root, "project");
    fs.mkdirSync(origin);
    const root = join(f.root, "rewind");
    const store = join(root, "a".repeat(16));
    write(join(store, "origin"), origin);
    write(join(store, "root.git/refs/pi/session/entry"), "a".repeat(40));
    fs.renameSync(origin, origin + "-unmounted");
    assert.deepEqual(reapStores({ root, graceMs: 0 }), []);
    fs.renameSync(origin + "-unmounted", origin);
    assert.equal(fs.readFileSync(join(store, "root.git/refs/pi/session/entry"), "utf8"), "a".repeat(40));
  } finally { f.cleanup(); }
});

test("whole-store reaping retains locks, private metadata, leases and uncertain paths", () => {
  const f = fixture();
  try {
    const root = join(f.root, "rewind");
    let i = 0;
    for (const path of ["snapshot.lock", "checkpoints/checkpoint.json", "recovery/record.json", "sessions/lease.json"]) {
      const store = join(root, (++i).toString(16).padStart(16, "0"));
      write(join(store, path));
      fs.utimesSync(join(store, path), new Date(0), new Date(0));
    }
    const store = join(root, (++i).toString(16).padStart(16, "0"));
    fs.mkdirSync(join(store, "root.git"), { recursive: true });
    fs.symlinkSync(join(f.root, "missing"), join(store, "root.git/refs"));
    const foreign = join(f.root, "foreign");
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, join(root, (++i).toString(16).padStart(16, "0")));
    assert.deepEqual(reapStores({ root, graceMs: 0 }), []);
    assert.equal(fs.readdirSync(root).length, i);
  } finally { f.cleanup(); }
});

test("reaping retires a ref-less store while holding its lock before removing it", () => {
  const f = fixture();
  const originalRename = fs.renameSync;
  let observed = false;
  try {
    const root = join(f.root, "rewind");
    const store = join(root, "a".repeat(16));
    write(join(store, "origin"), join(f.root, "missing-project"));
    fs.renameSync = (from, to) => {
      if (from === store) {
        observed = true;
        assert.throws(() => fs.openSync(join(store, "snapshot.lock"), "wx"), { code: "EEXIST" });
        assert.equal(JSON.parse(fs.readFileSync(join(store, "snapshot.lock"), "utf8")).pid, process.pid);
      }
      const result = originalRename(from, to);
      if (from === store) write(join(store, "new-writer"), "new store survives\n");
      return result;
    };
    syncBuiltinESMExports();
    assert.equal(reapStores({ root, graceMs: 0 }).length, 1);
    assert.equal(observed, true, "a recursive remove must not expose its lock at the original path");
    assert.equal(fs.readFileSync(join(store, "new-writer"), "utf8"), "new store survives\n");
    assert.deepEqual(fs.readdirSync(root), ["a".repeat(16)]);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); f.cleanup(); }
});

// Simulate a concurrent writer precisely after metadata was sampled. Updating
// Node's named exports exercises both the former lstat path and the fd reader.
function raceAfterStat(file, mutate, run) {
  const lstat = fs.lstatSync, fstat = fs.fstatSync;
  const original = fs.statSync(file);
  let done = false;
  const after = st => {
    if (!done && st.ino === original.ino && st.dev === original.dev) { done = true; mutate(); }
    return st;
  };
  fs.lstatSync = (...args) => after(lstat(...args));
  fs.fstatSync = (...args) => after(fstat(...args));
  syncBuiltinESMExports();
  try { return run(); }
  finally { fs.lstatSync = lstat; fs.fstatSync = fstat; syncBuiltinESMExports(); }
}

test("preview reads stop at the byte budget even if a file grows after stat", () => {
  const f = fixture();
  try {
    const file = join(f.root, "file");
    write(file, "x");
    raceAfterStat(file, () => fs.writeFileSync(file, Buffer.alloc(4096, "x")), () => {
      assert.equal(readRegular(file, 32), "large");
    });
  } finally { f.cleanup(); }
});

test("preview reads keep the opened inode when the path is swapped for a symlink", () => {
  const f = fixture();
  try {
    const file = join(f.root, "file"), target = join(f.root, "unrelated");
    write(file, "original"); write(target, "must not be read");
    raceAfterStat(file, () => { fs.unlinkSync(file); fs.symlinkSync(target, file); }, () => {
      assert.equal(readRegular(file, 32)?.toString(), "original");
    });
    assert.equal(readRegular(file, 32), null, "an already-present symlink is not followed either");
  } finally { f.cleanup(); }
});

test("matching file counts do not turn preview line totals into measured apply totals", () => {
  const messages = [];
  const plan = { items: [{ repo: "", path: "file", display: "file", action: "restore" }] };
  const stats = new Map([["\0file", { kind: "lines", added: 1, removed: 2 }]]);
  reportApply({ ui: { notify: text => messages.push(text) } }, { restored: 1, deleted: 0, skipped: [], errors: [] }, plan, stats);
  assert.match(messages[0], /preview estimate: \+1 −2/);
});
