import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const unsupportedDirectorySync = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Publication cannot be rolled back merely because a later sync/close failed. */
export class PrivateWriteError extends Error {
  readonly published: boolean;
  constructor(published: boolean) {
    super(published ? "Cannot write private JSON (metadata was published; reload before retrying)" : "Cannot write private JSON");
    this.published = published;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** The containing store's ancestors are trusted; never follow a linked parent
 * or leaf. The caller owns synchronization of this private directory. */
function checkParent(path: string, create: boolean): boolean {
  const parent = dirname(path);
  if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid private directory");
    return true;
  } catch (error) {
    if (!create && code(error) === "ENOENT") return false;
    throw error;
  }
}

function readBoundedBytes(fd: number, maxBytes: number): Buffer | "large" {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (!count) return Buffer.concat(chunks, bytes);
    bytes += count;
    if (bytes > maxBytes) return "large";
    chunks.push(chunk.subarray(0, count));
  }
}

/** Bounded ordinary-file reads, without following the final symlink. An open
 * descriptor survives path replacement; NONBLOCK also avoids a raced FIFO.
 * Parent traversal is the caller's responsibility, not a sandbox boundary. */
export function readBoundedRegular(path: string, maxBytes: number): Buffer | "large" | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 0x7ffffffe) throw new Error("Invalid file byte limit");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code(error) ?? "")) return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return "large";
    return readBoundedBytes(fd, maxBytes);
  } finally { closeSync(fd); }
}

/** Missing is null. Errors deliberately omit JSON contents and parser details. */
export function readPrivateJson(path: string, maxBytes = MAX_BYTES): unknown | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0x7ffffffe) {
    throw new Error("Invalid private JSON byte limit");
  }
  let fd: number | undefined;
  try {
    if (!checkParent(path, false)) return null;
    let initial;
    try {
      initial = lstatSync(path);
    } catch (error) {
      if (code(error) === "ENOENT") return null;
      throw error;
    }
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Invalid private file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > maxBytes) {
      throw new Error("Invalid private file");
    }
    const bytes = readBoundedBytes(fd, maxBytes);
    if (bytes === "large") throw new Error("Private file exceeds limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Cannot read private JSON: invalid, unsafe, oversized, or unreadable file");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Publication is one same-directory rename; failures before it preserve the
 * old file. Directory-sync errors after publication may mean the new value is
 * already visible. This is process-crash recovery, not a power-loss guarantee. */
export function writePrivateJson(path: string, value: unknown, maxBytes = MAX_BYTES): void {
  let temp: string | undefined;
  let fd: number | undefined;
  let directoryFd: number | undefined;
  let published = false;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0x7ffffffe) throw new Error("Invalid private JSON byte limit");
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) + 1 > maxBytes) throw new Error("Invalid private JSON");
    checkParent(path, true);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid private file");
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const candidate = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temp = candidate; // Only clean up a temporary file we successfully created.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${text}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    published = true;
    temp = undefined;
    try {
      fsyncSync(directoryFd);
    } catch (error) {
      if (!unsupportedDirectorySync.has(code(error) ?? "")) throw error;
    }
  } catch {
    throw new PrivateWriteError(published);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      try {
        if (temp !== undefined) unlinkSync(temp);
      } finally {
        if (directoryFd !== undefined) {
          try { closeSync(directoryFd); }
          catch { throw new PrivateWriteError(published); }
        }
      }
    }
  }
}
