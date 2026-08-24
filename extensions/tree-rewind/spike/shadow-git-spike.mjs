#!/usr/bin/env node
/**
 * Shadow-git snapshot spike for pi-tree-rewind.
 *
 * Measures whether a shadow git repo (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
 * pointed at someone else's worktree) is fast enough and *byte-exact* enough to
 * back per-node worktree checkpoints on a large real repo.
 *
 * NON-DESTRUCTIVE. It appends a marker line to N small tracked text files to
 * measure a realistic incremental snapshot, then rewrites their exact original
 * bytes in a finally block and verifies the sha256 round trip. It also creates
 * N throwaway files in a non-ignored directory and deletes them. It never
 * touches the target's own .git.
 *
 *   node spike/shadow-git-spike.mjs <repoPath> [options]
 *
 *   --force-all        also measure `git add -A -f` (ignores .gitignore: the
 *                      "snapshot node_modules too" policy)
 *   --no-attr-override skip the $GIT_DIR/info/attributes guard, to demonstrate
 *                      the corruption it prevents
 *   --no-seed          skip delta-seeding from the target's own index, to
 *                      demonstrate the tracked-but-ignored files it recovers
 *   --full-restore     also measure restoring the whole tree into a scratch dir
 *   --new-files N      files created / tracked files edited per measurement (default 3)
 *   --sample N         files hashed for byte-exactness round-trip (default 150)
 *   --keep             keep the shadow repo instead of deleting it
 *   --json <path>      write raw results as JSON
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const repo = path.resolve(argv.find((a) => !a.startsWith("--")) ?? ".");
const NEW_FILES = Number(opt("--new-files", 3));
const SAMPLE = Number(opt("--sample", 150));
const jsonOut = opt("--json", null);

if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
  console.error(`not a directory: ${repo}`);
  process.exit(1);
}

// ---------------------------------------------------------------- shadow repo

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shadow-spike-"));
const GIT_DIR = path.join(work, "shadow.git");
const GIT_INDEX_FILE = path.join(work, "index");
const SCRATCH = path.join(work, "scratch");

// Hermetic: no system/global config, so the user's git-lfs filter definitions
// (and anything else) cannot rewrite content on the way in or out.
const env = {
  ...process.env,
  GIT_DIR,
  GIT_WORK_TREE: repo,
  GIT_INDEX_FILE,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

const CONFIG = {
  "core.bare": "false",
  "core.compression": "0", // ~25% faster cold snapshot, ~50% more disk
  "core.looseCompression": "0",
  "core.fsync": "none",
  "core.untrackedCache": "true",
  "core.autocrlf": "false",
  "core.safecrlf": "false",
  "core.symlinks": "true",
  "core.bigFileThreshold": "8m",
  "index.version": "4",
  "gc.auto": "0",
  "advice.addIgnoredFile": "false",
};

function git(args, { input = null, buffer = false, allowFail = false } = {}) {
  const r = spawnSync("git", args, {
    env,
    input,
    encoding: buffer ? "buffer" : "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0 && !allowFail) {
    const err = buffer ? r.stderr?.toString() : r.stderr;
    throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${r.status}): ${String(err).slice(0, 400)}`);
  }
  return { out: r.stdout ?? (buffer ? Buffer.alloc(0) : ""), err: r.stderr, status: r.status };
}

function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  timings.push({ label, ms });
  return { ms, value };
}

const timings = [];
const hazards = [];
const results = { repo, git: null, config: CONFIG, timings, hazards, stats: {} };

// ---------------------------------------------------------------- run

const created = [];
const modified = [];
try {
  results.git = git(["--version"]).out.trim();
  fs.mkdirSync(GIT_DIR, { recursive: true });
  // `git init` refuses to run while GIT_WORK_TREE is set, so init in a clean env.
  {
    const initEnv = { ...env };
    delete initEnv.GIT_WORK_TREE;
    delete initEnv.GIT_DIR;
    const r = spawnSync("git", ["init", "-q", "--bare", GIT_DIR], { env: initEnv, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  }

  // THE byte-exactness guard. $GIT_DIR/info/attributes outranks every
  // .gitattributes in the worktree, so this neutralises `text`/`eol`/`filter`
  // (incl. git-lfs) rules that would otherwise rewrite content on the way in
  // or out. Verified: without it, a CRLF file under `* text=auto eol=lf` is
  // silently stored as LF and every restore corrupts it.
  results.attrOverride = !flag("--no-attr-override");
  if (results.attrOverride) {
    fs.mkdirSync(path.join(GIT_DIR, "info"), { recursive: true });
    fs.writeFileSync(
      path.join(GIT_DIR, "info", "attributes"),
      "* -text -diff -filter -crlf -working-tree-encoding\n",
    );
  }
  for (const [k, v] of Object.entries(CONFIG)) git(["config", k, v]);

  // --- 1. cold snapshot (respects the target repo's .gitignore) -------------
  const cold = time("snapshot cold (add -A)", () => git(["add", "-A", "--ignore-errors"], { allowFail: true }));
  if (cold.value.status !== 0) hazards.push(`add -A exited ${cold.value.status}; some paths unreadable`);
  // --- 1b. delta-seed from the target's own index --------------------------
  // `.gitignore` semantics are relative to what is ALREADY tracked: git never
  // ignores a tracked file. A fresh shadow index tracks nothing, so ignore
  // rules apply to everything -- including files upstream tracks. In linux.git
  // on a case-insensitive FS the rule `*.s` swallows 1,365 tracked `.S` files.
  // Seeding only the delta costs ~1.5s vs ~70s for a full forced pathspec.
  const upstream = upstreamTrackedFiles(repo);
  results.stats.upstreamTracked = upstream?.length ?? null;
  if (upstream && !flag("--no-seed")) {
    time("delta-seed from target index", () => {
      // -z everywhere: plain `ls-files` C-quotes non-ASCII paths while `-z`
      // does not, and comparing the two forms invents phantom missing files.
      const have = new Set(git(["ls-files", "-z"]).out.split("\0").filter(Boolean));
      const missing = upstream.filter((p) => !have.has(p));
      results.stats.seededPaths = missing.length;
      if (missing.length) {
        const listFile = path.join(work, "seed.paths");
        fs.writeFileSync(listFile, missing.join("\0"));
        git(["add", "-f", "--ignore-errors", `--pathspec-from-file=${listFile}`, "--pathspec-file-nul"], {
          allowFail: true,
        });
      }
    });
  }

  const tree1 = time("write-tree", () => git(["write-tree"]).out.trim()).value;

  // --- 2. warm snapshot, nothing changed ------------------------------------
  time("snapshot warm (no change)", () => git(["add", "-A", "--ignore-errors"], { allowFail: true }));
  const tree1b = time("write-tree warm", () => git(["write-tree"]).out.trim()).value;
  if (tree1b !== tree1) hazards.push("warm snapshot produced a different tree with no edits — unstable capture");

  // --- 3. inventory ---------------------------------------------------------
  const lsFiles = git(["ls-files", "-s", "-z"]).out.split("\0").filter(Boolean);
  const entries = lsFiles.map((rec) => {
    const [meta, file] = rec.split("\t");
    const [mode, sha] = meta.split(" ");
    return { mode, sha, file };
  });
  const symlinks = entries.filter((e) => e.mode === "120000");
  const gitlinks = entries.filter((e) => e.mode === "160000");
  const execs = entries.filter((e) => e.mode === "100755");

  results.stats.trackedFiles = entries.length;
  results.stats.symlinks = symlinks.length;
  results.stats.submodulesOrNestedRepos = gitlinks.length;
  results.stats.execBits = execs.length;
  results.stats.indexBytes = fs.statSync(GIT_INDEX_FILE).size;
  results.stats.objectBytes = dirSize(GIT_DIR);

  if (gitlinks.length) {
    hazards.push(
      `${gitlinks.length} nested git repo(s)/submodule(s) recorded as gitlinks — their *contents* are NOT snapshotted: ` +
        gitlinks.slice(0, 5).map((g) => g.file).join(", "),
    );
  }

  // --- 3b. .gitattributes scan (before sampling, so the sample can target it)
  const attrs = entries.filter((e) => path.basename(e.file) === ".gitattributes");
  const risky = [];
  const riskyDirs = [];
  for (const a of attrs.slice(0, 200)) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(repo, a.file), "utf8");
    } catch {
      continue;
    }
    let dirIsRisky = false;
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      if (/\b(filter=|eol=|text\b|working-tree-encoding=)/.test(line)) {
        risky.push(`${a.file}: ${line.trim()}`);
        dirIsRisky = true;
      }
    }
    if (dirIsRisky) riskyDirs.push(path.dirname(a.file) === "." ? "" : path.dirname(a.file) + "/");
  }
  results.stats.gitattributesFiles = attrs.length;
  results.stats.gitattributesRiskyRules = risky.slice(0, 20);
  results.stats.gitattributesRiskyCount = risky.length;

  // --- 4a. incremental snapshot after editing REAL tracked files ------------
  // Editing tracked files is what an agent actually does, and unlike creating
  // new files it cannot be silently voided by a broad .gitignore rule
  // (linux's root .gitignore contains `.*`, which swallowed the old fixture).
  const TEXTY = /\.(c|h|go|ts|tsx|js|jsx|py|rs|java|cs|md|txt|json|ya?ml|toml|sh)$/i;
  const editable = [];
  for (const e of entries) {
    if (e.mode !== "100644" || !TEXTY.test(e.file)) continue;
    const abs = path.join(repo, e.file);
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.nlink === 1 && st.size > 0 && st.size < 65536) editable.push({ ...e, abs });
    } catch {
      continue;
    }
    if (editable.length >= NEW_FILES * 4) break;
  }
  const edited = editable.slice(0, NEW_FILES);
  for (const e of edited) {
    e.original = fs.readFileSync(e.abs);
    e.sha = sha256(e.original);
    modified.push(e);
    fs.appendFileSync(e.abs, `\n// pi-spike ${Date.now()}\n`);
  }
  const inc = time(`snapshot incremental (${edited.length} tracked files edited)`, () =>
    git(["add", "-A", "--ignore-errors"], { allowFail: true }),
  );
  if (!edited.length) hazards.push("found no small tracked text file to edit — incremental number is a no-op");
  // The real production cost: stage + tree + commit + move ref, end to end.
  let tree2;
  time("FULL COMMIT CYCLE (add + write-tree + commit-tree + update-ref)", () => {
    git(["add", "-A", "--ignore-errors"], { allowFail: true });
    tree2 = git(["write-tree"]).out.trim();
    const commit = git(
      ["-c", "user.name=pi", "-c", "user.email=pi@local", "commit-tree", tree2, "-m", "checkpoint"],
    ).out.trim();
    git(["update-ref", "refs/pi/checkpoints/spike", commit]);
  });
  if (tree2 === tree1) {
    hazards.push("editing tracked files did not change the snapshot tree — capture is not seeing edits");
  }

  // --- 4b. new-file snapshot, placed somewhere .gitignore will not swallow --
  const host = edited[0] ? path.dirname(edited[0].file) : "";
  const newRel = [];
  for (let i = 0; i < NEW_FILES; i++) {
    const rel = path.join(host, `pi_spike_tmp_${i}${path.extname(edited[0]?.file ?? ".txt")}`);
    if (git(["check-ignore", "-q", "--", rel], { allowFail: true }).status === 0) continue;
    fs.writeFileSync(path.join(repo, rel), `spike ${i} ${Date.now()}\n`);
    created.push(path.join(repo, rel));
    newRel.push(rel);
  }
  if (newRel.length) {
    time(`snapshot incremental (+${newRel.length} new files)`, () =>
      git(["add", "-A", "--ignore-errors"], { allowFail: true }),
    );
  } else {
    hazards.push("every candidate new-file path was .gitignore'd — new-file snapshot not measured");
  }

  // --- 5. diff between two snapshots ---------------------------------------
  time("diff two snapshots", () => git(["diff", "--name-status", tree1, tree2]).out);

  // --- 6. targeted restore (the real restore path: O(changed files)) --------
  fs.mkdirSync(SCRATCH, { recursive: true });
  const restoreSet = entries.filter((e) => e.mode !== "160000").slice(0, 200).map((e) => e.file);
  if (restoreSet.length) {
    const r = time(`targeted restore (${restoreSet.length} files -> scratch)`, () =>
      git(["--work-tree=" + SCRATCH, "checkout-index", "-f", "--", ...restoreSet], { allowFail: true }),
    );
    if (r.value.status !== 0) hazards.push("targeted checkout-index reported errors");
    results.stats.restorePerFileMs = +(r.ms / restoreSet.length).toFixed(3);
  }

  // --- 7. optional: force-all (ignore .gitignore) ---------------------------
  if (flag("--force-all")) {
    const forceIndex = path.join(work, "index.force");
    const fenv = { ...env, GIT_INDEX_FILE: forceIndex };
    const t0 = process.hrtime.bigint();
    spawnSync("git", ["add", "-A", "-f", "--ignore-errors", "."], { env: fenv, encoding: "utf8", maxBuffer: 1 << 28 });
    timings.push({ label: "snapshot cold FORCE-ALL (add -A -f, ignores .gitignore)", ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    const n = spawnSync("git", ["ls-files"], { env: fenv, encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n").filter(Boolean).length;
    results.stats.forceAllFiles = n;
    results.stats.forceAllObjectBytes = dirSize(GIT_DIR);
  }

  // --- 8. optional: full restore worst case ---------------------------------
  if (flag("--full-restore")) {
    const full = path.join(work, "full");
    fs.mkdirSync(full, { recursive: true });
    time("full restore (worst case, whole tree)", () =>
      git(["--work-tree=" + full, "checkout-index", "-a", "-f"], { allowFail: true }),
    );
  }

  // --- 9. byte-exactness round trip ----------------------------------------
  // The single most important correctness check: does what git stored equal the
  // bytes on disk? CRLF conversion, .gitattributes `text`/`eol`, and git-lfs
  // clean filters all silently break this, which would corrupt every restore.
  // Step 4a mutated a few tracked files, but their shas here are from the
  // pristine tree1. Compare against the bytes we saved rather than dropping
  // them from the sample — on a small repo they are exactly the files most
  // likely to expose a filter bug.
  const pristine = new Map(modified.map((m) => [m.file, m.original]));
  const candidates = entries.filter((e) => e.mode === "100644" || e.mode === "100755");
  const sample = pickSample(candidates, SAMPLE, riskyDirs);
  let checked = 0;
  const mismatches = [];
  const rt = time(`byte-exactness round trip (${sample.length} files)`, () => {
    for (const e of sample) {
      const abs = path.join(repo, e.file);
      let disk = pristine.get(e.file);
      if (!disk) {
        try {
          disk = fs.readFileSync(abs);
        } catch {
          continue;
        }
      }
      const blob = git(["cat-file", "blob", e.sha], { buffer: true, allowFail: true }).out;
      checked++;
      if (!Buffer.isBuffer(blob) || !disk.equals(blob)) {
        mismatches.push({ file: e.file, diskBytes: disk.length, blobBytes: blob?.length ?? -1, sha256: sha256(disk).slice(0, 12) });
      }
    }
  });
  results.stats.roundTripChecked = checked;
  results.stats.roundTripMismatches = mismatches;
  results.stats.roundTripPerFileMs = checked ? +(rt.ms / checked).toFixed(3) : null;
  if (mismatches.length) {
    hazards.push(
      `${mismatches.length}/${checked} sampled files are NOT byte-exact in the shadow store — restore would corrupt them: ` +
        mismatches.slice(0, 5).map((m) => `${m.file} (${m.diskBytes}B disk vs ${m.blobBytes}B stored)`).join(", "),
    );
  }
  if (risky.length && !results.attrOverride) {
    hazards.push(`${risky.length} .gitattributes rule(s) can rewrite content — and the info/attributes guard is OFF`);
  }

  // --- 10a. case-insensitive path collisions -------------------------------
  // macOS/APFS and Windows are case-insensitive by default. Two tracked paths
  // differing only in case are ONE file on disk, so restoring either one writes
  // over the other. linux.git has 13 such pairs.
  // Check the target's own index, not just what the shadow captured: a
  // collided path may be missing from disk entirely, so the shadow never
  // sees it and would report all-clear.
  const casePool = upstream ?? entries.map((e) => e.file);
  const byLower = new Map();
  for (const f of casePool) {
    const k = f.toLowerCase();
    byLower.set(k, (byLower.get(k) ?? []).concat(f));
  }
  const collisions = [...byLower.values()].filter((v) => v.length > 1);
  results.stats.caseCollisions = collisions.length;
  results.stats.caseCollisionExamples = collisions.slice(0, 5).map((v) => v.join(" ↔ "));
  results.stats.fsCaseInsensitive = isCaseInsensitive(repo);
  if (collisions.length && results.stats.fsCaseInsensitive) {
    hazards.push(
      `${collisions.length} path pair(s) differ only by case on a case-INSENSITIVE filesystem — ` +
        `restoring one silently overwrites the other: ${results.stats.caseCollisionExamples[0]}`,
    );
  } else if (collisions.length) {
    hazards.push(`${collisions.length} path pair(s) differ only by case (fs is case-sensitive here, but not on macOS/Windows)`);
  }

  // --- 10c. did anything upstream tracks escape the shadow snapshot? -------
  if (upstream) {
    const have = new Set(entries.map((e) => e.file));
    const escaped = upstream.filter((p) => !have.has(p));
    results.stats.upstreamNotCaptured = escaped.length;
    results.stats.upstreamNotCapturedExamples = escaped.slice(0, 5);
    if (escaped.length) {
      const collided = new Set(collisions.flat());
      const other = escaped.filter((p) => !collided.has(p));
      hazards.push(
        `${escaped.length} file(s) tracked by the target repo were NOT captured` +
          (other.length ? ` (${other.length} beyond case collisions, e.g. ${other[0]})` : " (all case collisions)"),
      );
    }
  }

  // --- 10b. hardlinks + oversized files, over the tracked set only ----------
  let hardlinks = 0;
  let big = 0;
  let bytes = 0;
  const BIG = 8 * 1024 * 1024;
  for (const e of entries) {
    if (e.mode === "160000") continue;
    try {
      const st = fs.lstatSync(path.join(repo, e.file));
      bytes += st.size;
      if (st.nlink > 1) hardlinks++;
      if (st.size > BIG) big++;
    } catch {
      /* vanished */
    }
  }
  results.stats.trackedBytes = bytes;
  results.stats.hardlinks = hardlinks;
  results.stats.filesOver8MB = big;
  if (hardlinks) hazards.push(`${hardlinks} tracked file(s) have nlink>1 — restoring by rewrite would break the hardlink`);
  if (symlinks.length) hazards.push(`${symlinks.length} symlink(s) tracked — verify restore recreates links, not link targets`);

  report();
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
} finally {
  // Put every edited file back byte-for-byte and prove it.
  for (const e of modified) {
    try {
      fs.writeFileSync(e.abs, e.original);
      const now = sha256(fs.readFileSync(e.abs));
      if (now !== e.sha) console.error(`!! FAILED TO RESTORE ${e.abs} (sha ${e.sha} -> ${now})`);
    } catch (err) {
      console.error(`!! FAILED TO RESTORE ${e.abs}: ${err.message}`);
    }
  }
  if (modified.length) console.log(`restored ${modified.length} edited file(s) to original bytes`);
  for (const p of created.reverse()) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (!flag("--keep")) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`\nshadow repo kept at ${work}`);
}

// ---------------------------------------------------------------- helpers

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The target repo's own tracked set, read with a clean env so we do not
 *  accidentally query the shadow index instead. */
function upstreamTrackedFiles(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  const clean = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete clean[k];
  const r = spawnSync("git", ["-C", dir, "ls-files", "-z"], { env: clean, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

function isCaseInsensitive(dir) {
  const p = path.join(dir, `.piSpikeCase_${process.pid}`);
  try {
    fs.writeFileSync(p, "");
    const insensitive = fs.existsSync(path.join(dir, `.pispikecase_${process.pid}`));
    fs.rmSync(p, { force: true });
    return insensitive;
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else
        try {
          total += fs.lstatSync(p).size;
        } catch {
          /* ignore */
        }
    }
  }
  return total;
}

/**
 * Spread the sample across the tree, but over-weight (a) files governed by a
 * risky .gitattributes rule and (b) formats that filters mangle. A uniform
 * sample misses the handful of CRLF files that actually prove corruption.
 */
function pickSample(entries, n, riskyDirs = []) {
  const RISKY = /\.(md|txt|ya?ml|json|csv|bat|ps1|cs|sln|patch|diff)$/i;
  const BINARY = /\.(png|jpe?g|gif|pdf|zip|gz|wasm|so|dylib|dll|exe|bin|woff2?|ico|mp4)$/i;
  const underRisky = riskyDirs.length
    ? entries.filter((e) => riskyDirs.some((d) => e.file.startsWith(d))).slice(0, Math.floor(n / 2))
    : [];
  const quota = Math.floor((n - underRisky.length) / 2);
  const risky = entries.filter((e) => RISKY.test(e.file)).slice(0, quota);
  const binary = entries.filter((e) => BINARY.test(e.file)).slice(0, quota);
  const rest = Math.max(0, n - underRisky.length - risky.length - binary.length);
  const step = Math.max(1, Math.floor(entries.length / Math.max(1, rest)));
  const spread = [];
  for (let i = 0; i < entries.length && spread.length < rest; i += step) spread.push(entries[i]);
  const seen = new Set();
  return [...underRisky, ...risky, ...binary, ...spread].filter((e) => (seen.has(e.file) ? false : seen.add(e.file)));
}

function mb(bytes) {
  if (bytes == null) return "-";
  if (bytes > 1 << 30) return (bytes / (1 << 30)).toFixed(2) + " GB";
  return (bytes / (1 << 20)).toFixed(1) + " MB";
}

function report() {
  const s = results.stats;
  const line = "─".repeat(74);
  console.log(`\n${line}\nshadow-git snapshot spike\n${line}`);
  console.log(`repo            ${repo}`);
  console.log(`git             ${results.git}`);
  console.log(`tracked         ${s.trackedFiles.toLocaleString()} files, ${mb(s.trackedBytes)} (after .gitignore)`);
  if (s.upstreamTracked != null)
    console.log(
      `target index    ${s.upstreamTracked.toLocaleString()} files` +
        (s.seededPaths ? `, ${s.seededPaths.toLocaleString()} delta-seeded back in` : "") +
        (s.upstreamNotCaptured ? `, ${s.upstreamNotCaptured} still missing` : ""),
    );
  if (s.forceAllFiles) console.log(`force-all       ${s.forceAllFiles.toLocaleString()} files (ignoring .gitignore)`);
  console.log(`shadow store    ${mb(s.objectBytes)} objects, ${mb(s.indexBytes)} index`);
  console.log(`\ntimings`);
  for (const t of timings) console.log(`  ${t.ms.toFixed(1).padStart(9)} ms   ${t.label}`);
  if (s.restorePerFileMs != null) console.log(`  ${String(s.restorePerFileMs).padStart(9)} ms   per file restored`);

  console.log(`\nverdict`);
  const warm = timings.find((t) => t.label.startsWith("snapshot warm"))?.ms ?? Infinity;
  const cold = timings.find((t) => t.label.startsWith("snapshot cold (")).ms;
  console.log(`  cold snapshot  ${(cold / 1000).toFixed(1)}s  (once per repo, run async at session_start)`);
  console.log(`  warm snapshot  ${warm.toFixed(0)}ms ${warm < 1000 ? "✓ hides inside LLM think time" : "✗ too slow — needs core.fsmonitor/watchman"}`);
  console.log(`  byte-exact     ${s.roundTripMismatches.length === 0 ? `✓ ${s.roundTripChecked} sampled files match exactly` : `✗ ${s.roundTripMismatches.length}/${s.roundTripChecked} MISMATCH`}`);
  console.log(`  attr guard     ${results.attrOverride ? "on" : "OFF"}  ($GIT_DIR/info/attributes overrides ${s.gitattributesRiskyCount ?? 0} risky rule(s))`);
  console.log(
    `  case safety    ${s.caseCollisions === 0 ? "✓ no case-only path collisions" : `✗ ${s.caseCollisions} collision(s)`}` +
      ` (fs is case-${s.fsCaseInsensitive ? "INsensitive" : "sensitive"})`,
  );

  if (hazards.length) {
    console.log(`\nhazards (${hazards.length})`);
    for (const h of hazards) console.log(`  ! ${h}`);
  } else {
    console.log(`\nhazards          none detected`);
  }
  if (s.gitattributesRiskyRules?.length) {
    console.log(`\n.gitattributes rules to neutralise`);
    for (const r of s.gitattributesRiskyRules) console.log(`  ${r}`);
  }
  console.log(line);
}
