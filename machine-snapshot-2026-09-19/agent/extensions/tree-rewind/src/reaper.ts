/**
 * Reclaiming abandoned stores with no restorable state.
 *
 * `maintain()` is the only thing that shrinks a store, and it runs at
 * session_shutdown *in that project*. So the one case it structurally cannot
 * reach is the one that costs the most: a store nobody will ever open again.
 *
 * Measured on this machine: opening pi in a 7.4k-file project and quitting
 * without typing a prompt left 44 MB of blobs under a shadow repo with zero
 * refs — `prime()` had staged the worktree, no checkpoint was ever committed,
 * and gc could not run because the session was already over. Delete the
 * project and that 44 MB is unreferenced forever; the store name is a hash, so
 * nothing on disk even says which project it was.
 *
 * Hence two things: stores record their origin, and every session sweeps.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readBoundedRegular } from "./storage.js";

/** Written into every store the first time it is created. */
export const ORIGIN_FILE = "origin";

/** Store directories are `hash(cwd)`: 16 hex characters and nothing else.
 *  Anything under the root that does not look like one is not ours to remove. */
const STORE_NAME = /^[0-9a-f]{16}$/;

/** A store younger than this is left alone whatever it looks like: a cold
 *  prime on a large repo runs for tens of seconds before the first checkpoint
 *  exists, and a sweep from a second session must not mistake that window for
 *  an abandoned store. */
const DEFAULT_GRACE_MS = 24 * 60 * 60_000;

/** Bounded so a pathological store root cannot turn session start into a walk. */
const MAX_STORES = 500;

export function rewindRoot(): string {
  return join(homedir(), ".pi", "agent", "rewind");
}

/**
 * Record which project a store belongs to.
 *
 * Called where the store is *created*, not where it is named: `storeDirFor` is
 * pure and runs for every directory pi starts in, including the ones the gate
 * refuses. Writing a marker there would leave a directory behind for each of
 * them — the exact litter `beginWorkspace` takes care to avoid.
 */
export function markOrigin(storeDir: string, cwd: string): void {
  try {
    mkdirSync(storeDir, { recursive: true });
    const p = join(storeDir, ORIGIN_FILE);
    if (existsSync(p) && readFileSync(p, "utf8").trim() === cwd) return;
    writeFileSync(p, `${cwd}\n`);
  } catch {
    /* the marker is an optimisation for the reaper, never a hard requirement */
  }
}

function readOrigin(storeDir: string): string | null {
  const path = join(storeDir, ORIGIN_FILE);
  try {
    if (!lstatSync(path).isFile()) throw new Error("Unsafe origin marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // Legacy store.
    throw error;
  }
  const bytes = readBoundedRegular(path, 8192);
  if (bytes === null || bytes === "large") throw new Error("Origin marker changed or exceeds limit");
  return bytes.toString("utf8").trim() || null;
}

/** Only a proven empty/missing tree is empty. Symlinks, unreadable entries,
 * special files and exceeding the scan depth retain the store. */
function hasAnyFile(dir: string, depth = 4): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || depth === 0 || hasAnyFile(join(dir, entry.name), depth - 1)) return true;
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Private metadata may describe an absent file without any blob or Git ref.
 * Its retention belongs to per-session maintenance, not the whole-store sweep. */
function hasRestorableState(storeDir: string): boolean {
  for (const dir of ["checkpoints", "recovery", "sessions", "outside"]) {
    if (hasAnyFile(join(storeDir, dir))) return true;
  }
  for (const name of readdirSync(storeDir)) {
    if (!name.endsWith(".git")) continue;
    const gitDir = join(storeDir, name);
    if (!lstatSync(gitDir).isDirectory() || hasAnyFile(join(gitDir, "refs"))) return true;
    const path = join(gitDir, "packed-refs");
    try {
      if (!lstatSync(path).isFile()) return true;
      const bytes = readBoundedRegular(path, 1024 * 1024);
      if (bytes === null || bytes === "large") return true;
      // Unknown/malformed records also retain: they are not proof of no refs.
      if (bytes.toString("utf8").split("\n").some(line => line.trim() && !line.startsWith("#"))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

/** Newest mtime among the things that change when a store is used. Plain
 *  `statSync(storeDir)` is not enough: writing deep inside `root.git` does not
 *  touch the top-level directory. */
function lastUsed(storeDir: string, rootTime?: number): number {
  let newest = rootTime ?? lstatSync(storeDir).mtimeMs;
  for (const name of readdirSync(storeDir)) {
    if (name === "snapshot.lock") continue; // Do not count our own acquisition.
    newest = Math.max(newest, lstatSync(join(storeDir, name)).mtimeMs);
  }
  return newest;
}

export type Reaped = { store: string; origin: string | null; reason: string };

/**
 * Delete stores that cannot become useful again. Best effort by construction:
 * anything unreadable, locked, recent, or holding a ref is left exactly where
 * it is. Never throws — this runs on session start and a full disk or an odd
 * permission must not cost the user their session.
 */
export function reapStores(
  opts: { keep?: string; root?: string; graceMs?: number; now?: number } = {},
): Reaped[] {
  const root = opts.root ?? rewindRoot();
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  const now = opts.now ?? Date.now();
  const reaped: Reaped[] = [];

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return reaped;
  }

  for (const name of names.slice(0, MAX_STORES)) {
    if (!STORE_NAME.test(name)) continue;
    const storeDir = join(root, name);
    if (opts.keep && storeDir === opts.keep) continue;

    const lockPath = join(storeDir, "snapshot.lock");
    let directoryFd: number | undefined;
    let lockFd: number | undefined;
    let retired = false;
    try {
      directoryFd = openSync(storeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const before = fstatSync(directoryFd);
      if (grace > 0 && now - lastUsed(storeDir) < grace) continue;
      // Nonwaiting, with no stale takeover. An old/crashed lock is still a lock.
      lockFd = openSync(lockPath, "wx", 0o600);
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname(), time: now, owner: randomUUID() }));
      const current = lstatSync(storeDir);
      if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) continue;
      if (grace > 0 && now - lastUsed(storeDir, before.mtimeMs) < grace) continue;
      if (hasRestorableState(storeDir)) continue;
      const origin = readOrigin(storeDir);
      // An unmounted/renamed project can return. Only absence of restorable
      // state authorizes deletion; origin availability never does.
      const tombstone = join(root, `.reaping-${name}-${randomUUID()}`);
      // Remove the namespace atomically while still holding its lock. Recursive
      // deletion in place could delete snapshot.lock before the remaining files,
      // admitting a writer into a half-removed store. A recreated store is separate.
      renameSync(storeDir, tombstone);
      retired = true;
      rmSync(tombstone, { recursive: true, force: true });
      reaped.push({ store: name, origin, reason: "no checkpoints" });
    } catch {
      /* Uncertain stores stay put; failed removals leave a private tombstone. */
    } finally {
      if (lockFd !== undefined) {
        if (!retired) {
          try {
            const owned = fstatSync(lockFd), current = lstatSync(lockPath);
            if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lockPath, { force: true });
          } catch { /* retain uncertain locks */ }
        }
        try { closeSync(lockFd); } catch { /* best effort */ }
      }
      if (directoryFd !== undefined) {
        try { closeSync(directoryFd); } catch { /* best effort */ }
      }
    }
  }

  return reaped;
}
