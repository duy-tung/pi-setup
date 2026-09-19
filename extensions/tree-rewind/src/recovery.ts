import { createHash } from "node:crypto";
import { lstatSync, opendirSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./storage.js";
import type { OutsideSnapshot, WorkspaceSnapshot } from "./types.js";

export interface StoredUndoPoint {
  snapshot: WorkspaceSnapshot;
  outside?: OutsideSnapshot;
  projectModes?: Record<string, number>;
  projectUnknown?: string[];
  projectAbsent?: string[];
  timestamp: number;
  label: string;
  refId: string;
}

export interface RecoveryJournal {
  id: string;
  kind: "rewind" | "undo";
  phase: "pending" | "failed";
  startedAt: number;
  before: StoredUndoPoint;
  target: StoredUndoPoint;
  previousUndo: StoredUndoPoint | null;
  options: { includeOutside: boolean; includeTypeChanges: boolean };
  error?: string;
}

export interface RecoveryRecord {
  version: 1;
  cwd: string;
  sessionId: string;
  revision: number;
  undo: StoredUndoPoint | null;
  journal: RecoveryJournal | null;
}

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 4096;
const MAX_SCAN_RECORDS = 1024;
const MAX_MAP_ENTRIES = 16384;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const REF_RE = new RegExp(`^tx-${UUID}-(before|target)$`);
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^[0-9a-f]{64}\.json$/;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid recovery metadata");
}

/** Also reject accessors/non-JSON properties on caller-supplied objects. */
function record(value: unknown): asserts value is Record<string, unknown> {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValid(prototype === Object.prototype || prototype === null);
  for (const key of Reflect.ownKeys(value)) {
    requireValid(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValid(descriptor.enumerable && own(descriptor, "value"));
  }
}

function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  record(value);
  requireValid(required.every((key) => own(value, key)));
  requireValid(Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
}

function text(value: unknown, max: number, nonempty = false): asserts value is string {
  requireValid(typeof value === "string" && value.length <= max && (!nonempty || value.length > 0) && !value.includes("\0"));
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  requireValid(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
}

function relativePath(value: unknown, root = false, trailingSlash = false): void {
  text(value, 4096);
  if (value === "") { requireValid(root); return; }
  requireValid(!isAbsolute(value) && !value.includes("\\"));
  const parts = (trailingSlash && value.endsWith("/") ? value.slice(0, -1) : value).split("/");
  requireValid(parts.every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"));
}

function absolutePath(value: unknown, root = false): void {
  text(value, 4096, true);
  requireValid(isAbsolute(value) && value.startsWith("/"));
  relativePath(value.slice(1), root);
}

function map(value: unknown, check: (key: string, entry: unknown) => void, max = MAX_MAP_ENTRIES): void {
  record(value);
  const keys = Object.keys(value);
  requireValid(keys.length <= max);
  for (const key of keys) check(key, value[key]);
}

function paths(value: unknown, root: boolean, trailingSlash: boolean): void {
  requireValid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= MAX_MAP_ENTRIES);
  // Dense arrays only; custom properties/accessors cannot disappear on write.
  requireValid(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValid(descriptor && own(descriptor, "value") && descriptor.enumerable);
    relativePath(descriptor.value, root, trailingSlash);
  }
}

function point(value: unknown): void {
  fields(value, ["snapshot", "timestamp", "label", "refId"], ["outside", "projectModes", "projectUnknown", "projectAbsent"]);
  map(value.snapshot, (key, sha) => {
    relativePath(key, true);
    requireValid(typeof sha === "string" && SHA_RE.test(sha));
  });
  integer(value.timestamp);
  text(value.label, 4096);
  requireValid(typeof value.refId === "string" && REF_RE.test(value.refId));
  if (own(value, "projectModes")) map(value.projectModes, (key, mode) => { relativePath(key); integer(mode, 0, 0o777); });
  if (own(value, "projectUnknown")) paths(value.projectUnknown, true, true);
  if (own(value, "projectAbsent")) paths(value.projectAbsent, false, false);
  if (own(value, "outside")) map(value.outside, (key, entry) => {
    absolutePath(key);
    record(entry);
    if (own(entry, "absent")) {
      fields(entry, ["absent"]);
      requireValid(entry.absent === true);
    } else {
      fields(entry, ["sha", "mode"]);
      requireValid(typeof entry.sha === "string" && SHA256_RE.test(entry.sha));
      integer(entry.mode, 0, 0o777);
    }
  }, 64);
}

function validate(value: unknown, cwd?: string, sessionId?: string): asserts value is RecoveryRecord {
  fields(value, ["version", "cwd", "sessionId", "revision", "undo", "journal"]);
  requireValid(value.version === 1);
  absolutePath(value.cwd, true);
  text(value.sessionId, 1024, true);
  integer(value.revision, 1);
  if (cwd !== undefined) requireValid(value.cwd === cwd);
  if (sessionId !== undefined) requireValid(value.sessionId === sessionId);
  if (value.undo !== null) point(value.undo);
  if (value.journal !== null) {
    const journal = value.journal;
    fields(journal, ["id", "kind", "phase", "startedAt", "before", "target", "previousUndo", "options"], ["error"]);
    requireValid(typeof journal.id === "string" && UUID_RE.test(journal.id));
    requireValid(journal.kind === "rewind" || journal.kind === "undo");
    requireValid(journal.phase === "pending" || journal.phase === "failed");
    integer(journal.startedAt);
    point(journal.before);
    point(journal.target);
    if (journal.previousUndo !== null) point(journal.previousUndo);
    fields(journal.options, ["includeOutside", "includeTypeChanges"]);
    requireValid(typeof journal.options.includeOutside === "boolean" && typeof journal.options.includeTypeChanges === "boolean");
    if (own(journal, "error")) text(journal.error, 8192);
  }
}

export function recoveryPath(storeDir: string, sessionId: string): string {
  text(sessionId, 1024, true);
  return join(storeDir, "recovery", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

export function readRecovery(storeDir: string, cwd: string, sessionId: string): RecoveryRecord | null {
  absolutePath(cwd, true);
  const path = recoveryPath(storeDir, sessionId);
  const value = readPrivateJson(path);
  if (value === null) {
    // JSON null is malformed recovery data, not an absent record.
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    throw new Error("Invalid recovery metadata");
  }
  validate(value, cwd, sessionId);
  return value;
}

/** Caller holds snapshot.lock; revision comparison is not itself a lock. */
export function writeRecovery(
  storeDir: string, cwd: string, sessionId: string, expectedRevision: number,
  update: { undo: StoredUndoPoint | null; journal: RecoveryJournal | null },
): RecoveryRecord {
  integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1);
  fields(update, ["undo", "journal"]);
  const latest = readRecovery(storeDir, cwd, sessionId);
  if ((latest?.revision ?? 0) !== expectedRevision) throw new Error("Recovery revision conflict");
  const next = { version: 1, cwd, sessionId, revision: expectedRevision + 1, undo: update.undo, journal: update.journal };
  validate(next, cwd, sessionId);
  writePrivateJson(recoveryPath(storeDir, sessionId), next);
  return next;
}

/** A failed journal is still unfinished. On unsafe scans, callers must skip
 * pruning altogether; partial protection sets are not proof of completeness. */
export function recoveryProtection(storeDir: string): { pendingSessions: Set<string>; outsideBlobs: Set<string>; unsafe: boolean } {
  const result = { pendingSessions: new Set<string>(), outsideBlobs: new Set<string>(), unsafe: false };
  const directory = join(storeDir, "recovery");
  let dir: ReturnType<typeof opendirSync> | undefined;
  try {
    let stat;
    try { stat = lstatSync(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    requireValid(stat.isDirectory() && !stat.isSymbolicLink());
    dir = opendirSync(directory);
    let entries = 0;
    let records = 0;
    let remaining = MAX_SCAN_BYTES;
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (++entries > MAX_SCAN_ENTRIES) { result.unsafe = true; break; }
      if (!FILE_RE.test(entry.name)) continue;
      if (++records > MAX_SCAN_RECORDS) { result.unsafe = true; break; }
      try {
        const path = join(directory, entry.name);
        const size = lstatSync(path).size;
        requireValid(size > 0 && size <= MAX_RECORD_BYTES && size <= remaining);
        remaining -= size;
        // A growing file fails closed rather than exceeding the scan budget.
        const value = readPrivateJson(path, size);
        validate(value);
        requireValid(recoveryPath(storeDir, value.sessionId) === path);
        if (value.journal !== null) result.pendingSessions.add(value.sessionId);
        const points = [value.undo, value.journal?.before, value.journal?.target, value.journal?.previousUndo];
        for (const stored of points) {
          for (const outside of Object.values(stored?.outside ?? {})) {
            if (own(outside, "sha")) result.outsideBlobs.add((outside as { sha: string }).sha);
          }
        }
      } catch {
        result.unsafe = true;
      }
    }
  } catch {
    result.unsafe = true;
  } finally {
    try { dir?.closeSync(); } catch { result.unsafe = true; }
  }
  return result;
}

/** Caller holds snapshot.lock. Retention policy is intentionally external. */
export function removeCompletedRecovery(storeDir: string, cwd: string, sessionId: string): void {
  const value = readRecovery(storeDir, cwd, sessionId);
  if (value === null) return;
  if (value.journal !== null) throw new Error("Cannot remove unfinished recovery metadata");
  unlinkSync(recoveryPath(storeDir, sessionId));
}
