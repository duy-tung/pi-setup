import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OutsideStore } from "../src/outside.js";
import { markOrigin, reapStores } from "../src/reaper.js";
import { recoveryPath, recoveryProtection, writeRecovery, type RecoveryJournal, type StoredUndoPoint } from "../src/recovery.js";
import type { OutsideSnapshot } from "../src/types.js";
import { saveCheckpointState } from "../src/checkpoint-store.js";

// Set HOME before constructing any store or invoking eligibility/reaper code.
// All targets, registries, recovery sidecars and stores are disposable fixtures.
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-retention-")));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
fs.mkdirSync(process.env.HOME, { mode: 0o700 });
const home = process.env.HOME;
const old = new Date(Date.now() - 60 * 86400_000);
let checks = 0;
let storeId = 0;
function check(name: string, fn: () => void): void {
  fn();
  console.log(`ok ${++checks} - ${name}`);
}
function directory(path: string): string {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function blob(store: string, content: string, aged = true): { sha: string; path: string } {
  const sha = createHash("sha256").update(content).digest("hex");
  const path = join(store, "outside", sha.slice(0, 2), sha);
  directory(dirname(path));
  fs.writeFileSync(path, content, { mode: 0o600 });
  if (aged) fs.utimesSync(path, old, old);
  return { sha, path };
}
function point(outside: OutsideSnapshot = {}, suffix: "before" | "target" = "before", id = randomUUID()): StoredUndoPoint {
  return { snapshot: {}, outside, timestamp: 1, label: "Fixture recovery point", refId: `tx-${id}-${suffix}` };
}
function journal(before: StoredUndoPoint, target = before, previousUndo: StoredUndoPoint | null = null): RecoveryJournal {
  return {
    id: randomUUID(), kind: "rewind", phase: "pending", startedAt: 2,
    before, target, previousUndo, options: { includeOutside: true, includeTypeChanges: true },
  };
}
function unreadable(path: string, fn: () => void): void {
  const original = fs.openSync;
  fs.openSync = ((candidate: fs.PathLike, ...args: any[]) => {
    if (String(candidate) === path) throw Object.assign(new Error("fixture read failure"), { code: "EACCES" });
    return (original as any)(candidate, ...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { fn(); } finally { fs.openSync = original; syncBuiltinESMExports(); }
}

try {
  check("all sessions' Undo and journal points retain aged blobs; unreferenced age pruning continues", () => {
    const cwd = directory(join(root, "retention-project"));
    const storeDir = join(root, "retention-store");
    const store = new OutsideStore(cwd, storeDir);
    const retained = Array.from({ length: 5 }, (_, i) => blob(storeDir, `protected fixture ${i}`));
    const points = retained.map(({ sha }, i) => point({ [join(home, `retained-${i}.txt`)]: { sha, mode: 0o600 } }));
    writeRecovery(storeDir, cwd, "session-one", 0, {
      undo: points[0], journal: journal(points[1], points[2], points[3]),
    });
    writeRecovery(storeDir, cwd, "session-two", 0, { undo: points[4], journal: null });
    assert.equal(recoveryProtection(storeDir).unsafe, false);
    assert.equal(recoveryProtection(storeDir).outsideBlobs.size, 5);
    const unreferenced = blob(storeDir, "old unreferenced");
    const recent = blob(storeDir, "recent unreferenced", false);
    store.maintain();
    for (const entry of retained) assert.ok(fs.existsSync(entry.path));
    assert.equal(fs.existsSync(unreferenced.path), false);
    assert.ok(fs.existsSync(recent.path));
  });

  check("projectless completed Undo expires by age, but current, recent and unfinished sessions stay pinned", () => {
    const storeDir = join(root, "projectless-expiry-store");
    const store = new OutsideStore(home, storeDir, { projectless: true });
    const values = new Map<string, ReturnType<typeof blob>>();
    for (const id of ["expired", "current", "pending", "recent-checkpoint", "recent-record"]) {
      const entry = blob(storeDir, `projectless-${id}`); values.set(id, entry);
      const undo = point({ [join(home, `${id}.txt`)]: { sha: entry.sha, mode: 0o600 } });
      writeRecovery(storeDir, home, id, 0, { undo, journal: id === "pending" ? journal(undo) : null });
      if (id !== "recent-record") fs.utimesSync(recoveryPath(storeDir, id), old, old);
    }
    saveCheckpointState(storeDir, home, "recent-checkpoint", [], 0);
    store.maintain(30, "current");
    assert.equal(fs.existsSync(recoveryPath(storeDir, "expired")), false);
    assert.equal(fs.existsSync(values.get("expired")!.path), false);
    for (const id of ["current", "pending", "recent-checkpoint", "recent-record"]) {
      assert.ok(fs.existsSync(recoveryPath(storeDir, id)), id);
      assert.ok(fs.existsSync(values.get(id)!.path), id);
    }
  });

  check("no-sidecar stores preserve default and custom age pruning", () => {
    const storeDir = join(root, "legacy-store");
    const store = new OutsideStore(home, storeDir, { projectless: true });
    const aged = blob(storeDir, "legacy old");
    const recent = blob(storeDir, "legacy recent", false);
    store.maintain(90);
    assert.ok(fs.existsSync(aged.path));
    store.maintain();
    assert.equal(fs.existsSync(aged.path), false);
    assert.ok(fs.existsSync(recent.path));
  });

  check("unsafe and unreadable recovery skip all outside pruning", () => {
    const cwd = directory(join(root, "unsafe-project"));
    const storeDir = join(root, "unsafe-store");
    const store = new OutsideStore(cwd, storeDir);
    const aged = blob(storeDir, "unsafe unreferenced");
    writeRecovery(storeDir, cwd, "unsafe-session", 0, { undo: null, journal: null });
    const path = recoveryPath(storeDir, "unsafe-session");
    unreadable(path, () => {
      assert.equal(recoveryProtection(storeDir).unsafe, true);
      store.maintain();
      assert.ok(fs.existsSync(aged.path));
    });
    fs.writeFileSync(path, "{invalid fixture");
    store.maintain();
    assert.ok(fs.existsSync(aged.path));
  });

  check("hasSnapshot rejects shape/path/registry reductions and ignores own-entry insertion order", () => {
    const cwd = directory(join(root, "validation-project"));
    const storeDir = join(root, "validation-store");
    const store = new OutsideStore(cwd, storeDir);
    const target = join(home, "valid.txt");
    const absent = join(home, "absent.txt");
    fs.writeFileSync(target, "valid fixture content");
    assert.equal(store.touch(target, []), true);
    assert.equal(store.touch(absent, []), true);
    const snapshot = store.snapshotTracked();
    assert.equal(store.hasSnapshot(undefined), true);
    assert.equal(store.hasSnapshot({}), true);
    assert.equal(store.hasSnapshot(snapshot), true);
    const entry = snapshot[target];
    assert.ok("sha" in entry);
    assert.equal(store.hasSnapshot({ [absent]: { absent: true }, [target]: { mode: entry.mode, sha: entry.sha } }), true);
    assert.equal(store.hasSnapshot(Object.assign(Object.create(null), snapshot)), true);
    for (const invalid of [
      null, [], "invalid", { [target]: null }, { [target]: [] },
      { [target]: { ...entry, extra: true } }, { [target]: { sha: entry.sha, mode: "600" } },
      { [target]: { sha: entry.sha, mode: 0o1000 } }, { [target]: { sha: "bad", mode: 0o600 } },
      { [absent]: { absent: false } }, { [absent]: { absent: true, sha: entry.sha } },
      { relative: entry }, { [`${home}/./valid.txt`]: entry },
      { [join(home, "unregistered.txt")]: entry }, { [join(cwd, "inside.txt")]: entry },
      { [join(home, ".ssh", "config")]: entry }, { [join(home, ".env")]: entry },
      { ...snapshot, [Symbol("hidden")]: true },
    ]) assert.equal(store.hasSnapshot(invalid as any), false);
    const alias = join(home, "alias.txt");
    fs.symlinkSync(target, alias);
    assert.equal(store.hasSnapshot({ [alias]: entry }), false);
    // A fresh store cannot accept an entry dropped from the private registry.
    fs.writeFileSync(join(storeDir, "outside-paths.json"), JSON.stringify([absent]));
    assert.equal(new OutsideStore(cwd, storeDir).hasSnapshot(snapshot), false);
    // Even registered names must pass the current denylist and path gate.
    fs.writeFileSync(join(storeDir, "outside-paths.json"), JSON.stringify([target, join(home, ".ssh", "config")]));
    assert.equal(new OutsideStore(cwd, storeDir).hasSnapshot({ [join(home, ".ssh", "config")]: entry }), false);
  });

  check("corrupt and missing blobs refuse apply without touching file or directory targets", () => {
    const storeDir = join(root, "integrity-store");
    const store = new OutsideStore(home, storeDir, { projectless: true });
    const target = join(home, "integrity.txt");
    fs.writeFileSync(target, "original fixture");
    store.touch(target, []);
    const snapshot = store.snapshotTracked();
    const entry = snapshot[target];
    assert.ok("sha" in entry);
    const path = join(storeDir, "outside", entry.sha.slice(0, 2), entry.sha);
    assert.equal(store.hasSnapshot(snapshot), true);
    fs.writeFileSync(target, "current target survives");
    const plan = store.plan(snapshot);
    assert.equal(plan[0]?.action, "restore");
    const corruptMarker = "corrupt fixture contents must not appear in errors";
    fs.writeFileSync(path, corruptMarker);
    assert.equal(store.hasSnapshot(snapshot), false);
    const result = store.apply(plan);
    assert.equal(result.restored, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors.join(" ").includes(corruptMarker), false);
    assert.equal(fs.readFileSync(target, "utf8"), "current target survives");
    fs.unlinkSync(target);
    directory(target);
    const child = join(target, "child.txt");
    fs.writeFileSync(child, "directory survives");
    const replacement = store.plan(snapshot);
    assert.equal(replacement[0]?.action, "type-change");
    assert.equal(store.apply(replacement).errors.length, 1);
    assert.equal(fs.readFileSync(child, "utf8"), "directory survives");
    fs.unlinkSync(path);
    assert.equal(store.hasSnapshot(snapshot), false);
    assert.equal(store.apply(replacement).errors.length, 1);
    assert.equal(fs.readFileSync(child, "utf8"), "directory survives");
  });

  check("pending/failed absent-only recovery survives missing projects, absent origins and empty stores", () => {
    const reaperRoot = directory(join(root, "pending-reaper"));
    const existing = directory(join(root, "existing-origin"));
    const missing = join(root, "missing-origin");
    for (const origin of [missing, existing, null]) {
      for (const phase of ["pending", "failed"] as const) {
        const store = directory(join(reaperRoot, (++storeId).toString(16).padStart(16, "0")));
        if (origin) markOrigin(store, origin);
        const absent = point({ [join(home, "never-created.txt")]: { absent: true } });
        writeRecovery(store, origin ?? missing, "absent-session", 0, { undo: null, journal: { ...journal(absent), phase } });
        assert.equal(recoveryProtection(store).unsafe, false);
        assert.equal(recoveryProtection(store).outsideBlobs.size, 0);
      }
    }
    assert.deepEqual(reapStores({ root: reaperRoot, graceMs: 0 }), []);
    assert.equal(fs.readdirSync(reaperRoot).length, 6);
  });

  check("unsafe or unreadable recovery blocks missing-project reaping", () => {
    const reaperRoot = directory(join(root, "unsafe-reaper"));
    const missing = join(root, "missing-unsafe-origin");
    const stores = Array.from({ length: 4 }, () => directory(join(reaperRoot, (++storeId).toString(16).padStart(16, "0"))));
    for (const store of stores) markOrigin(store, missing);
    directory(join(stores[0], "recovery"));
    fs.writeFileSync(recoveryPath(stores[0], "broken"), "{invalid fixture");
    fs.writeFileSync(join(stores[1], "recovery"), "not a directory");
    fs.symlinkSync(join(stores[0], "recovery"), join(stores[2], "recovery"));
    writeRecovery(stores[3], missing, "unreadable", 0, { undo: null, journal: null });
    unreadable(recoveryPath(stores[3], "unreadable"), () => {
      assert.deepEqual(reapStores({ root: reaperRoot, graceMs: 0 }), []);
    });
    for (const store of stores) assert.ok(fs.existsSync(store));
  });

  check("whole-store reaping retains completed Undo and missing-origin refs", () => {
    const reaperRoot = directory(join(root, "legacy-reaper"));
    const existing = directory(join(root, "legacy-existing-origin"));
    const missing = join(root, "legacy-missing-origin");
    const make = (origin: string | null): string => {
      const store = directory(join(reaperRoot, (++storeId).toString(16).padStart(16, "0")));
      if (origin) markOrigin(store, origin);
      return store;
    };
    const completedMissing = make(missing);
    const content = blob(completedMissing, "completed content");
    writeRecovery(completedMissing, missing, "completed", 0, {
      undo: point({ [join(home, "completed.txt")]: { sha: content.sha, mode: 0o600 } }), journal: null,
    });
    const completedEmpty = make(existing);
    writeRecovery(completedEmpty, existing, "completed-empty", 0, { undo: point(), journal: null });
    const empty = make(existing);
    const missingWithRefs = make(missing);
    directory(join(missingWithRefs, "root.git", "refs", "pi"));
    fs.writeFileSync(join(missingWithRefs, "root.git", "refs", "pi", "fixture"), "a".repeat(40));
    const kept = make(existing);
    blob(kept, "legacy retained content");
    const completedKept = make(existing);
    const keptBlob = blob(completedKept, "completed live content");
    writeRecovery(completedKept, existing, "completed-live", 0, {
      undo: point({ [join(home, "completed-live.txt")]: { sha: keptBlob.sha, mode: 0o600 } }), journal: null,
    });
    const noOrigin = make(null);
    blob(noOrigin, "legacy no-origin content");
    const locked = make(missing);
    fs.writeFileSync(join(locked, "snapshot.lock"), "fixture");
    const explicitKeep = make(missing);
    const reaped = reapStores({ root: reaperRoot, graceMs: 0, keep: explicitKeep });
    assert.deepEqual(new Set(reaped.map((entry) => join(reaperRoot, entry.store))), new Set([empty]));
    for (const store of [completedMissing, completedEmpty, missingWithRefs, kept, completedKept, noOrigin, locked, explicitKeep]) assert.ok(fs.existsSync(store));
    const recent = make(missing);
    assert.deepEqual(reapStores({ root: reaperRoot }), []);
    assert.ok(fs.existsSync(recent));
  });
  console.log(`PASS: ${checks} retention/integrity fixture groups`);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
}
