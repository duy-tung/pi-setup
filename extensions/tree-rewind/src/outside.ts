/**
 * Files the agent writes *outside* the project.
 *
 * The shadow repos stop at the worktree boundary, which is deliberate: a
 * checkpoint is `git add -A`, and there is no directory above a project that
 * is safe to stage. But `write`/`edit` do reach outside — a config in
 * `~/.config`, a sibling checkout — and until now those edits were both
 * unrevertible *and* actively harmful: the absolute path went into
 * `forceTrack`, `git add -f` rejected the pathspec, and the whole checkpoint
 * failed. So the prompt that touched a file outside the project was the one
 * prompt with no protection at all.
 *
 * This is a different mechanism, not a bigger repo: content-addressed blobs
 * keyed by absolute path, capturing only files an edit tool actually names.
 * Bounded by construction (64 paths, 8 MiB each) rather than by hoping the
 * directory above is small.
 *
 * The same mechanism is the *whole* of rewind where there is no project
 * (`projectless`: pi started in `~`, in `Downloads`, anywhere `eligibility.ts`
 * refuses to stage). There, nothing is "inside", so every path a write or edit
 * names comes here — which is Claude Code's model, and the only honest one
 * when `git add -A` is off the table.
 *
 * Capture happens in `tool_call`, which pi awaits *before* running the tool
 * (`agent.beforeToolCall`), so the blob is the pre-write content. That
 * baseline is then back-filled into every existing checkpoint that has not
 * already recorded the path: before this write, that is what the file looked
 * like at each of those points.
 *
 * Symlinks are resolved rather than skipped (Claude Code skips them). The
 * write lands on the target's inode, so the target is the thing that has to be
 * snapshotted; recording the resolved absolute path also means restoring never
 * writes *through* a link, and that a link into `~/.ssh` is refused by the
 * same rule as `~/.ssh` itself.
 */

import { createHash, randomUUID } from "node:crypto";
import { markOrigin } from "./reaper.js";
import {
  type Stats,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INSIDE_PROJECT, checkTrackablePath } from "./eligibility.js";
import { OUTSIDE, type OutsideEntry, type OutsideSnapshot, type PlanItem, type PromptCheckpoint } from "./types.js";

/** Big enough for any config or source file, small enough that 64 of them
 *  cannot turn the store into a backup system. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PATHS = 64;
const MAX_KNOWN_PATHS = 4096;
const SHA256_RE = /^[0-9a-f]{64}$/;

const ABSENT: OutsideEntry = { absent: true };

const isAbsent = (e: OutsideEntry): e is { absent: true } => "absent" in e;

function sameEntry(a: OutsideEntry | undefined, b: OutsideEntry | undefined): boolean {
  if (!a || !b) return false;
  if (isAbsent(a) || isAbsent(b)) return isAbsent(a) && isAbsent(b);
  return a.sha === b.sha && a.mode === b.mode;
}

/** `~/.config/foo` reads as a location; `/Users/you/.config/foo` reads as a
 *  path you have to parse. The preview is where the user decides. */
export function displayPath(abs: string): string {
  const home = homedir();
  return abs === home || abs.startsWith(home + "/") ? `~${abs.slice(home.length)}` : abs;
}

type Kind = "file" | "symlink" | "dir" | "other" | "absent";

function kindOnDisk(abs: string): Kind {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch {
    return "absent";
  }
}

/** True only if the file's directory is what it was when the path was vetted:
 *  no symlinked component for writeFileSync/rmSync to follow somewhere else.
 *  Outside the project there is no worktree root to stop at, so the whole
 *  parent chain has to resolve to itself. */
function parentIsReal(abs: string): boolean {
  const parent = dirname(abs);
  try {
    return realpathSync(parent) === parent;
  } catch {
    return false;
  }
}

export interface OutsideApplyResult {
  restored: number;
  deleted: number;
  errors: string[];
}

export class OutsideStore {
  readonly cwd: string;
  private readonly blobDir: string;
  private readonly tracked = new Set<string>();
  private readonly knownPaths = new Set<string>();
  private readonly knownPathFile: string;
  /** display path -> why it is not tracked. Surfaced in the coverage report:
   *  a file we refused to protect must be visible, not merely absent. */
  readonly refused = new Map<string, string>();
  /** `${ino}:${size}:${mtimeMs}` -> sha, so re-snapshotting 64 unchanged files
   *  on every prompt does not re-read up to 512 MiB. */
  private readonly shaCache = new Map<string, string>();

  /** No project here: nothing is "inside", so this store covers everything the
   *  agent edits rather than only what falls outside a worktree. */
  readonly projectless: boolean;

  readonly storeDir: string;

  /**
   * Whether an edit in `cwd` could be tracked at all, asked of the directory
   * rather than of what has happened so far.
   *
   * The status line needs this to tell "nothing edited yet" from "nothing here
   * is ever protectable". Both show zero tracked files, and they are opposite
   * facts: in `~` the next edit is covered, in `~/.ssh` no edit ever will be.
   */
  readonly usable: boolean;

  constructor(cwd: string, storeDir: string, opts: { projectless?: boolean } = {}) {
    this.cwd = cwd;
    this.storeDir = storeDir;
    this.blobDir = join(storeDir, "outside");
    this.knownPathFile = join(storeDir, "outside-paths.json");
    this.projectless = opts.projectless ?? false;
    this.loadKnownPaths();
    // A name that cannot exist: the deny list is about location and shape, and
    // probing with a real file would make the answer depend on what is there.
    this.usable = checkTrackablePath(join(cwd, ".pi-rewind-probe"), this.projectless ? null : cwd).ok;
  }

  get size(): number {
    return this.tracked.size;
  }

  private loadKnownPaths(): void {
    let values: unknown;
    try {
      values = JSON.parse(readFileSync(this.knownPathFile, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(values)) return;
    for (const raw of values.slice(0, MAX_KNOWN_PATHS)) {
      if (typeof raw !== "string" || !isAbsolute(raw)) continue;
      const gate = checkTrackablePath(raw, this.projectless ? null : this.cwd);
      if (gate.ok) this.knownPaths.add(gate.path);
    }
  }

  private persistKnownPaths(): void {
    // Every caller holds snapshot.lock. Merge the latest disk registry first so
    // two long-lived sessions never overwrite each other's registrations.
    this.loadKnownPaths();
    mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    const temp = `${this.knownPathFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify([...this.knownPaths].sort(), null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.knownPathFile);
  }

  /**
   * Re-adopt paths named by checkpoints that were loaded from the session.
   *
   * The tracked set lives in memory and the baselines live in the index, so
   * anything that rebuilds the extension over a live session — `/reload`, and
   * resuming — used to bring the checkpoints back but not the tracking. The
   * old checkpoints still restored, which is what made it quiet: the loss
   * lands on the *next* checkpoint, which silently stops covering a file the
   * status line had been counting a moment earlier.
   *
   * No baseline is captured here. The checkpoints that named these paths
   * already carry theirs, and the current content is not a baseline for
   * anything — capturing it would record post-edit state as if it were what
   * the file looked like before.
   */
  adopt(paths: Iterable<string>): void {
    for (const raw of paths) {
      if (this.tracked.size >= MAX_PATHS) return;
      // The guard runs again rather than trusting the index: the deny list is
      // the current one, not the one in force when the entry was written.
      const gate = checkTrackablePath(raw, this.projectless ? null : this.cwd);
      if (!gate.ok) {
        if (gate.reason !== INSIDE_PROJECT) this.refused.set(displayPath(raw), gate.reason);
        continue;
      }
      if (!this.knownPaths.has(gate.path)) {
        this.refused.set(displayPath(raw), "not present in the private outside-path registry");
        continue;
      }
      this.tracked.add(gate.path);
    }
  }

  /** Treat persisted session entries as untrusted data. Return only canonical,
   * currently allowed paths and structurally valid content references. */
  sanitizeSnapshot(snapshot: OutsideSnapshot | undefined): OutsideSnapshot | undefined {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
    const clean: OutsideSnapshot = {};
    for (const [raw, entry] of Object.entries(snapshot)) {
      if (Object.keys(clean).length >= MAX_PATHS) break;
      if (!isAbsolute(raw) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const gate = checkTrackablePath(raw, this.projectless ? null : this.cwd);
      if (!gate.ok) {
        if (gate.reason !== INSIDE_PROJECT) this.refused.set(displayPath(raw), gate.reason);
        continue;
      }
      if (!this.knownPaths.has(gate.path)) {
        this.refused.set(displayPath(raw), "not present in the private outside-path registry");
        continue;
      }
      if ("absent" in entry) {
        if (entry.absent === true && Object.keys(entry).length === 1) clean[gate.path] = ABSENT;
        continue;
      }
      const candidate = entry as { sha?: unknown; mode?: unknown };
      if (!SHA256_RE.test(String(candidate.sha ?? ""))) continue;
      if (typeof candidate.mode !== "number" || !Number.isInteger(candidate.mode) || candidate.mode < 0 || candidate.mode > 0o777) continue;
      clean[gate.path] = { sha: String(candidate.sha), mode: candidate.mode };
    }
    return clean;
  }

  /**
   * Record what `path` looks like before the agent writes to it, and back-fill
   * that baseline into checkpoints taken earlier in this session.
   *
   * Returns true when a new path became tracked, so the caller can mark the
   * index dirty — the back-fill mutated checkpoints that are already persisted.
   */
  touch(rawPath: string, checkpoints: Iterable<PromptCheckpoint>): boolean {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(this.cwd, rawPath);
    const gate = checkTrackablePath(abs, this.projectless ? null : this.cwd);
    if (!gate.ok) {
      // Inside the project is not a refusal: the shadow repo owns it.
      if (gate.reason !== INSIDE_PROJECT) this.refused.set(displayPath(abs), gate.reason);
      return false;
    }
    const path = gate.path;
    if (this.tracked.has(path)) return false;
    if (this.tracked.size >= MAX_PATHS) {
      this.refused.set(displayPath(path), `over the ${MAX_PATHS}-file limit outside the project`);
      return false;
    }
    if (!this.knownPaths.has(path) && this.knownPaths.size >= MAX_KNOWN_PATHS) {
      this.refused.set(displayPath(path), `over the ${MAX_KNOWN_PATHS}-path private registry limit`);
      return false;
    }

    const baseline = this.capture(path);
    if (!baseline) return false;
    this.knownPaths.add(path);
    try {
      this.persistKnownPaths();
    } catch (error) {
      this.knownPaths.delete(path);
      this.refused.set(displayPath(path), `cannot persist private path registry: ${(error as Error).message}`);
      return false;
    }
    this.tracked.add(path);
    this.refused.delete(displayPath(path));

    let touched = false;
    for (const cp of checkpoints) {
      if (!cp.outside) cp.outside = {};
      if (!(path in cp.outside)) {
        cp.outside[path] = baseline;
        touched = true;
      }
    }
    return touched || true;
  }

  /** Current on-disk state of every tracked path, with blobs written. This is
   *  what a checkpoint records. */
  snapshotTracked(): OutsideSnapshot {
    const out: OutsideSnapshot = {};
    for (const path of [...this.tracked]) {
      const entry = this.capture(path);
      if (!entry) {
        // Became a directory, a symlink, or too large: stop claiming coverage
        // rather than record a snapshot we would refuse to restore.
        this.tracked.delete(path);
        continue;
      }
      out[path] = entry;
    }
    return out;
  }

  /** What it would take to make the tracked paths match `to`. `from` is the
   *  disk, read here rather than carried: the user may have edited these files
   *  by hand since the checkpoint, and that is exactly what must show up. */
  plan(to: OutsideSnapshot | undefined): PlanItem[] {
    if (!to) return [];
    const items: PlanItem[] = [];

    for (const [path, target] of Object.entries(to)) {
      const disk = kindOnDisk(path);
      const now = this.read(path);
      if (sameEntry(now, target)) continue;

      const base = { repo: OUTSIDE, path, display: displayPath(path) };

      if (isAbsent(target)) {
        if (disk === "absent") continue;
        if (disk !== "file") {
          items.push({ ...base, action: "type-change", reason: `target says absent, disk holds a ${disk}` });
        } else {
          items.push({ ...base, action: "delete" });
        }
        continue;
      }

      if (!this.hasBlob(target.sha)) {
        items.push({ ...base, action: "unprotected", reason: "snapshot pruned from the store" });
        continue;
      }

      const targetMode = (target.mode & 0o777).toString(8).padStart(4, "0");
      if (disk !== "absent" && disk !== "file") {
        items.push({
          ...base,
          action: "type-change",
          reason: `${disk} → file`,
          targetSha: target.sha,
          targetMode,
        });
        continue;
      }

      // Always in place: truncate-and-write keeps the inode, so hardlinked
      // siblings see the change instead of being orphaned with stale content.
      items.push({ ...base, action: "restore", writer: "in-place", targetSha: target.sha, targetMode });
    }

    return items;
  }

  apply(items: PlanItem[]): OutsideApplyResult {
    const result: OutsideApplyResult = { restored: 0, deleted: 0, errors: [] };

    for (const item of items) {
      const abs = item.path;
      const kind = kindOnDisk(abs);

      // TOCTOU: a confirmation dialog can sit open for a while, and these
      // paths are shared with the rest of the machine.
      if (!parentIsReal(abs) && item.action !== "delete") {
        result.errors.push(`write ${item.display}: parent is no longer a real directory, skipped`);
        continue;
      }

      if (item.action === "delete") {
        if (kind !== "file") {
          result.errors.push(`delete ${item.display}: no longer a regular file, skipped`);
          continue;
        }
        if (!parentIsReal(abs)) {
          result.errors.push(`delete ${item.display}: parent is no longer a real directory, skipped`);
          continue;
        }
        try {
          rmSync(abs, { force: true });
          result.deleted++;
        } catch (err) {
          result.errors.push(`delete ${item.display}: ${(err as Error).message}`);
        }
        // Directories outside the project are never pruned: they are not ours.
        continue;
      }

      if (!item.targetSha) {
        if (item.action === "type-change") {
          try {
            rmSync(abs, { recursive: true, force: true });
            result.deleted++;
          } catch (error) {
            result.errors.push(`delete ${item.display}: ${(error as Error).message}`);
          }
        }
        continue;
      }

      // Read the promised replacement before touching the current path. The
      // blob can be pruned between plan and apply; that must leave user data
      // intact rather than turn a confirmed replacement into pure deletion.
      const buf = this.readBlob(item.targetSha);
      if (!buf) {
        result.errors.push(`missing snapshot for ${item.display}; original left untouched`);
        continue;
      }

      if (item.action === "type-change") {
        const parent = dirname(abs);
        const stem = `.${basename(abs)}.pi-rewind-${randomUUID()}`;
        const prepared = join(parent, `${stem}.new`);
        const backup = join(parent, `${stem}.old`);
        let movedOriginal = false;
        try {
          writeFileSync(prepared, buf, { flag: "wx", mode: parseInt(item.targetMode ?? "0644", 8) });
          if (item.targetMode) chmodSync(prepared, parseInt(item.targetMode, 8));
          if (kindOnDisk(abs) !== "absent") {
            renameSync(abs, backup);
            movedOriginal = true;
          }
          try {
            renameSync(prepared, abs);
          } catch (error) {
            if (movedOriginal && kindOnDisk(abs) === "absent") renameSync(backup, abs);
            throw error;
          }
          result.restored++;
          if (movedOriginal) {
            try {
              rmSync(backup, { recursive: true, force: true });
            } catch (error) {
              result.errors.push(`replace ${item.display}: replacement installed but old backup remains at ${backup}: ${(error as Error).message}`);
            }
          }
        } catch (error) {
          result.errors.push(`replace ${item.display}: ${(error as Error).message}`);
        } finally {
          rmSync(prepared, { recursive: true, force: true });
        }
        continue;
      }

      if (kind === "symlink" || kind === "dir") {
        result.errors.push(`write ${item.display}: disk changed since the plan, skipped`);
        continue;
      }
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, buf);
        if (item.targetMode) chmodSync(abs, parseInt(item.targetMode, 8));
        result.restored++;
      } catch (err) {
        result.errors.push(`write ${item.display}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /** Blobs are content-addressed and re-created on the next touch, so age is a
   *  safe eviction key: the worst case is an old checkpoint whose plan says
   *  "snapshot pruned" instead of silently restoring nothing. */
  maintain(maxAgeDays = 30): void {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    let dirs: string[];
    try {
      dirs = readdirSync(this.blobDir);
    } catch {
      return;
    }
    for (const d of dirs) {
      const sub = join(this.blobDir, d);
      let files: string[];
      try {
        files = readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        const p = join(sub, f);
        try {
          if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
        } catch {
          /* vanished */
        }
      }
    }
  }

  /** Read state without writing a blob or recording a refusal: used to compare
   *  the disk against a target. */
  private read(abs: string): OutsideEntry | undefined {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return ABSENT;
    }
    if (!st.isFile()) return undefined;
    const sha = this.shaOf(abs, st);
    return sha ? { sha, mode: st.mode & 0o777 } : undefined;
  }

  private capture(abs: string): OutsideEntry | null {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      // Not there yet: the agent is creating it, and "absent" is what rewinding
      // has to restore — otherwise a newly created file could never be removed.
      return ABSENT;
    }

    const refuse = (why: string): null => {
      this.refused.set(displayPath(abs), why);
      return null;
    };

    // Only reachable for a dangling link: an intact one was already resolved
    // to its target by the guard.
    if (st.isSymbolicLink()) return refuse("symlink");
    if (st.isDirectory()) return refuse("directory");
    if (!st.isFile()) return refuse("not a regular file");
    if (st.size > MAX_BYTES) return refuse(`larger than ${MAX_BYTES / 1024 / 1024} MiB`);

    try {
      const buf = readFileSync(abs);
      const sha = createHash("sha256").update(buf).digest("hex");
      this.writeBlob(sha, buf);
      this.shaCache.set(statKey(st), sha);
      return { sha, mode: st.mode & 0o777 };
    } catch (err) {
      return refuse(`unreadable: ${(err as Error).message}`);
    }
  }

  private shaOf(abs: string, st: Stats): string | null {
    const key = statKey(st);
    const hit = this.shaCache.get(key);
    if (hit) return hit;
    try {
      if (st.size > MAX_BYTES) return null;
      const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
      this.shaCache.set(key, sha);
      return sha;
    } catch {
      return null;
    }
  }

  private blobPath(sha: string): string {
    if (!SHA256_RE.test(sha)) throw new Error("invalid outside snapshot sha");
    return join(this.blobDir, sha.slice(0, 2), sha);
  }

  private hasBlob(sha: string): boolean {
    try {
      statSync(this.blobPath(sha));
      return true;
    } catch {
      return false;
    }
  }

  private readBlob(sha: string): Buffer | null {
    try {
      return readFileSync(this.blobPath(sha));
    } catch {
      return null;
    }
  }

  private writeBlob(sha: string, buf: Buffer): void {
    const p = this.blobPath(sha);
    try {
      statSync(p);
      // Same content already stored: refresh mtime so age-based pruning does
      // not evict a blob that is still the live content of a tracked file.
      const now = new Date();
      utimesSync(p, now, now);
      return;
    } catch {
      /* not stored yet */
    }
    // Here rather than in the constructor: a store is *named* for every
    // directory pi starts in, and only created when something is actually
    // written. In a projectless session this is the only creation point there
    // is, so it is also the only place the origin marker can come from.
    markOrigin(this.storeDir, this.cwd);
    mkdirSync(dirname(p), { recursive: true });
    // 0600: this is content from anywhere on the machine, sitting in a store
    // that outlives the session.
    writeFileSync(p, buf, { mode: 0o600 });
  }
}

function statKey(st: Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}
