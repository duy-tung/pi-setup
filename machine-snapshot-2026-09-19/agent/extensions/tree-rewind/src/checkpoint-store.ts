import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PromptCheckpoint } from "./types.js";
import { readPrivateJson, writePrivateJson } from "./storage.js";

/** Git pathspecs are used literally; repository metadata never belongs to us. */
export function validProjectPath(value: unknown, directory = false): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value)) return false;
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  return path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

export function validCheckpoint(value: unknown): value is PromptCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cp = value as Partial<PromptCheckpoint>;
  if (typeof cp.entryId !== "string" || !cp.entryId || cp.entryId.length > 512) return false;
  if (typeof cp.prompt !== "string" || cp.prompt.length > 2000 || !Number.isFinite(cp.timestamp)) return false;
  if (!cp.snapshot || typeof cp.snapshot !== "object" || Array.isArray(cp.snapshot)) return false;
  for (const [sub, sha] of Object.entries(cp.snapshot)) {
    if (sub !== "" && !validProjectPath(sub)) return false;
    if (typeof sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return false;
  }
  if (cp.projectModes !== undefined) {
    if (!cp.projectModes || typeof cp.projectModes !== "object" || Array.isArray(cp.projectModes)) return false;
    for (const [rel, mode] of Object.entries(cp.projectModes)) {
      if (!validProjectPath(rel) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) return false;
    }
  }
  if (cp.projectUnknown !== undefined && (!Array.isArray(cp.projectUnknown) || cp.projectUnknown.length > 4096 ||
      !cp.projectUnknown.every(path => path === "" || validProjectPath(path, true)))) return false;
  for (const paths of [cp.projectAbsent, cp.projectTouched]) {
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => validProjectPath(path)))) return false;
  }
  if (cp.after !== undefined) {
    const after = cp.after;
    if (!after || typeof after !== "object" || Array.isArray(after) || typeof after.refId !== "string" ||
        !/^op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after.refId) ||
        Object.keys(after).some(key => !["refId", "timestamp", "snapshot", "outside", "projectModes", "projectUnknown"].includes(key))) return false;
    if (!validCheckpoint({ entryId: "after", prompt: "", timestamp: after.timestamp, snapshot: after.snapshot,
      projectModes: after.projectModes, projectUnknown: after.projectUnknown })) return false;
    if (after.outside !== undefined) {
      if (!after.outside || typeof after.outside !== "object" || Array.isArray(after.outside) || Object.keys(after.outside).length > 64) return false;
      for (const [path, entry] of Object.entries(after.outside)) {
        if (!isAbsolute(path) || path.includes("\0") || !entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        if ("absent" in entry) {
          if (entry.absent !== true || Object.keys(entry).length !== 1) return false;
        } else if (typeof entry.sha !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
          Object.keys(entry).some(key => key !== "sha" && key !== "mode")) return false;
      }
    }
  }
  return true;
}

export function checkpointStatePath(storeDir: string, sessionId: string): string {
  return join(storeDir, "checkpoints", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

/** Persist before tools, without appending additional nodes to Pi's tree. */
export function saveCheckpointState(storeDir: string, cwd: string, sessionId: string, checkpoints: Iterable<PromptCheckpoint>, expectedRevision: number, revisionFloor = 0): number {
  const values = [...checkpoints];
  if (!values.every(validCheckpoint)) throw new Error("invalid checkpoint state");
  const current = readCheckpointState(storeDir, cwd, sessionId);
  if (current.revision !== expectedRevision) throw new Error("checkpoint state changed in another session instance; reload before editing");
  const revision = Math.max(current.revision, revisionFloor) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid checkpoint revision");
  writePrivateJson(checkpointStatePath(storeDir, sessionId), { version: 1, cwd, sessionId, revision, checkpoints: values }, 64 * 1024 * 1024);
  return revision;
}

export function readCheckpointState(storeDir: string, cwd: string, sessionId: string): { checkpoints: PromptCheckpoint[]; revision: number } {
  const path = checkpointStatePath(storeDir, sessionId);
  const value = readPrivateJson(path, 64 * 1024 * 1024) as any;
  if (value === null && !existsSync(path)) return { checkpoints: [], revision: 0 };
  if (value?.version !== 1 || value.cwd !== cwd || value.sessionId !== sessionId ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Array.isArray(value.checkpoints) || !value.checkpoints.every(validCheckpoint)) {
    throw new Error("invalid or mismatched private checkpoint state");
  }
  return { checkpoints: value.checkpoints, revision: value.revision };
}
