import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERMETIC_ENV, nulList, runGit, targetGitDir, targetTrackedFiles, text, type GitResult } from "./git.js";

/**
 * $GIT_DIR/info/attributes outranks every .gitattributes in the worktree.
 * Without it a CRLF file under `* text=auto eol=lf` is stored as LF and every
 * restore silently corrupts it; `filter=lfs` replaces contents with a pointer.
 * Measured: vscode ships 11 such rules, ~/go's module cache ships 101.
 * `-ident` matters too: `* ident` squashes `$Id: … $` to `$Id$` on capture
 * (measured: 28 bytes stored as 17), so every restore would mangle the file.
 */
const ATTR_GUARD = "* -text -diff -filter -crlf -working-tree-encoding -ident\n";
const OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
export const MAX_PROJECT_FILE_BYTES = 128 * 1024 * 1024;

/**
 * Fallback ignores for a project that governs none of its own.
 *
 * `.gitignore` is the only thing that keeps `add -A` off build output, so a
 * directory with neither a `.git` nor a `.gitignore` — a plain `package.json`
 * folder, say — gets its whole `node_modules` hashed into the store. Measured:
 * 3,002 files tracked in a 3,000-file node_modules.
 *
 * These are only ever applied when nothing else governs ignores, never on top
 * of a project's own rules, and the coverage report lists them: an excluded
 * directory is not restorable, and that has to be visible rather than inferred.
 * Files the agent itself writes there still come back through force-track.
 */
const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".gradle/",
  ".cache/",
  "vendor/",
];

const CONFIG: [string, string][] = [
  ["core.bare", "false"],
  ["core.compression", "0"], // ~25% faster cold snapshot, ~50% more disk
  ["core.looseCompression", "0"],
  ["core.fsync", "none"],
  // Git's untracked cache follows filesystem case folding and can hide the
  // old spelling during a case-only rename when the shadow index is strict.
  ["core.untrackedCache", "false"],
  ["core.autocrlf", "false"],
  ["core.safecrlf", "false"],
  ["core.symlinks", "true"],
  // The shadow index must record case-only renames even when the worktree is APFS.
  ["core.ignorecase", "false"],
  ["core.bigFileThreshold", "8m"],
  ["index.version", "4"],
  ["gc.auto", "0"],
  ["advice.addIgnoredFile", "false"],
];

/** A git failure we must not swallow: swallowing it produced checkpoints that
 *  silently contained nothing. */
export class ShadowError extends Error {
  constructor(op: string, stderr: string) {
    super(`shadow git ${op} failed: ${stderr.trim().split("\n")[0] || "unknown error"}`);
    this.name = "ShadowError";
  }
}

/**
 * `add --ignore-errors` exits non-zero when individual files cannot be read;
 * that is tolerable — capture everything else. Anything outside this class
 * (index unwritable, disk full, object store unwritable, lock collision)
 * means the index may be stale, and a checkpoint built from a stale index
 * lies about what it contains — measured: `add` failed, `write-tree` then
 * happily produced the *previous* tree. Those must throw.
 */
const BENIGN_ADD_RE =
  /^(warning:|hint:|error: open\(|error: unable to index file|error: unable to stat|error: '[^']*' does not have a commit checked out|fatal: adding files failed|fatal: pathspec '[^']*' did not match)/;

function checkAdd(r: GitResult, op: string): boolean {
  if (r.code === 0) return r.stderr.trim() === "";
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => BENIGN_ADD_RE.test(l))) return false;
  throw new ShadowError(op, r.stderr);
}

export interface DiffRecord {
  srcMode: string;
  dstMode: string;
  srcSha: string;
  dstSha: string;
  status: string;
  path: string;
}

/** One shadow git repo shadowing one worktree (the project root, or a nested
 *  repo inside it). Never touches the target's own .git. */
export class ShadowRepo {
  /** absolute path of the worktree this shadows */
  readonly worktree: string;
  readonly gitDir: string;
  readonly indexFile: string;
  /** ignore rules this shadow added because the project had none of its own;
   *  empty whenever the project governs its own ignores */
  defaultExcludes: string[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal | undefined;
  private recoveredMissingParent = false;
  private lastSeedMtime = -1;
  /** Raw backend snapshots may tolerate partial add; guarded checkpoints may not. */
  captureIncomplete = false;
  /** the target's real index file (resolved through gitdir files), cached at init */
  private targetIndex: string | null = null;

  // No parameter properties: pi's extension loader and Node's native type
  // stripping are both strip-only and reject them.
  constructor(worktree: string, storeDir: string, key: string, signal?: AbortSignal) {
    this.signal = signal;
    this.worktree = worktree;
    this.gitDir = join(storeDir, `${key}.git`);
    this.indexFile = join(storeDir, `${key}.index`);
    this.env = {
      ...process.env,
      ...HERMETIC_ENV,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.worktree,
      GIT_INDEX_FILE: this.indexFile,
    };
  }

  private run(args: string[], input?: string | Buffer): Promise<GitResult> {
    return runGit(args, this.env, { input, signal: this.signal });
  }

  /** Idempotent: safe to call on an existing store, which is the fast path on
   *  the second and later sessions in the same project. */
  async init(): Promise<void> {
    mkdirSync(this.gitDir, { recursive: true });
    // `git init` refuses to run while GIT_WORK_TREE is set.
    const initEnv: NodeJS.ProcessEnv = { ...process.env, ...HERMETIC_ENV };
    await runGit(["init", "-q", "--bare", this.gitDir], initEnv, { signal: this.signal });
    for (const [k, v] of CONFIG) await this.run(["config", k, v]);
    mkdirSync(join(this.gitDir, "info"), { recursive: true });

    // The attributes guard doubles as the store's capture-rules version: if
    // it changed since this store was built (e.g. `-ident` was added), every
    // stat-clean index entry may hold bytes hashed under the old rules, and
    // git will never re-hash them — it trusts the stat cache. Drop the index;
    // the next stage re-reads every file under the new rules. One cold
    // re-stage buys a correct store instead of wrong blobs sitting there
    // indefinitely.
    const attrFile = join(this.gitDir, "info", "attributes");
    let prevGuard: string | null = null;
    try {
      prevGuard = readFileSync(attrFile, "utf8");
    } catch {
      /* fresh store */
    }
    if (prevGuard !== null && prevGuard !== ATTR_GUARD) {
      rmSync(this.indexFile, { force: true });
      this.lastSeedMtime = -1;
    }
    writeFileSync(attrFile, ATTR_GUARD);

    const dir = await targetGitDir(this.worktree, this.signal);
    this.targetIndex = dir ? join(dir, "index") : null;

    // The target's repo-local excludes are invisible to the shadow (GIT_DIR
    // points elsewhere), so `add -A` swallowed excluded build caches whole —
    // measured with a multi-file dir excluded only via .git/info/exclude.
    // Mirror the file; the same policy as .gitignore then applies: tracked-
    // but-excluded files come back via the delta-seed, agent-touched ones via
    // force-track. The user's *global* excludes stay out (hermetic env).
    let exclude = "";
    if (dir) {
      try {
        exclude = readFileSync(join(dir, "info", "exclude"), "utf8");
      } catch {
        /* target has none */
      }
    }

    // Nothing governs ignores here: no repo to inherit excludes from and no
    // .gitignore to obey. Only then do the defaults apply — a project that ships
    // its own rules keeps them, including the choice to track node_modules.
    this.defaultExcludes =
      !dir && !existsSync(join(this.worktree, ".gitignore")) ? [...DEFAULT_EXCLUDES] : [];
    if (this.defaultExcludes.length) {
      exclude += `${exclude && !exclude.endsWith("\n") ? "\n" : ""}# seeded by pi-tree-rewind: no .git and no .gitignore in this project\n${this.defaultExcludes.join("\n")}\n`;
    }
    writeFileSync(join(this.gitDir, "info", "exclude"), exclude);
  }

  private async assertCandidateSizes(forceTrack: Iterable<string>): Promise<void> {
    const changed = await this.run(["ls-files", "-z", "--modified", "--others", "--exclude-standard"]);
    if (changed.code !== 0) throw new ShadowError("size preflight", changed.stderr);
    const candidates = new Set([...nulList(changed), ...forceTrack]);
    for (const path of candidates) {
      try {
        const stat = statSync(join(this.worktree, path));
        if (stat.isFile() && stat.size > MAX_PROJECT_FILE_BYTES) {
          throw new ShadowError("size preflight", `${path} exceeds ${MAX_PROJECT_FILE_BYTES} bytes`);
        }
      } catch (error) {
        if (error instanceof ShadowError) throw error;
        // Missing or unreadable paths are handled by add --ignore-errors below.
      }
    }
  }

  /**
   * .gitignore semantics are relative to the existing index: git never ignores
   * a file it already tracks. A fresh shadow index tracks nothing, so ignore
   * rules apply to everything — in linux.git the rule `*.s` swallows 1,365
   * tracked `.S` files. Seed only the delta: ~1.5s vs ~70s for a full forced
   * pathspec, same result.
   */
  async stage(forceTrack: Iterable<string> = [], opts: { reseed?: boolean } = {}): Promise<void> {
    const forced = [...forceTrack];
    this.captureIncomplete = false;
    await this.assertCandidateSizes(forced);
    const add = await this.run(["add", "-A", "--ignore-errors"]);
    this.captureIncomplete = !checkAdd(add, "add");

    // Re-deriving the upstream tracked set costs ~0.3s on a 95k-file repo, so
    // only redo it when the target's own index has actually moved (a commit,
    // checkout or stage by the user) rather than on every checkpoint.
    const mtime = this.targetIndexMtime();
    const reseed = opts.reseed || mtime !== this.lastSeedMtime;

    // A forced path may have been absent at the previous checkpoint, or deleted
    // and recreated since then. Its first appearance must still be staged.
    if (!reseed && !forced.length) return;

    const upstream = reseed ? await targetTrackedFiles(this.worktree, this.signal) : null;
    const have = new Set(nulList(await this.run(["ls-files", "-z"])));
    const missing = [
      ...(upstream ?? []).filter((p) => !have.has(p)),
      ...forced.filter((p) => !have.has(p)),
    ].filter((path) => {
      try {
        const st = lstatSync(join(this.worktree, path));
        return st.isFile() || st.isSymbolicLink();
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) this.captureIncomplete = true;
        return false;
      }
    });
    if (missing.length) await this.addForced(missing);
    this.lastSeedMtime = mtime;
  }

  private targetIndexMtime(): number {
    // For submodules and linked worktrees `<wt>/.git` is a gitdir *file*
    // whose mtime never changes; the resolved index path is the only signal
    // that actually moves when the user commits or stages there.
    const candidates = this.targetIndex
      ? [this.targetIndex]
      : [join(this.worktree, ".git", "index"), join(this.worktree, ".git")];
    for (const p of candidates) {
      try {
        return statSync(p).mtimeMs;
      } catch {
        /* try next */
      }
    }
    return 0;
  }

  private async addForced(paths: string[]): Promise<void> {
    const listFile = join(this.gitDir, "seed.paths");
    writeFileSync(listFile, paths.join("\0"));
    const r = await this.run([
      "--literal-pathspecs",
      "add",
      "-f",
      "--ignore-errors",
      `--pathspec-from-file=${listFile}`,
      "--pathspec-file-nul",
    ]);
    if (!checkAdd(r, "add -f")) this.captureIncomplete = true;
  }

  /** Stage the worktree and record it as a commit whose parents mirror the
   *  session tree, making the shadow DAG isomorphic to the conversation. */
  async commit(parents: string[], message: string, forceTrack?: Iterable<string>): Promise<string> {
    await this.stage(forceTrack ?? []);
    const wt = await this.run(["write-tree"]);
    const tree = text(wt).trim();
    if (wt.code !== 0 || !tree) throw new ShadowError("write-tree", wt.stderr);

    const commitArgs = (withParents: boolean) => {
      const args = ["-c", "user.name=pi-rewind", "-c", "user.email=rewind@pi.local", "commit-tree", tree];
      if (withParents) for (const p of parents) if (p) args.push("-p", p);
      args.push("-m", message);
      return args;
    };
    let r = await this.run(commitArgs(true));
    // Maintenance from another process may have pruned an old session parent.
    // Recover as a new root instead of poisoning every future checkpoint.
    if (r.code !== 0 && parents.length > 0 && /not a valid object name|bad object|invalid object/i.test(r.stderr)) {
      r = await this.run(commitArgs(false));
      if (r.code === 0) this.recoveredMissingParent = true;
    }
    const sha = text(r).trim();
    if (r.code !== 0 || !sha) throw new ShadowError("commit-tree", r.stderr);
    return sha;
  }

  consumeMissingParentRecovery(): boolean {
    const recovered = this.recoveredMissingParent;
    this.recoveredMissingParent = false;
    return recovered;
  }

  /** Names only: preserve unknown coverage without copying ignored contents.
   * Git evaluates root/nested .gitignore, info/exclude and seeded defaults. */
  async ignoredPaths(): Promise<string[]> {
    const result = await this.run(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    if (result.code !== 0) throw new ShadowError("ignored coverage", result.stderr);
    return nulList(result);
  }

  /** Add ONLY a first-touch preimage to an existing checkpoint. Restaging the
   * entire worktree here would fold earlier tool changes into its before-state. */
  async backfillFile(commit: string, path: string, unknown = true): Promise<{ commit: string; absent: boolean }> {
    if (!OBJECT_ID_RE.test(commit)) throw new ShadowError("preimage", "invalid checkpoint");
    if (await this.entryAt(commit, path)) return { commit, absent: false };
    // A covered pre-prompt absence cannot become mid-prompt contents just
    // because bash created a file before the first named edit.
    if (!unknown) return { commit, absent: true };
    let st;
    try { st = lstatSync(join(this.worktree, path)); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (st && ((!st.isFile() && !st.isSymbolicLink()) || st.size > MAX_PROJECT_FILE_BYTES)) {
      throw new ShadowError("preimage", "not a bounded regular file or symlink");
    }
    if (!st) return { commit, absent: true };
    const index = join(this.gitDir, `preimage-${randomUUID()}.index`);
    const env = { ...this.env, GIT_INDEX_FILE: index };
    const run = async (args: string[]) => {
      const result = await runGit(args, env, { cwd: this.worktree, signal: this.signal });
      if (result.code !== 0) throw new ShadowError("preimage", result.stderr);
      return text(result).trim();
    };
    try {
      await run(["read-tree", commit]);
      await run(["--literal-pathspecs", "add", "-f", "--", path]);
      const tree = await run(["write-tree"]);
      const patched = await run(["-c", "user.name=pi-rewind", "-c", "user.email=rewind@pi.local",
        "commit-tree", tree, "-p", commit, "-m", "first-touch preimage"]);
      if (!await this.entryAt(patched, path)) throw new ShadowError("preimage", "file disappeared during capture");
      return { commit: patched, absent: false };
    } finally {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
    }
  }

  /** Loose objects accumulate because gc.auto is 0; this is the signal for
   *  when repacking is worth it. */
  async looseObjectCount(): Promise<number> {
    const r = await this.run(["count-objects", "-v"]);
    const m = /^count: (\d+)/m.exec(text(r));
    return m ? Number(m[1]) : 0;
  }

  /** Everything we intend to keep carries a ref, but a *parallel* session may
   *  have objects in flight (a commit written moments before its ref, blobs
   *  mid-write-tree). Measured: `--prune=now` deleted a seconds-old commit
   *  the instant it was unreferenced. The grace window is the fix git itself
   *  ships for exactly this race. */
  async gc(): Promise<void> {
    await this.run(["gc", "--quiet", "--prune=30.minutes.ago"]);
  }

  /** session id -> most recent checkpoint time, from refs/pi/<session>/<entry> */
  async sessionRefs(): Promise<Map<string, number>> {
    const r = await this.run([
      "for-each-ref",
      "--format=%(refname) %(committerdate:unix)",
      "refs/pi/",
    ]);
    const out = new Map<string, number>();
    for (const line of text(r).split("\n").filter(Boolean)) {
      const [refname, ts] = line.split(" ");
      const parts = refname.split("/");
      if (parts.length < 4) continue;
      const session = parts[2];
      const when = Number(ts) || 0;
      out.set(session, Math.max(out.get(session) ?? 0, when));
    }
    return out;
  }

  async hasCommit(sha: string): Promise<boolean> {
    if (!OBJECT_ID_RE.test(sha)) return false;
    const r = await this.run(["cat-file", "-e", `${sha}^{commit}`]);
    return r.code === 0;
  }

  /** `diff --raw` gives both modes and both shas, which is what type-change
   *  detection needs; `--name-status` does not. */
  async diff(from: string, to: string): Promise<DiffRecord[]> {
    if (!OBJECT_ID_RE.test(from) || !OBJECT_ID_RE.test(to)) throw new ShadowError("diff", "invalid object id");
    const r = await this.run(["diff", "--raw", "--no-abbrev", "--no-renames", "-z", from, to]);
    if (r.code !== 0) throw new ShadowError("diff", r.stderr);
    return parseRawDiff(text(r));
  }

  async catBlob(sha: string): Promise<Buffer | null> {
    if (!OBJECT_ID_RE.test(sha)) return null;
    const r = await this.run(["cat-file", "blob", sha]);
    return r.code === 0 ? r.stdout : null;
  }

  /** Size without content, so a caller can refuse to materialise a large blob. */
  async blobSize(sha: string): Promise<number | null> {
    if (!OBJECT_ID_RE.test(sha)) return null;
    const r = await this.run(["cat-file", "-s", sha]);
    const n = Number(text(r).trim());
    return r.code === 0 && Number.isFinite(n) ? n : null;
  }

  /** Point the index at `commit`, then materialise only `paths`. This is the
   *  bulk writer: it restores symlinks (including dangling ones) and file modes
   *  correctly, and it does not write through a symlink. */
  async checkoutPaths(commit: string, paths: string[]): Promise<{ ok: number; failed: string[] }> {
    if (!paths.length) return { ok: 0, failed: [] };
    // A private index for the read-tree/checkout-index pair. The shared index
    // must never be the bridge between those two commands: another session's
    // `add -A` landing in between made checkout-index write back the *current*
    // content while reporting success. A throwaway index also leaves the
    // shared one (and its untracked cache) untouched.
    const tmpIndex = join(this.gitDir, `restore-${process.pid}-${Date.now()}.index`);
    const env = { ...this.env, GIT_INDEX_FILE: tmpIndex };
    try {
      const read = await runGit(["read-tree", commit], env, { signal: this.signal });
      if (read.code !== 0) return { ok: 0, failed: paths };

      // checkout-index takes its path list on stdin only; it has no
      // --pathspec-from-file.
      const r = await runGit(["checkout-index", "-f", "-z", "--stdin"], env, {
        input: paths.join("\0") + "\0",
        signal: this.signal,
      });
      return r.code === 0 ? { ok: paths.length, failed: [] } : { ok: 0, failed: paths };
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  /** Subpaths (relative to this worktree) that are nested git repos. */
  async gitlinks(): Promise<string[]> {
    const recs = nulList(await this.run(["ls-files", "-s", "-z"]));
    const out: string[] = [];
    for (const rec of recs) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      if (rec.slice(0, 6) === "160000") out.push(rec.slice(tab + 1));
    }
    return out;
  }

  async trackedPaths(): Promise<string[]> {
    return nulList(await this.run(["ls-files", "-z"]));
  }

  async pathsAt(commit: string): Promise<string[]> {
    if (!OBJECT_ID_RE.test(commit)) return [];
    return nulList(await this.run(["ls-tree", "-r", "--name-only", "-z", commit]));
  }

  async entryAt(commit: string, path: string): Promise<{ mode: string; sha: string } | null> {
    if (!OBJECT_ID_RE.test(commit)) return null;
    const result = await this.run(["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
    if (result.code !== 0) return null;
    const record = text(result).split("\0").find(Boolean);
    const match = record ? /^(\d+)\s+\w+\s+([0-9a-f]+)\t/.exec(record) : null;
    return match ? { mode: match[1], sha: match[2] } : null;
  }

  async refValue(ref: string): Promise<string | null> {
    const result = await this.run(["show-ref", "--hash", "--verify", ref]);
    return result.code === 0 ? text(result).trim() : null;
  }

  async setRef(ref: string, commit: string): Promise<void> {
    const result = await this.run(["update-ref", ref, commit]);
    if (result.code !== 0) throw new ShadowError("update-ref", result.stderr);
  }

  async deleteRef(ref: string): Promise<void> {
    const result = await this.run(["update-ref", "-d", ref]);
    if (result.code !== 0) throw new ShadowError("delete-ref", result.stderr);
  }

  async deleteRefs(prefix: string): Promise<void> {
    const r = await this.run(["for-each-ref", "--format=%(refname)", prefix]);
    for (const ref of text(r).split("\n").filter(Boolean)) {
      await this.run(["update-ref", "-d", ref]);
    }
  }
}

export function parseRawDiff(raw: string): DiffRecord[] {
  // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`
  const parts = raw.split("\0");
  const out: DiffRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta || meta[0] !== ":") continue;
    const path = parts[++i];
    if (path == null) break;
    const f = meta.slice(1).split(" ");
    if (f.length < 5) continue;
    out.push({ srcMode: f[0], dstMode: f[1], srcSha: f[2], dstSha: f[3], status: f[4], path });
  }
  return out;
}
