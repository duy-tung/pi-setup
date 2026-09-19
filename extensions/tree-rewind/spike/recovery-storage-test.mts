import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../src/storage.js";
import {
  readRecovery, recoveryPath, recoveryProtection, removeCompletedRecovery, writeRecovery,
  type RecoveryJournal, type RecoveryRecord, type StoredUndoPoint,
} from "../src/recovery.js";

// All reads and writes are confined to this fixture; no HOME/config discovery.
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-recovery-storage-")));
const cwd = join(root, "project");
const store = join(root, "store");
const session = "fixture-session/with-untrusted-name";
const uuid = randomUUID();
const blob = (digit: string): string => digit.repeat(64);
const before: StoredUndoPoint = {
  snapshot: { "": "a".repeat(40), "nested/repo": "b".repeat(64) },
  outside: { [join(root, "outside-before")]: { sha: blob("1"), mode: 0o640 }, [join(root, "missing")]: { absent: true } },
  projectModes: { "src/main.ts": 0o755 },
  projectUnknown: ["", "vendor/", "nested/file"],
  projectAbsent: ["created/file"],
  timestamp: 1234,
  label: "Before fixture rewind",
  refId: `tx-${uuid}-before`,
};
const target: StoredUndoPoint = { ...before, refId: `tx-${uuid}-target`, outside: { [join(root, "outside-target")]: { sha: blob("2"), mode: 0o600 } } };
const previous: StoredUndoPoint = { ...before, outside: { [join(root, "outside-previous")]: { sha: blob("3"), mode: 0o600 } } };
const undo: StoredUndoPoint = { ...before, outside: { [join(root, "outside-undo")]: { sha: blob("4"), mode: 0o600 } } };
const journal: RecoveryJournal = {
  id: uuid, kind: "rewind", phase: "pending", startedAt: 1235,
  before, target, previousUndo: previous,
  options: { includeOutside: false, includeTypeChanges: false },
};
let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}
function fixture(name: string): string {
  const path = join(root, name);
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function fixtureRecord(sessionId = "corrupt-session"): RecoveryRecord {
  return { version: 1, cwd, sessionId, revision: 1, undo: structuredClone(before), journal: structuredClone(journal) };
}
function injectFsFailure(name: "fsyncSync" | "renameSync" | "writeFileSync" | "openSync", fn: () => void): void {
  const original = fs[name];
  // Sync named imports so this fault reaches the production module's fs calls.
  (fs as any)[name] = () => { throw Object.assign(new Error("fixture failure"), { code: "EIO" }); };
  syncBuiltinESMExports();
  try { fn(); } finally { (fs as any)[name] = original; syncBuiltinESMExports(); }
}

try {
  check("private JSON missing, roundtrip, exact limit and permissions", () => {
    const path = join(root, "private", "state.json");
    assert.equal(readPrivateJson(path), null);
    const value = { nested: [1, true, null, "fixture"] };
    writePrivateJson(path, value);
    assert.deepEqual(readPrivateJson(path), value);
    assert.deepEqual(readPrivateJson(path, fs.statSync(path).size), value);
    assert.throws(() => readPrivateJson(path, fs.statSync(path).size - 1));
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(join(root, "private")).mode & 0o777, 0o700);
    fs.chmodSync(path, 0o644);
    writePrivateJson(path, { replacement: true });
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(join(root, "private")), ["state.json"]);
    for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => readPrivateJson(path, limit));
  });

  check("reject malformed, nonregular, symlink, invalid UTF-8 and oversized input", () => {
    const dir = fixture("invalid-storage");
    const malformed = join(dir, "malformed.json");
    const privateMarker = "fixture-only-sensitive-marker";
    fs.writeFileSync(malformed, `{${privateMarker}`);
    assert.throws(() => readPrivateJson(malformed), (error: Error) => !error.message.includes(privateMarker));
    const invalidUtf8 = join(dir, "utf8.json");
    fs.writeFileSync(invalidUtf8, Buffer.from([0x22, 0xff, 0x22]));
    assert.throws(() => readPrivateJson(invalidUtf8));
    const large = join(dir, "large.json");
    fs.writeFileSync(large, " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => readPrivateJson(large));
    assert.throws(() => readPrivateJson(dir));
    assert.throws(() => writePrivateJson(dir, {}));
    const target = join(dir, "target.json");
    writePrivateJson(target, { unchanged: true });
    const link = join(dir, "link.json");
    fs.symlinkSync(target, link);
    assert.throws(() => readPrivateJson(link));
    assert.throws(() => writePrivateJson(link, {}));
    assert.deepEqual(readPrivateJson(target), { unchanged: true });
    const dangling = join(dir, "dangling.json");
    fs.symlinkSync(join(dir, "absent"), dangling);
    assert.throws(() => readPrivateJson(dangling));
    assert.throws(() => writePrivateJson(dangling, {}));
    const parentLink = join(root, "linked-parent");
    fs.symlinkSync(dir, parentLink);
    assert.throws(() => readPrivateJson(join(parentLink, "target.json")));
    assert.throws(() => writePrivateJson(join(parentLink, "new.json"), {}));
    injectFsFailure("openSync", () => assert.throws(() => readPrivateJson(target)));
  });

  check("pre-publication write failures preserve original and clean temporary files", () => {
    const dir = fixture("atomic-failures");
    const path = join(dir, "state.json");
    writePrivateJson(path, { original: true });
    const original = fs.readFileSync(path);
    for (const operation of ["writeFileSync", "fsyncSync", "renameSync"] as const) {
      injectFsFailure(operation, () => assert.throws(() => writePrivateJson(path, { replacement: true })));
      assert.deepEqual(fs.readFileSync(path), original);
      assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
    }
    const cyclic: any = {}; cyclic.self = cyclic;
    for (const value of [cyclic, 1n, undefined, "x".repeat(4 * 1024 * 1024)]) {
      assert.throws(() => writePrivateJson(path, value));
      assert.deepEqual(fs.readFileSync(path), original);
    }
  });

  check("same-directory exclusive temporary file and file/directory fsync", () => {
    const dir = fixture("publication-order");
    const path = join(dir, "state.json");
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    const events: string[] = [];
    (fs as any).openSync = (name: string, flags: number, mode?: number) => {
      if (name.endsWith(".tmp")) {
        assert.equal(join(dir, basename(name)), name);
        assert.ok(flags & fs.constants.O_EXCL);
        assert.ok(flags & fs.constants.O_CREAT);
        assert.equal(mode, 0o600);
        events.push("temp");
      }
      return originalOpen(name, flags, mode);
    };
    fs.fsyncSync = (fd: number) => {
      const directory = fs.fstatSync(fd).isDirectory();
      events.push(directory ? "directory-sync" : "file-sync");
      originalFsync(fd);
    };
    fs.renameSync = (from, to) => { events.push("rename"); originalRename(from, to); };
    syncBuiltinESMExports();
    try { writePrivateJson(path, {}); } finally {
      fs.openSync = originalOpen; fs.fsyncSync = originalFsync; fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.deepEqual(events, ["temp", "file-sync", "rename", "directory-sync"]);
  });

  check("recovery atomic roundtrip, identity, hashed path and revision conflict", () => {
    assert.equal(readRecovery(store, cwd, session), null);
    assert.equal(basename(recoveryPath(store, session)), `${createHash("sha256").update(session).digest("hex")}.json`);
    const first = writeRecovery(store, cwd, session, 0, { undo, journal });
    assert.equal(first.revision, 1);
    assert.deepEqual(readRecovery(store, cwd, session), first);
    assert.throws(() => writeRecovery(store, cwd, session, 0, { undo: null, journal: null }), /revision conflict/);
    assert.deepEqual(readRecovery(store, cwd, session), first);
    assert.throws(() => readRecovery(store, join(root, "different-project"), session));
    for (const revision of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => writeRecovery(store, cwd, session, revision, { undo, journal }));
    }
    assert.throws(() => writeRecovery(store, "relative", session, 1, { undo, journal }));
    for (const id of ["", "x".repeat(1025), "nul\0id"]) assert.throws(() => recoveryPath(store, id));
  });

  check("pending and failed journals pin sessions and all referenced outside blobs", () => {
    let protection = recoveryProtection(store);
    assert.equal(protection.unsafe, false);
    assert.deepEqual(protection.pendingSessions, new Set([session]));
    assert.deepEqual(protection.outsideBlobs, new Set([blob("1"), blob("2"), blob("3"), blob("4")]));
    assert.throws(() => removeCompletedRecovery(store, cwd, session), /unfinished/);
    const failed = { ...journal, kind: "undo" as const, phase: "failed" as const, error: "fixture interruption" };
    const next = writeRecovery(store, cwd, session, 1, { undo, journal: failed });
    assert.equal(next.revision, 2);
    protection = recoveryProtection(store);
    assert.deepEqual(protection.pendingSessions, new Set([session]));
    assert.equal(protection.unsafe, false);
    assert.throws(() => removeCompletedRecovery(store, cwd, session), /unfinished/);
  });

  check("strict schema and safe paths reject bad records without pruning them", () => {
    const dir = fixture("schema");
    const id = "corrupt-session";
    const path = recoveryPath(dir, id);
    const mutations: Array<(r: any) => void> = [
      (r) => { r.version = 2; }, (r) => { delete r.undo; }, (r) => { r.extra = true; },
      (r) => { r.cwd = "relative"; },
      (r) => { r.sessionId = "wrong-session"; }, (r) => { r.revision = 0; },
      (r) => { r.revision = Number.MAX_SAFE_INTEGER + 1; }, (r) => { r.undo.timestamp = -1; },
      (r) => { r.undo.timestamp = 1.5; }, (r) => { r.undo.label = "x".repeat(4097); },
      (r) => { r.undo.refId = "ordinary-session-ref"; }, (r) => { r.undo.refId = `tx-${uuid}-after`; },
      (r) => { r.undo.snapshot = { "../escape": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "/absolute": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "nested/.git/objects": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "nested/.GIT": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "nested//repo": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "nul\0repo": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "dir\\..\\escape": "a".repeat(40) }; },
      (r) => { r.undo.snapshot = { "": "g".repeat(40) }; },
      (r) => { r.undo.snapshot = { "": "a".repeat(41) }; },
      (r) => { r.undo.snapshot = []; },
      (r) => { r.undo.projectModes = { "": 0o600 }; },
      (r) => { r.undo.projectModes = { "file": 0o1000 }; },
      (r) => { r.undo.projectModes = { "file": 1.5 }; },
      (r) => { r.undo.projectModes = { "file/": 0o600 }; },
      (r) => { r.undo.projectUnknown = ["../"]; },
      (r) => { r.undo.projectUnknown = ["dir//"]; },
      (r) => { r.undo.projectUnknown = [".git/"]; },
      (r) => { r.undo.projectAbsent = [""]; }, (r) => { r.undo.projectAbsent = ["dir/"]; },
      (r) => { r.undo.projectAbsent = ["./file"]; },
      (r) => { r.undo.projectAbsent = Array(16385).fill("file"); },
      (r) => { r.undo.projectModes = Object.fromEntries(Array.from({ length: 16385 }, (_, i) => [`f${i}`, 0o600])); },
      (r) => { r.undo.outside = { relative: { absent: true } }; },
      (r) => { r.undo.outside = { "/outside/../escape": { absent: true } }; },
      (r) => { r.undo.outside = { "/outside/.git/config": { absent: true } }; },
      (r) => { r.undo.outside = { "/outside/file": { absent: false } }; },
      (r) => { r.undo.outside = { "/outside/file": { absent: true, sha: blob("a") } }; },
      (r) => { r.undo.outside = { "/outside/file": { sha: "a".repeat(40), mode: 0o600 } }; },
      (r) => { r.undo.outside = { "/outside/file": { sha: blob("a"), mode: 0o1000 } }; },
      (r) => { r.undo.outside = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`/outside/f${i}`, { absent: true }])); },
      (r) => { r.journal.id = "not-a-uuid"; }, (r) => { r.journal.kind = "replay"; },
      (r) => { r.journal.phase = "completed"; }, (r) => { r.journal.startedAt = -1; },
      (r) => { r.journal.options.includeOutside = 1; }, (r) => { r.journal.options.extra = false; },
      (r) => { r.journal.error = "x".repeat(8193); },
      (r) => { delete r.journal.previousUndo; }, (r) => { r.journal.target.refId = "bad"; },
      (r) => { r.journal.previousUndo.snapshot = { "..": "a".repeat(40) }; },
    ];
    for (const mutate of mutations) {
      const value = fixtureRecord(id);
      mutate(value);
      writePrivateJson(path, value);
      assert.throws(() => readRecovery(dir, cwd, id));
      assert.equal(recoveryProtection(dir).unsafe, true);
      assert.throws(() => removeCompletedRecovery(dir, cwd, id));
      assert.ok(fs.existsSync(path));
    }
    for (const value of [null, [], {}, "not a record"]) {
      writePrivateJson(path, value);
      assert.throws(() => readRecovery(dir, cwd, id));
      assert.equal(recoveryProtection(dir).unsafe, true);
      assert.throws(() => removeCompletedRecovery(dir, cwd, id));
    }
  });

  check("caller-supplied prototypes, accessors and non-JSON properties are refused", () => {
    const dir = fixture("prototype-validation");
    const attempt = (value: any) => assert.throws(() => writeRecovery(dir, cwd, "session", 0, value));
    attempt(Object.create({ undo: before, journal: null }));
    attempt({ undo: Object.assign(Object.create({ injected: true }), before), journal: null });
    const getter = structuredClone(before);
    Object.defineProperty(getter, "label", { enumerable: true, get() { throw new Error("must not invoke getter"); } });
    assert.throws(() => writeRecovery(dir, cwd, "session", 0, { undo: getter, journal: null }), /Invalid recovery metadata/);
    attempt({ undo: { ...before, [Symbol("hidden")]: true }, journal: null });
    attempt({ undo: { ...before, projectAbsent: [ , "file"] }, journal: null });
    attempt({ undo: { ...before, projectAbsent: Object.assign(["file"], { extra: true }) }, journal: null });
    attempt({ undo: { ...before, projectAbsent: undefined }, journal: null });
    const snapshot = JSON.parse('{"__proto__":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
    const safe = writeRecovery(dir, cwd, "session", 0, { undo: { ...before, snapshot }, journal: null });
    assert.equal(Object.hasOwn(safe.undo!.snapshot, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(safe.undo!.snapshot), Object.prototype);
    assert.deepEqual(readRecovery(dir, cwd, "session"), safe);
  });

  check("malformed, unreadable, symlink and mismatched filenames make protection unsafe", () => {
    const dir = fixture("unsafe-scan");
    assert.deepEqual(recoveryProtection(dir), { pendingSessions: new Set(), outsideBlobs: new Set(), unsafe: false });
    const path = recoveryPath(dir, "corrupt-session");
    writePrivateJson(path, fixtureRecord());
    fs.writeFileSync(join(dir, "recovery", "not-a-record.json"), "ignored malformed unrelated file");
    assert.equal(recoveryProtection(dir).unsafe, false);
    injectFsFailure("openSync", () => assert.equal(recoveryProtection(dir).unsafe, true));
    fs.writeFileSync(path, "{broken");
    assert.equal(recoveryProtection(dir).unsafe, true);
    fs.unlinkSync(path);
    const targetPath = join(root, "symlink-record.json");
    writePrivateJson(targetPath, fixtureRecord());
    fs.symlinkSync(targetPath, path);
    assert.equal(recoveryProtection(dir).unsafe, true);
    assert.throws(() => readRecovery(dir, cwd, "corrupt-session"));
    assert.throws(() => removeCompletedRecovery(dir, cwd, "corrupt-session"));
    fs.unlinkSync(path);
    writePrivateJson(join(dir, "recovery", `${blob("f")}.json`), fixtureRecord());
    assert.equal(recoveryProtection(dir).unsafe, true);
    const linked = fixture("linked-recovery");
    fs.symlinkSync(join(dir, "recovery"), join(linked, "recovery"));
    assert.equal(recoveryProtection(linked).unsafe, true);
    const nonregular = fixture("nonregular-recovery");
    fs.writeFileSync(join(nonregular, "recovery"), "not a directory");
    assert.equal(recoveryProtection(nonregular).unsafe, true);
  });

  check("protection count and byte budgets fail closed", () => {
    const countStore = fixture("count-budget");
    fs.mkdirSync(join(countStore, "recovery"));
    for (let i = 0; i < 1025; i++) {
      const id = `count-${i}`;
      fs.writeFileSync(recoveryPath(countStore, id), JSON.stringify({ ...fixtureRecord(id), undo: null, journal: null }));
    }
    assert.equal(recoveryProtection(countStore).unsafe, true);
    const entryStore = fixture("entry-budget");
    fs.mkdirSync(join(entryStore, "recovery"));
    for (let i = 0; i < 4097; i++) fs.writeFileSync(join(entryStore, "recovery", `ignored-${i}`), "");
    assert.equal(recoveryProtection(entryStore).unsafe, true);
    const byteStore = fixture("byte-budget");
    fs.mkdirSync(join(byteStore, "recovery"));
    for (let i = 0; i < 17; i++) {
      const id = `bytes-${i}`;
      const text = JSON.stringify({ ...fixtureRecord(id), undo: null, journal: null });
      fs.writeFileSync(recoveryPath(byteStore, id), text.padEnd(4 * 1024 * 1024, " "));
    }
    assert.equal(recoveryProtection(byteStore).unsafe, true);
  });

  check("completed retention is external and only verified completed records can be removed", () => {
    const completed = writeRecovery(store, cwd, session, 2, { undo, journal: null });
    assert.equal(completed.revision, 3);
    const protection = recoveryProtection(store);
    assert.equal(protection.unsafe, false);
    assert.deepEqual(protection.pendingSessions, new Set());
    assert.deepEqual(protection.outsideBlobs, new Set([blob("4")]));
    assert.deepEqual(readRecovery(store, cwd, session), completed);
    assert.throws(() => removeCompletedRecovery(store, join(root, "wrong"), session));
    removeCompletedRecovery(store, cwd, session);
    assert.equal(readRecovery(store, cwd, session), null);
    removeCompletedRecovery(store, cwd, session);
    assert.deepEqual(recoveryProtection(store).outsideBlobs, new Set());
    const empty = writeRecovery(store, cwd, session, 0, { undo: null, journal: null });
    assert.equal(empty.revision, 1);
    removeCompletedRecovery(store, cwd, session);
  });
  console.log(`PASS: ${checks} recovery/storage fixture groups`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
