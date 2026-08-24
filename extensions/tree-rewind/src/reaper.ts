/**
 * Reclaiming stores whose project is gone.
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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** A lock touched this recently means a live session, whatever its origin says. */
const LOCK_FRESH_MS = 5 * 60_000;

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
  try {
    const s = readFileSync(join(storeDir, ORIGIN_FILE), "utf8").trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Any file at all under `dir`, without walking further than the first one. */
function hasAnyFile(dir: string, depth = 4): boolean {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of ents) {
    if (e.isFile() || e.isSymbolicLink()) return true;
    if (e.isDirectory() && depth > 0 && hasAnyFile(join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

/**
 * Whether a store holds anything a user could still restore from.
 *
 * Refs, not objects: unreachable objects are precisely what gc exists to drop,
 * so a store full of them and empty of refs is holding nothing. Loose refs and
 * `packed-refs` both count — gc packs them, and a packed ref is still a ref.
 */
function hasCheckpoints(storeDir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(storeDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".git")) continue;
    const gitDir = join(storeDir, name);
    if (hasAnyFile(join(gitDir, "refs", "pi"))) return true;
    try {
      if (/^\S+ refs\/pi\//m.test(readFileSync(join(gitDir, "packed-refs"), "utf8"))) return true;
    } catch {
      /* no packed-refs */
    }
  }
  // Where there is no project, the blob store is the whole of rewind: a store
  // with no repo at all is not therefore empty.
  return hasAnyFile(join(storeDir, "outside"));
}

function lockIsFresh(storeDir: string, now: number): boolean {
  try {
    return now - statSync(join(storeDir, "snapshot.lock")).mtimeMs < LOCK_FRESH_MS;
  } catch {
    return false;
  }
}

/** Newest mtime among the things that change when a store is used. Plain
 *  `statSync(storeDir)` is not enough: writing deep inside `root.git` does not
 *  touch the top-level directory. */
function lastUsed(storeDir: string): number {
  let newest = 0;
  const probe = (p: string) => {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      /* absent */
    }
  };
  probe(storeDir);
  try {
    for (const name of readdirSync(storeDir)) probe(join(storeDir, name));
  } catch {
    /* unreadable */
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

    try {
      if (!statSync(storeDir).isDirectory()) continue;
      if (lockIsFresh(storeDir, now)) continue;
      // `grace > 0` guards the comparison, not the clock: a store written in
      // the same millisecond as the sweep reads back with `now - lastUsed <= 0`,
      // so a zero grace would still skip it. Zero has to mean no grace at all.
      if (grace > 0 && now - lastUsed(storeDir) < grace) continue;

      const origin = readOrigin(storeDir);
      // No marker: written by a version that predates them. Such a store may
      // still hold real checkpoints, so it is judged on content alone.
      const reason =
        origin !== null && !existsSync(origin)
          ? "project no longer exists"
          : !hasCheckpoints(storeDir)
            ? "no checkpoints"
            : null;
      if (!reason) continue;

      rmSync(storeDir, { recursive: true, force: true });
      reaped.push({ store: name, origin, reason });
    } catch {
      /* skip this store, keep sweeping */
    }
  }

  return reaped;
}
