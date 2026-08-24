/**
 * Integration test for the v0.3 shadow-git backend.
 *
 * Each case is one of the hazards spike/DECISIONS.md committed to handling.
 * Run: node --import ./spike/register.mjs spike/backend-test.mts
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "../src/workspace.js";
import { LockTimeout, withLock } from "../src/lock.js";
import { group, formatPlan } from "../src/plan.js";
import { applyPlan, applyUndo, beginWorkspace, discardRestorePlan, ensureCheckpoint, planRestore, planUndo, restorePosition, waitReady, READY_BUDGET_MS } from "../src/checkpoints.js";
import { createInitialState } from "../src/state.js";
import { persistIndex, loadIndex } from "../src/checkpoints.js";
import { OutsideStore } from "../src/outside.js";
import { checkTrackablePath } from "../src/eligibility.js";
import { OUTSIDE } from "../src/types.js";
import { reapStores, markOrigin, ORIGIN_FILE } from "../src/reaper.js";
import { storeDirFor } from "../src/workspace.js";

const ROOT = mkdtempSync(join(tmpdir(), "pi-v03-tests-"));
let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`    ✓ ${msg}`);
  } else {
    failed++;
    console.log(`    ✗ ${msg}`);
  }
}

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function newRepo(name: string, git = true): string {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (git) {
    sh(dir, "git", ["init", "-q"]);
    sh(dir, "git", ["config", "user.email", "t@t"]);
    sh(dir, "git", ["config", "user.name", "t"]);
  }
  // each test gets its own shadow store
  rmSync(join(homedir(), ".pi", "agent", "rewind"), { recursive: true, force: true });
  return dir;
}

async function open(dir: string) {
  const ws = await Workspace.open(dir);
  await ws.prime();
  return ws;
}

// ── 1. round trip: edit then restore ────────────────────────────────────────
async function testRoundTrip() {
  console.log("\n1. edit → restore");
  const d = newRepo("roundtrip");
  writeFileSync(join(d, "a.txt"), "original\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");

  writeFileSync(join(d, "a.txt"), "MODIFIED BY AGENT\n");
  writeFileSync(join(d, "new.txt"), "created by agent\n");

  const now = await ws.snapshot(before, "pre-restore");
  const plan = await ws.buildPlan(now, before);
  const g = group(plan);
  ok(g.restore.length === 1 && g.restore[0].display === "a.txt", "a.txt planned for restore");
  ok(g.delete.length === 1 && g.delete[0].display === "new.txt", "new.txt planned for delete");

  const res = await ws.apply(plan);
  ok(readFileSync(join(d, "a.txt"), "utf8") === "original\n", "a.txt content restored");
  ok(!existsSync(join(d, "new.txt")), "new.txt deleted");
  ok(res.errors.length === 0, `no errors (${res.errors.join("; ")})`);
}

// ── 2. tracked-but-gitignored files (the linux `*.s` class of bug) ──────────
async function testTrackedButIgnored() {
  console.log("\n2. file tracked upstream but matching .gitignore");
  const d = newRepo("ignored");
  writeFileSync(join(d, ".gitignore"), "*.log\ndist/\n");
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "dist", "bundle.js"), "v1\n");
  writeFileSync(join(d, "keep.log"), "v1\n");
  sh(d, "git", ["add", "-Af", ".gitignore", "dist/bundle.js", "keep.log"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");

  writeFileSync(join(d, "dist", "bundle.js"), "CLOBBERED\n");
  writeFileSync(join(d, "keep.log"), "CLOBBERED\n");

  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  await ws.apply(plan);
  ok(readFileSync(join(d, "dist", "bundle.js"), "utf8") === "v1\n", "ignored-but-tracked dist/bundle.js restored");
  ok(readFileSync(join(d, "keep.log"), "utf8") === "v1\n", "ignored-but-tracked keep.log restored");
}

// ── 3. agent creates a file inside an ignored dir ───────────────────────────
async function testForceTrack() {
  console.log("\n3. agent touches a path inside an ignored directory");
  const d = newRepo("forcetrack");
  writeFileSync(join(d, ".gitignore"), "node_modules/\n");
  mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(d, "node_modules", "pkg", "index.js"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const touched = ["node_modules/pkg/index.js"];
  const before = await ws.snapshot(null, "cp1", touched);

  writeFileSync(join(d, "node_modules", "pkg", "index.js"), "CLOBBERED\n");
  const now = await ws.snapshot(before, "pre", touched);
  const plan = await ws.buildPlan(now, before);
  await ws.apply(plan);
  ok(
    readFileSync(join(d, "node_modules", "pkg", "index.js"), "utf8") === "v1\n",
    "force-tracked file inside node_modules restored",
  );
}

// ── 4. hardlinks ────────────────────────────────────────────────────────────
async function testHardlink() {
  console.log("\n4. hardlinked file");
  const d = newRepo("hardlink");
  writeFileSync(join(d, "a.txt"), "v1\n");
  chmodSync(join(d, "a.txt"), 0o755);
  linkSync(join(d, "a.txt"), join(d, "b.txt"));
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  const inode = lstatSync(join(d, "a.txt")).ino;

  writeFileSync(join(d, "a.txt"), "v2 modified\n");
  chmodSync(join(d, "a.txt"), 0o644);
  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  const g = group(plan);
  ok(g.restore.some((i) => i.display === "a.txt" && i.writer === "in-place"), "hardlink routed to in-place writer");

  await ws.apply(plan);
  const st = lstatSync(join(d, "a.txt"));
  ok(st.nlink === 2, `nlink preserved (got ${st.nlink})`);
  ok(st.ino === inode, "inode preserved");
  ok((st.mode & 0o777) === 0o755, "checkpointed mode restored on the shared inode");
  ok((lstatSync(join(d, "b.txt")).mode & 0o777) === 0o755, "hardlink sibling sees the restored mode");
  ok(readFileSync(join(d, "b.txt"), "utf8") === "v1\n", "sibling b.txt sees the restored content");
}

// ── 5. symlinks ─────────────────────────────────────────────────────────────
async function testSymlink() {
  console.log("\n5. symlinks");
  const d = newRepo("symlink");
  mkdirSync(join(d, "target"));
  writeFileSync(join(d, "target", "real.txt"), "real\n");
  symlinkSync("target/real.txt", join(d, "link"));
  symlinkSync("nowhere", join(d, "dangling"));
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");

  rmSync(join(d, "link"));
  rmSync(join(d, "dangling"));
  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  await ws.apply(plan);
  ok(lstatSync(join(d, "link")).isSymbolicLink(), "link restored as a symlink");
  ok(lstatSync(join(d, "dangling")).isSymbolicLink(), "dangling link restored as a symlink");
}

// ── 6. type change: file replaced by a directory ────────────────────────────
async function testTypeChange() {
  console.log("\n6. file ↔ directory swap");
  const d = newRepo("typechange");
  writeFileSync(join(d, "thing"), "i am a file\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");

  rmSync(join(d, "thing"));
  mkdirSync(join(d, "thing"));
  writeFileSync(join(d, "thing", "inner.txt"), "user data\n");

  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  const g = group(plan);
  ok(g["type-change"].length === 1, `classified as type-change (${formatPlan(plan).trim().split("\n")[0]?.trim()})`);

  const res1 = await ws.apply(plan);
  ok(res1.skipped.some((i) => i.action === "type-change"), "skipped by default");
  ok(existsSync(join(d, "thing", "inner.txt")), "user data NOT destroyed without confirmation");

  const res2 = await ws.apply(plan, { includeTypeChanges: true });
  ok(res2.restored + res2.deleted > 0, "applied once confirmed");
  ok(lstatSync(join(d, "thing")).isFile(), "thing is a regular file again");
}

// ── 7. nested repo ──────────────────────────────────────────────────────────
async function testNested() {
  console.log("\n7. nested git repo");
  const d = newRepo("nested");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "main.go"), "main v1\n");
  const dep = join(d, "vendor", "dep");
  mkdirSync(dep, { recursive: true });
  sh(dep, "git", ["init", "-q"]);
  sh(dep, "git", ["config", "user.email", "t@t"]);
  sh(dep, "git", ["config", "user.name", "t"]);
  writeFileSync(join(dep, "lib.go"), "lib v1\n");
  sh(dep, "git", ["add", "-A"]);
  sh(dep, "git", ["commit", "-qm", "i"]);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  ok(ws.coverage.nestedCount === 1, `discovered the nested repo (${ws.coverage.nestedCount})`);
  ok(ws.owner("vendor/dep/lib.go").repo === "vendor/dep", "ownership routed to the nested shadow");

  const before = await ws.snapshot(null, "cp1");
  writeFileSync(join(d, "src", "main.go"), "main EDITED\n");
  writeFileSync(join(dep, "lib.go"), "lib EDITED\n");

  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  await ws.apply(plan);
  ok(readFileSync(join(d, "src", "main.go"), "utf8") === "main v1\n", "root file restored");
  ok(readFileSync(join(dep, "lib.go"), "utf8") === "lib v1\n", "file INSIDE the nested repo restored");
}

// ── 8. case collisions declared, never guessed ──────────────────────────────
async function testCaseCollision() {
  console.log("\n8. case-only path collision");
  const d = newRepo("case");
  mkdirSync(join(d, "inc"));
  writeFileSync(join(d, "inc", "xt_connmark.h"), "lower\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  // Put the second casing into the target's own index, as linux.git has it.
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: d, input: "upper\n" })
    .toString()
    .trim();
  sh(d, "git", ["update-index", "--add", "--cacheinfo", `100644,${blob},inc/xt_CONNMARK.h`]);

  const ws = await open(d);
  if (!ws.coverage.caseInsensitive) {
    console.log("    – filesystem is case-sensitive here; collision is representable, skipping");
    return;
  }
  ok(ws.coverage.unrepresentable.length === 2, `both casings declared unprotected (${ws.coverage.unrepresentable.length})`);

  const before = await ws.snapshot(null, "cp1");
  writeFileSync(join(d, "inc", "xt_connmark.h"), "CLOBBERED\n");
  const now = await ws.snapshot(before, "pre");
  const plan = await ws.buildPlan(now, before);
  const g = group(plan);
  ok(
    g.restore.length === 0 && g.unprotected.some((i) => i.display.startsWith("inc/xt_")),
    "collided path refused rather than silently restored",
  );
  const res = await ws.apply(plan);
  ok(readFileSync(join(d, "inc", "xt_connmark.h"), "utf8") === "CLOBBERED\n", "left untouched, as declared");
  ok(res.skipped.length > 0, "reported as skipped");
}

// ── 9. byte-exactness under a hostile .gitattributes ────────────────────────
async function testByteExact() {
  console.log("\n9. CRLF + .gitattributes + LFS filter");
  const d = newRepo("byteexact");
  writeFileSync(join(d, ".gitattributes"), "* text=auto eol=lf\n*.bin filter=lfs -text\n");
  writeFileSync(join(d, "win.txt"), "a\r\nb\r\n");
  writeFileSync(join(d, "data.bin"), Buffer.from([0x42, 0x00, 0xff, 0x0d, 0x0a]));
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  const crlf = readFileSync(join(d, "win.txt"));
  const bin = readFileSync(join(d, "data.bin"));

  writeFileSync(join(d, "win.txt"), "clobbered\n");
  writeFileSync(join(d, "data.bin"), Buffer.from([0x00]));
  const now = await ws.snapshot(before, "pre");
  await ws.apply(await ws.buildPlan(now, before));

  ok(readFileSync(join(d, "win.txt")).equals(crlf), "CRLF file restored byte-exact (not normalised to LF)");
  ok(readFileSync(join(d, "data.bin")).equals(bin), "binary under filter=lfs restored byte-exact");
}

// ── 10. store is reused across sessions ─────────────────────────────────────
async function testWarmReopen() {
  console.log("\n10. reopening the same project");
  const d = newRepo("warm");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws1 = await open(d);
  const cp = await ws1.snapshot(null, "cp1");

  const t0 = Date.now();
  const ws2 = await open(d); // simulates a new pi session
  const reopenMs = Date.now() - t0;
  ok(await ws2.hasSnapshot(cp), "checkpoint from the previous session is still resolvable");

  writeFileSync(join(d, "a.txt"), "v2\n");
  const now = await ws2.snapshot(cp, "pre");
  await ws2.apply(await ws2.buildPlan(now, cp));
  ok(readFileSync(join(d, "a.txt"), "utf8") === "v1\n", "restored across sessions");
  console.log(`    · reopen cost ${reopenMs} ms (cold store is built once per project, not per session)`);
}


// ── 11. concurrent sessions in the same project ─────────────────────────────
async function testConcurrency() {
  console.log("\n11. two sessions in the same project");
  const d = newRepo("concurrent");
  for (let i = 0; i < 50; i++) writeFileSync(join(d, `f${i}.txt`), `v0 ${i}\n`);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const a = await open(d);
  const b = await open(d);
  ok(a.repos.get("")!.indexFile === b.repos.get("")!.indexFile, "both sessions share one shadow index");

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? b : a).snapshot(null, `race ${i}`)),
  );
  const good = results.filter((r) => r.status === "fulfilled" && (r.value as any)[""]);
  ok(good.length === 8, `all 8 concurrent snapshots produced a root commit (${good.length}/8)`);

  const cp = await a.snapshot(null, "verify");
  const probe = join(d, "f0.txt");
  const original = readFileSync(probe);
  writeFileSync(probe, Buffer.from("CLOBBERED\n"));
  const now = await a.snapshot(cp, "pre");
  await a.apply(await a.buildPlan(now, cp));
  ok(readFileSync(probe).equals(original), "restore still correct after concurrent use");
}

// ── 12. failures are surfaced, never recorded as empty checkpoints ──────────
async function testFailureSurfacing() {
  console.log("\n12. a failed snapshot is not a checkpoint");
  const d = newRepo("failure");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  ok((await ws.hasSnapshot({} as any)) === false, "an empty snapshot is not resolvable");
  ok((await ws.hasSnapshot({ "": "0".repeat(40) })) === false, "a dangling commit is not resolvable");

  // Make the object store unwritable so commit-tree must fail.
  const objects = join(ws.storeDir, "root.git", "objects");
  chmodSync(objects, 0o500);
  writeFileSync(join(d, "b.txt"), "new\n");
  let threw = false;
  try {
    await ws.snapshot(null, "should fail");
  } catch {
    threw = true;
  }
  chmodSync(objects, 0o700);
  ok(threw, "snapshot throws instead of returning a partial result");
}

// ── 13. maintenance prunes old sessions and repacks ─────────────────────────
async function testMaintenance() {
  console.log("\n13. store maintenance");
  const d = newRepo("gc");
  for (let i = 0; i < 20; i++) writeFileSync(join(d, `f${i}.txt`), `v0 ${i}\n`);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  let head: any = null;
  for (const session of ["old-session", "current-session"]) {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(d, "f0.txt"), `edit ${session} ${i}\n`);
      head = await ws.snapshot(head, `cp ${i}`);
      await ws.setRefs(head, session, `e${i}`);
    }
  }
  const before = ws.storeBytes();
  const res = await ws.maintain({ sessionId: "current-session", maxSessions: 1, maxAgeDays: 3650 });
  ok(res.prunedSessions.includes("old-session"), "pruned the session beyond the keep count");
  ok(!res.prunedSessions.includes("current-session"), "kept the live session");
  ok(res.packed, "repacked");
  ok(await ws.hasSnapshot(head), "the live session's latest checkpoint still resolves");
  console.log(`    · store ${(before / 1024).toFixed(0)} KB → ${(res.bytesAfter / 1024).toFixed(0)} KB`);
}

// ── 14. a cold prime must not stall the prompt ─────────────────────────────
async function testReadyBudget() {
  console.log("\n14. bounded wait for the cold snapshot");
  const state = createInitialState();
  state.ready = new Promise<void>(() => {}); // never settles, like a 42s prime

  const t0 = performance.now();
  const ws = await waitReady(state, 80);
  const waited = performance.now() - t0;
  ok(ws === null, "gives up rather than blocking the agent");
  ok(waited < 400, `returned promptly (${waited.toFixed(0)} ms)`);

  state.ready = Promise.resolve();
  state.ws = {} as any;
  ok((await waitReady(state, 80)) !== null, "returns the workspace once priming finishes");
  ok(READY_BUDGET_MS <= 5000, "the default budget is small enough to be unnoticeable");
}

// ── 15. ident attribute must not mangle content ───────────────────────────
async function testIdent() {
  console.log("\n15. `* ident` in .gitattributes");
  const d = newRepo("ident");
  writeFileSync(join(d, ".gitattributes"), "* ident\n");
  writeFileSync(join(d, "f.txt"), "hello $Id: deadbeef $ world\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  const orig = readFileSync(join(d, "f.txt"));

  writeFileSync(join(d, "f.txt"), "clobbered\n");
  const now = await ws.snapshot(before, "pre");
  await ws.apply(await ws.buildPlan(now, before));
  ok(readFileSync(join(d, "f.txt")).equals(orig), "restored byte-exact ($Id: deadbeef $ not squashed to $Id$)");
}

// ── 16. add failures beyond unreadable files must throw ────────────────────
async function testStageFailureSurfaced() {
  console.log("\n16. a stale index is not a checkpoint");
  const d = newRepo("stagefail");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);
  await ws.snapshot(null, "cp1");

  // Object store unwritable: `add -A` cannot store the new blob, the index
  // goes stale, and `write-tree` would happily commit the *previous* state.
  writeFileSync(join(d, "a.txt"), "v2\n");
  const objects = join(ws.storeDir, "root.git", "objects");
  chmodSync(objects, 0o500);
  let threw = false;
  try {
    await ws.snapshot(null, "must fail");
  } catch {
    threw = true;
  }
  chmodSync(objects, 0o700);
  ok(threw, "snapshot throws instead of committing a stale index");

  // A single unreadable worktree file stays tolerated: capture what we can.
  writeFileSync(join(d, "locked.txt"), "x\n");
  chmodSync(join(d, "locked.txt"), 0o000);
  let tolerated = true;
  try {
    await ws.snapshot(null, "cp2");
  } catch {
    tolerated = false;
  }
  chmodSync(join(d, "locked.txt"), 0o644);
  ok(tolerated, "a single unreadable file does not fail the whole checkpoint");
}

// ── 17. real submodule: reseed keys off the resolved index file ─────────────
async function testSubmoduleReseed() {
  console.log("\n17. real submodule (`.git` is a file)");
  const src = join(ROOT, "submod-src");
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  sh(src, "git", ["init", "-q"]);
  writeFileSync(join(src, "lib.txt"), "lib v1\n");
  sh(src, "git", ["add", "-A"]);
  sh(src, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);

  const d = newRepo("submod");
  writeFileSync(join(d, "root.txt"), "root\n");
  sh(d, "git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub"]);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "add sub"]);

  const ws = await open(d);
  ok(ws.coverage.nestedCount === 1, "submodule discovered as a nested shadow");
  const cp1 = await ws.snapshot(null, "cp1");

  // After prime, a tracked-but-ignored file appears inside the submodule.
  // Only a reseed captures it, and the reseed trigger is the mtime of the
  // *resolved* index (../.git/modules/sub/index) — sub/.git is a file whose
  // mtime never changes.
  const sub = join(d, "sub");
  writeFileSync(join(sub, ".gitignore"), "*.gen\n");
  writeFileSync(join(sub, "x.gen"), "gen v1\n");
  sh(sub, "git", ["add", "-f", "-A"]);
  sh(sub, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "track gen"]);

  const cp2 = await ws.snapshot(cp1, "cp2");
  writeFileSync(join(sub, "x.gen"), "CLOBBERED\n");
  const now = await ws.snapshot(cp2, "pre");
  await ws.apply(await ws.buildPlan(now, cp2));
  ok(
    readFileSync(join(sub, "x.gen"), "utf8") === "gen v1\n",
    "tracked-but-ignored file in the submodule captured after reseed",
  );
}

// ── 18. delete must not follow a symlinked parent out of the worktree ───────
async function testSymlinkParentGuard() {
  console.log("\n18. symlinked parent between plan and apply");
  const d = newRepo("symparent");
  writeFileSync(join(d, "base.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const outside = join(ROOT, "symparent-outside");
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "b"), "PRECIOUS\n");

  const ws = await open(d);
  const cp1 = await ws.snapshot(null, "cp1"); // no a/ yet
  mkdirSync(join(d, "a"));
  writeFileSync(join(d, "a", "b"), "x\n");
  const now = await ws.snapshot(cp1, "pre"); // has a/b
  const plan = await ws.buildPlan(now, cp1);
  ok(plan.items.some((i) => i.action === "delete" && i.display === "a/b"), "plan wants to delete a/b");

  // TOCTOU: while the confirm dialog sits open, a/ becomes a symlink pointing
  // outside the project.
  rmSync(join(d, "a"), { recursive: true, force: true });
  symlinkSync(outside, join(d, "a"));
  const res = await ws.apply(plan);
  ok(readFileSync(join(outside, "b"), "utf8") === "PRECIOUS\n", "file outside the worktree survives");
  ok(res.errors.length > 0, "the refused delete is reported, not silent");
  rmSync(join(d, "a"), { force: true });
}

// ── 19. nested repo created mid-session is declared ────────────────────────
async function testMidSessionNestedRepo() {
  console.log("\n19. `git clone` after prime");
  const d = newRepo("midnested");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const cp1 = await ws.snapshot(null, "cp1");

  // The agent clones a repo into the project after discovery already ran.
  const dep = join(d, "newdep");
  mkdirSync(dep);
  sh(dep, "git", ["init", "-q"]);
  writeFileSync(join(dep, "lib.txt"), "lib\n");
  sh(dep, "git", ["add", "-A"]);
  sh(dep, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);

  const cp2 = await ws.snapshot(cp1, "cp2");
  ok(ws.coverage.skippedNested.includes("newdep"), "declared in coverage after the next snapshot");
  const plan = await ws.buildPlan(cp2, cp1);
  ok(
    plan.items.some((i) => i.action === "unprotected" && i.display === "newdep"),
    "appears as unprotected in the restore preview, not silently absent",
  );
}

// ── 20. stale locks fail closed; active contenders still serialise ──────────
async function testLockSteal() {
  console.log("\n20. stale lock fails closed without risking live-lock theft");
  const dir = join(ROOT, "locktest");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "snapshot.lock");
  writeFileSync(lock, JSON.stringify({ pid: 999999999, host: "elsewhere", time: 0, owner: "dead" }));
  let timedOut = false;
  try {
    await withLock(lock, async () => {}, { timeoutMs: 30, staleMs: 1 });
  } catch (error) {
    timedOut = error instanceof LockTimeout;
  }
  ok(timedOut && existsSync(lock), "dead-looking lock is never removed automatically");
  rmSync(lock);

  let inside = 0;
  let overlap = false;
  let runs = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withLock(lock, async () => {
        inside++;
        if (inside > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 20));
        inside--;
        runs++;
      }),
    ),
  );
  ok(runs === 4 && !overlap, `4 active contenders serialised (${runs} runs, overlap=${overlap})`);
}

// ── 21. gc must not eat fresh unreferenced commits ─────────────────────────
async function testGcGrace() {
  console.log("\n21. gc against in-flight objects");
  const d = newRepo("gcgrace");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  const cp = await ws.snapshot(null, "deliberately unreferenced");
  await ws.repos.get("")!.gc();
  ok(await ws.hasSnapshot(cp), "a seconds-old unreferenced commit survives gc (prune grace)");
}

// ── 22. checkpoint ref is written inside the snapshot lock ──────────────────
async function testRefInsideSnapshot() {
  console.log("\n22. no commit is ever visible unreferenced");
  const d = newRepo("refin");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  await ws.snapshot(null, "cp", [], { ref: { sessionId: "sess-a", entryId: "e1" } });
  const refs = await ws.repos.get("")!.sessionRefs();
  ok(refs.has("sess-a"), "refs/pi/sess-a/e1 exists the moment snapshot() returns");
}

// ── 23. apply and a concurrent snapshot serialise on the store lock ─────────
async function testApplySnapshotSerialised() {
  console.log("\n23. restore while another session snapshots");
  const d = newRepo("applyrace");
  for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}.txt`), `v1 ${i}\n`);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const a = await open(d);
  const b = await open(d);
  const cp1 = await a.snapshot(null, "cp1");
  for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}.txt`), `v2 ${i}\n`);
  const now = await a.snapshot(cp1, "pre");
  const plan = await a.buildPlan(now, cp1);

  // Unlocked, this interleave rewrote the shared index between read-tree and
  // checkout-index and the restore silently wrote back the current content.
  const [res] = await Promise.all([a.apply(plan), b.snapshot(null, "concurrent")]);
  ok(res.errors.length === 0, `apply reported no errors (${res.errors[0] ?? ""})`);
  ok(
    readFileSync(join(d, "f0.txt"), "utf8") === "v1 0\n" &&
      readFileSync(join(d, "f29.txt"), "utf8") === "v1 29\n",
    "restored content is the checkpoint content, not the current content",
  );
}

// ── 24. target's .git/info/exclude is honoured ────────────────────────────
async function testInfoExclude() {
  console.log("\n24. repo-local excludes (.git/info/exclude)");
  const d = newRepo("infoexclude");
  writeFileSync(join(d, ".git", "info", "exclude"), "bigcache/\n");
  mkdirSync(join(d, "bigcache"));
  writeFileSync(join(d, "bigcache", "huge.bin"), "x".repeat(4096));
  writeFileSync(join(d, "bigcache", "pinned.txt"), "pinned v1\n");
  writeFileSync(join(d, "main.c"), "code\n");
  sh(d, "git", ["add", "main.c"]);
  sh(d, "git", ["add", "-f", "bigcache/pinned.txt"]); // tracked despite the exclude
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  await ws.snapshot(null, "cp1");
  const tracked = await ws.repos.get("")!.trackedPaths();
  ok(!tracked.includes("bigcache/huge.bin"), "excluded build cache not swallowed into the store");
  ok(tracked.includes("bigcache/pinned.txt"), "tracked-but-excluded file still captured (delta-seed)");
  ok(tracked.includes("main.c"), "normal file captured");

  // Agent touches a file inside the excluded dir: force-track still wins.
  writeFileSync(join(d, "bigcache", "agent.txt"), "v1\n");
  const cp = await ws.snapshot(null, "cp2", ["bigcache/agent.txt"]);
  writeFileSync(join(d, "bigcache", "agent.txt"), "CLOBBERED\n");
  const now = await ws.snapshot(cp, "pre", ["bigcache/agent.txt"]);
  await ws.apply(await ws.buildPlan(now, cp));
  ok(readFileSync(join(d, "bigcache", "agent.txt"), "utf8") === "v1\n", "agent-touched excluded path restored");
}

// ── 25. capture-rule change invalidates the stat-clean index ────────────────
async function testGuardVersionUpgrade() {
  console.log("\n25. store built under an older attributes guard");
  const d = newRepo("guardver");
  writeFileSync(join(d, ".gitattributes"), "* ident\n");
  writeFileSync(join(d, "f.txt"), "hello $Id: deadbeef $ world\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws1 = await open(d);
  // Rebuild the store the way the pre-`-ident` version left it: old guard,
  // index hashed under it — stat-clean but holding squashed bytes.
  const gitDir = join(ws1.storeDir, "root.git");
  const indexFile = join(ws1.storeDir, "root.index");
  writeFileSync(join(gitDir, "info", "attributes"), "* -text -diff -filter -crlf -working-tree-encoding\n");
  rmSync(indexFile, { force: true });
  execFileSync("git", ["add", "-A"], {
    cwd: d,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_DIR: gitDir,
      GIT_WORK_TREE: d,
      GIT_INDEX_FILE: indexFile,
    },
  });

  // Reopen: init must notice the guard change and drop the poisoned index.
  const ws2 = await Workspace.open(d);
  await ws2.prime();
  const cp = await ws2.snapshot(null, "cp");
  const orig = readFileSync(join(d, "f.txt"));
  writeFileSync(join(d, "f.txt"), "clobbered\n");
  const now = await ws2.snapshot(cp, "pre");
  await ws2.apply(await ws2.buildPlan(now, cp));
  ok(readFileSync(join(d, "f.txt")).equals(orig), "blob hashed under the old guard was re-captured, restore is byte-exact");
}

// ── 26. undo refs do not accumulate ─────────────────────────────────────
async function testUndoRefStable() {
  console.log("\n26. repeated restores keep a bounded undo ref set");
  const d = newRepo("undoref");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  const state = createInitialState();
  state.ws = ws;
  state.outside = new OutsideStore(ws.cwd, ws.storeDir);
  state.sessionId = "sess-undo";
  const snapshot = await ws.snapshot(null, "cp1", [], { ref: { sessionId: "sess-undo", entryId: "e1" } });
  state.head = snapshot;
  const cp = { entryId: "e1", parentEntryId: null, prompt: "p", timestamp: Date.now(), snapshot };
  const priorUndo = { snapshot, timestamp: 1, label: "prior undo" };
  state.undo = priorUndo;
  await ws.setSnapshotRef(snapshot, state.sessionId, "undo");

  writeFileSync(join(d, "a.txt"), "v2\n");
  const cancelled = (await planRestore(state, cp))!;
  ok(state.undo === priorUndo, "building a preview does not replace the prior undo");
  await discardRestorePlan(state, cancelled);
  ok(state.undo === priorUndo, "cancelling a preview preserves the prior undo");
  writeFileSync(join(d, "a.txt"), "v3\n");
  await applyPlan(state, (await planRestore(state, cp))!);

  const out = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/pi/sess-undo/"], {
    env: { ...process.env, GIT_DIR: join(ws.storeDir, "root.git") },
  }).toString();
  const undoRefs = out.split("\n").filter((l) => l.includes("/undo"));
  ok(undoRefs.length === 1, `exactly one undo ref after two restores (${undoRefs.length}: ${undoRefs.join(", ")})`);
}

// ── 27. fresh apply planning replaces stale preview assumptions ─────────────
async function testHeadNotAdvancedOnError() {
  console.log("\n27. fresh apply plan supersedes stale preview shape");
  const d = newRepo("headlie");
  writeFileSync(join(d, "base.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);

  const state = createInitialState();
  state.ws = ws;
  state.outside = new OutsideStore(ws.cwd, ws.storeDir);
  state.sessionId = "s";
  const cp1 = await ws.snapshot(null, "cp1"); // no a/ yet
  mkdirSync(join(d, "a"));
  writeFileSync(join(d, "a", "b"), "x\n");
  const now = await ws.snapshot(cp1, "pre");
  state.head = now;
  const plan = await ws.buildPlan(now, cp1);

  // Sabotage: the delete of a/b will be refused by the symlink-parent guard.
  rmSync(join(d, "a"), { recursive: true, force: true });
  symlinkSync(ROOT, join(d, "a"));
  const res = await applyPlan(state, plan);
  ok(res !== null && res.errors.length === 0, "fresh apply plan safely removes the late leaf symlink");
  ok(existsSync(ROOT), "symlink target outside the worktree survives");
  ok(state.head?.[""] === cp1[""], "head advances to the freshly applied target");
  rmSync(join(d, "a"), { force: true });
}

/** A session wired the way index.ts wires one, minus the extension host. */
async function session(name: string) {
  const d = newRepo(name);
  writeFileSync(join(d, "in.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);
  const state = createInitialState();
  state.ws = ws;
  state.cwd = ws.cwd;
  state.sessionId = "s";
  state.outside = new OutsideStore(ws.cwd, ws.storeDir);
  return { d, ws, state };
}

// ── 28. a file the agent edits outside the project ──────────────────────────
async function testOutsideEdit() {
  console.log("\n28. write/edit to a file outside the project");
  const { state } = await session("outside-edit");

  const ext = join(homedir(), "outside-cfg", "cfg.toml");
  mkdirSync(dirname(ext), { recursive: true });
  writeFileSync(ext, "v1\n");

  const cp1 = await ensureCheckpoint(state, "e1", "p1", Date.now());
  ok(cp1 !== null, "checkpoint taken");

  // What index.ts does in tool_call, before the tool runs.
  state.outside!.touch(ext, state.checkpoints.values());
  writeFileSync(ext, "CLOBBERED\n");

  ok(
    Object.keys(cp1!.outside ?? {}).length === 1,
    "the pre-write baseline was back-filled into the earlier checkpoint",
  );

  const plan = (await planRestore(state, cp1!))!;
  ok(plan.items.some((i) => i.repo === OUTSIDE), "the outside file appears in the plan");

  await applyPlan(state, plan, {});
  ok(readFileSync(ext, "utf8") === "CLOBBERED\n", "not restored without explicit consent");

  const plan2 = (await planRestore(state, cp1!))!;
  const res = await applyPlan(state, plan2, { includeOutside: true });
  ok(res!.errors.length === 0, "apply reported no errors");
  ok(readFileSync(ext, "utf8") === "v1\n", "restored once consented to");
}

// ── 29. a file the agent creates outside the project ────────────────────────
async function testOutsideCreate() {
  console.log("\n29. a file created outside the project");
  const { state } = await session("outside-create");

  const ext = join(homedir(), "outside-new", "made.txt");
  mkdirSync(dirname(ext), { recursive: true });

  const cp1 = await ensureCheckpoint(state, "e1", "p1", Date.now());
  state.outside!.touch(ext, state.checkpoints.values());
  writeFileSync(ext, "new file\n");

  const plan = (await planRestore(state, cp1!))!;
  ok(
    plan.items.some((i) => i.repo === OUTSIDE && i.action === "delete"),
    "absent-at-checkpoint becomes a delete, not a silent no-op",
  );
  await applyPlan(state, plan, { includeOutside: true });
  ok(!existsSync(ext), "the created file is removed by the rewind");
}

// ── 30. what the per-path guard refuses ─────────────────────────────────────
async function testOutsideGuard() {
  console.log("\n30. per-path guard");
  const { d, state } = await session("outside-guard");
  const store = state.outside!;

  // The alias case this whole guard exists for: ~/.Claude Code is a symlink to
  // ~/.pi on the author's machine, so a string check for "~/.pi" would wave
  // the credentials through under the other spelling.
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  symlinkSync(join(homedir(), ".pi"), join(homedir(), ".Claude Code"));
  const aliased = join(homedir(), ".Claude Code", "agent", "auth.json");
  const v1 = checkTrackablePath(aliased, d);
  ok(!v1.ok && v1.reason === "inside ~/.pi", "a symlinked alias of ~/.pi is still ~/.pi");

  const env = join(homedir(), "proj-b", ".env");
  mkdirSync(dirname(env), { recursive: true });
  writeFileSync(env, "TOKEN=1\n");
  const v2 = checkTrackablePath(env, d);
  ok(!v2.ok && v2.reason === "looks like a credential file", ".env is never copied into the store");

  // A symlink is resolved, not skipped: the write lands on the target's inode,
  // so the target is what has to be snapshotted, and restoring it by absolute
  // path never writes *through* a link.
  const target = join(homedir(), "proj-b", "real.txt");
  const link = join(homedir(), "proj-b", "link.txt");
  writeFileSync(target, "v1\n");
  symlinkSync(target, link);
  store.touch(link, state.checkpoints.values());
  ok(store.size === 1, "a symlink is tracked as its target");
  ok(
    Object.keys(store.snapshotTracked())[0] === realpathSync(target),
    "and it is the target's absolute path that is recorded",
  );

  // Which is also what makes the deny list hold: a link is not a way around it.
  mkdirSync(join(homedir(), ".ssh"), { recursive: true });
  writeFileSync(join(homedir(), ".ssh", "config"), "Host *\n");
  const sneaky = join(homedir(), "proj-b", "ssh-config");
  symlinkSync(join(homedir(), ".ssh", "config"), sneaky);
  store.touch(sneaky, state.checkpoints.values());
  ok(store.size === 1, "a symlink into ~/.ssh is refused, not followed");
  ok([...store.refused.values()].includes("inside ~/.ssh"), "and the refusal is declared");

  const broken = join(homedir(), "proj-b", "broken.txt");
  symlinkSync(join(homedir(), "proj-b", "gone.txt"), broken);
  store.touch(broken, state.checkpoints.values());
  ok([...store.refused.values()].includes("symlink"), "a dangling symlink is refused");

  const v3 = checkTrackablePath(join(d, "in.txt"), d);
  ok(!v3.ok && v3.reason === "inside the project", "paths inside the project stay with the shadow repo");
  ok(!store.refused.has(join(d, "in.txt")), "and are not reported as a gap");

  rmSync(join(homedir(), ".Claude Code"), { force: true });
}

// ── 31. regression: an absolute path must never reach forceTrack ────────────
async function testAbsolutePathBreaksCheckpoint() {
  console.log("\n31. absolute pathspec in force-track");
  const { ws } = await session("abs-forcetrack");
  const outside = join(homedir(), "elsewhere.txt");
  writeFileSync(outside, "v1\n");

  let threw = false;
  try {
    await ws.snapshot(null, "cp", [outside]);
  } catch {
    threw = true;
  }
  ok(threw, "git refuses the pathspec, which used to fail the entire checkpoint");
}

// ── 32. a directory with no project in it ─────────────────────────────────
async function testProjectless() {
  console.log("\n32. no project here");
  const d = join(homedir(), "plain-dir");
  mkdirSync(d, { recursive: true });

  const state = createInitialState();
  beginWorkspace(state, d);
  await state.ready;

  ok(state.disabled === "not a project directory", "the directory gate still refuses to stage it");
  ok(state.ws === null, "no shadow repo is created");
  ok(state.outside?.projectless === true, "but the per-file store is live");

  const f = join(d, "notes.md");
  writeFileSync(f, "v1\n");

  const cp1 = await ensureCheckpoint(state, "e1", "p1", Date.now());
  ok(cp1 !== null, "a checkpoint exists with no worktree snapshot behind it");
  ok(Object.keys(cp1!.snapshot).length === 0, "and its shadow snapshot is empty");

  state.outside!.touch(f, state.checkpoints.values());
  writeFileSync(f, "CLOBBERED\n");

  const plan = (await planRestore(state, cp1!))!;
  ok(plan !== null && plan.items.length === 1, "the plan is made of the edited file alone");
  writeFileSync(f, "EDITED DURING CONFIRMATION\n");
  const res = await applyPlan(state, plan, { includeOutside: true });
  ok(res !== null && res.errors.length === 0, "apply reported no errors");
  ok(readFileSync(f, "utf8") === "v1\n", "a file in a non-project directory is restored");
  await applyUndo(state, (await planUndo(state))!);
  ok(readFileSync(f, "utf8") === "EDITED DURING CONFIRMATION\n", "projectless undo restores confirmation-window edits");

  const undone = await applyPlan(state, (await planRestore(state, cp1!))!, {});
  ok(undone !== null, "apply works without a workspace");

  // The deny list is the only guard left here, so it has to hold.
  const key = join(homedir(), ".ssh", "id_rsa");
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, "PRIVATE KEY\n");
  state.outside!.touch(key, state.checkpoints.values());
  ok(
    !Object.keys(state.outside!.snapshotTracked()).some((p) => p.endsWith("id_rsa")),
    "~/.ssh is still refused with no project to be outside of",
  );
}

// ── 33. stores whose project is gone ───────────────────────────────────────
async function testReaper() {
  console.log("\n33. reaping abandoned stores");
  const d = newRepo("reaped");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const store = storeDirFor(realpathSync(d));
  const ws = await open(d);
  ok(existsSync(join(store, ORIGIN_FILE)), "a store records the project it belongs to");
  ok(readFileSync(join(store, ORIGIN_FILE), "utf8").trim() === realpathSync(d), "and records it as a real path");

  const root = join(homedir(), ".pi", "agent", "rewind");
  const old = { root, graceMs: 0 };

  // This is the 44 MB case: primed, never checkpointed, session over.
  let reaped = reapStores(old);
  ok(
    reaped.some((r) => r.store === store.split("/").pop() && r.reason === "no checkpoints"),
    "a primed store with no checkpoint is reclaimed",
  );
  ok(!existsSync(store), "and the objects go with it");

  // A store with a checkpoint survives, project present.
  const ws2 = await open(d);
  await ws2.snapshot(null, "cp", [], { ref: { sessionId: "sess-keep", entryId: "e1" } });
  ok(reapStores(old).length === 0, "a store holding a checkpoint is left alone");
  ok(existsSync(store), "and survives the sweep");

  // Same store, project deleted: now it can never be reached again.
  rmSync(d, { recursive: true, force: true });
  reaped = reapStores(old);
  ok(reaped.some((r) => r.reason === "project no longer exists"), "a deleted project's store is reclaimed");
  ok(!existsSync(store), "even though it held checkpoints");

  // Guards.
  const live = join(root, "a".repeat(16));
  mkdirSync(join(live, "root.git", "refs", "pi", "s"), { recursive: true });
  writeFileSync(join(live, "root.git", "refs", "pi", "s", "e"), "deadbeef\n");
  markOrigin(live, "/nonexistent/project");
  writeFileSync(join(live, "snapshot.lock"), "{}");
  ok(reapStores(old).length === 0, "a fresh lock means a live session: not swept");
  ok(existsSync(live), "even with a project that is gone");

  rmSync(join(live, "snapshot.lock"), { force: true });
  ok(reapStores({ root, graceMs: 60_000 }).length === 0, "a store used within the grace window is not swept");
  ok(reapStores({ root, graceMs: 0, keep: live }).length === 0, "and the current session's own store is never swept");
  ok(reapStores(old).length === 1, "but is swept once it is neither locked, recent, nor ours");

  const foreign = join(root, "not-a-store");
  mkdirSync(foreign, { recursive: true });
  reapStores(old);
  ok(existsSync(foreign), "anything not named like a store is never removed");
}


// ── 34. the status line distinguishes "not yet" from "never" ───────────────
async function testProjectlessUsable() {
  console.log("\n34. off vs. tracking-nothing-yet");
  const home = realpathSync(homedir());
  const fresh = new OutsideStore(home, join(home, ".pi", "agent", "rewind", "x"), { projectless: true });
  ok(fresh.usable && fresh.size === 0, "in ~ nothing is tracked yet, but the next edit would be");
  const ssh = new OutsideStore(join(home, ".ssh"), join(home, ".pi", "agent", "rewind", "y"), { projectless: true });
  ok(!ssh.usable, "in ~/.ssh no edit could ever be tracked: genuinely off");
  const dev = new OutsideStore("/dev", join(home, ".pi", "agent", "rewind", "z"), { projectless: true });
  ok(!dev.usable, "and the absolute deny list counts too");
}


// ── 35. /reload must not silently drop tracked files ───────────────────────
async function testReloadKeepsTracked() {
  console.log("\n35. /reload with files tracked outside a project");
  const d = join(homedir(), "reload-dir");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  const f = join(d, "notes.md");
  writeFileSync(f, "v1\n");

  // Session one: track a file, take a checkpoint, persist the index.
  const s1 = createInitialState();
  s1.sessionId = "sess-reload";
  beginWorkspace(s1, d);
  await s1.ready;
  await ensureCheckpoint(s1, "e1", "p1", Date.now());
  s1.outside!.touch(f, s1.checkpoints.values());
  ok(s1.outside!.size === 1, "a file is tracked before the reload");

  const entries: unknown[] = [];
  const fakePi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
  s1.dirty = true;
  persistIndex(fakePi as never, s1);

  // /reload: pi calls session.reload({ beforeSessionStart }), so the extension
  // is instantiated afresh and session_start fires again over the same session.
  const s2 = createInitialState();
  s2.sessionId = "sess-reload";
  loadIndex(s2, entries);
  beginWorkspace(s2, d);
  await s2.ready;
  ok(s2.checkpoints.size === 1, "checkpoints survive the reload");
  ok(s2.outside!.size === 1, "and so does the set of tracked files");

  // The point of tracking: the *next* checkpoint must still carry the file.
  writeFileSync(f, "v2\n");
  const cp2 = await ensureCheckpoint(s2, "e2", "p2", Date.now());
  ok(Object.keys(cp2?.outside ?? {}).some((p) => p.endsWith("notes.md")), "a checkpoint taken after the reload still covers it");

  writeFileSync(f, "CLOBBERED\n");
  const res = await applyPlan(s2, (await planRestore(s2, cp2!))!, { includeOutside: true });
  ok(res !== null && res.errors.length === 0, "and restoring it reports no errors");
  ok(readFileSync(f, "utf8") === "v2\n", "and puts the pre-edit content back");

  // Adoption re-runs the guard rather than trusting the index: a path the
  // deny list has since grown to cover must not come back through the door.
  const key = join(homedir(), ".ssh", "id_rsa");
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, "PRIVATE KEY\n");
  const forged = [{ type: "custom", customType: (entries[0] as any).customType, data: { version: 3, sessionId: "sess-reload", checkpoints: [{ entryId: "e1", prompt: "p", timestamp: Date.now(), snapshot: {}, outside: { [key]: { kind: "file", sha: "x", mode: 0o600 } } }] } }];
  const s3 = createInitialState();
  s3.sessionId = "sess-reload";
  loadIndex(s3, forged);
  beginWorkspace(s3, d);
  await s3.ready;
  ok(!Object.keys(s3.outside!.snapshotTracked()).some((p) => p.endsWith("id_rsa")), "a denied path in an old index is not adopted");
}

// ── 36. outside undo failure keeps the retry point ──────────────────────────
async function testOutsideUndoFailureKeepsRetry() {
  console.log("\n36. failed outside-file undo keeps its retry point");
  const { state } = await session("outside-undo-failure");
  const parent = join(homedir(), "outside-undo-failure");
  const elsewhere = join(homedir(), "outside-undo-target");
  const ext = join(parent, "cfg.toml");
  mkdirSync(parent, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(ext, "v1\n");

  const cp = await ensureCheckpoint(state, "e1", "p1", Date.now());
  state.outside!.touch(ext, state.checkpoints.values());
  writeFileSync(ext, "v2\n");
  const plan = (await planRestore(state, cp!))!;
  await applyPlan(state, plan, { includeOutside: true });
  ok(readFileSync(ext, "utf8") === "v1\n", "initial restore created an undo point");
  ok(state.undo !== null, "undo point exists before retry sabotage");

  rmSync(parent, { recursive: true, force: true });
  symlinkSync(elsewhere, parent);
  const result = await applyUndo(state);
  ok(result !== null && result.errors.length > 0, "outside undo failure is reported");
  ok(state.undo !== null, "failed outside undo keeps the retry point");
  rmSync(parent, { force: true });
}

// ── 37. a failed git diff is not an empty successful plan ───────────────────
async function testDiffFailureThrows() {
  console.log("\n37. failed shadow diff aborts plan construction");
  const d = newRepo("diff-failure");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  writeFileSync(join(d, "a.txt"), "v2\n");
  const now = await ws.snapshot(before, "cp2");
  let threw = false;
  try {
    await ws.buildPlan(now, { ...before, "": "0".repeat(40) });
  } catch {
    threw = true;
  }
  ok(threw, "git diff failure throws instead of returning an empty plan");

  const state = createInitialState();
  state.ws = ws;
  state.sessionId = "diff-failure-session";
  state.head = now;
  const priorUndo = { snapshot: before, timestamp: 1, label: "prior undo" };
  state.undo = priorUndo;
  await ws.setSnapshotRef(before, state.sessionId, "undo");
  const originalHasSnapshot = ws.hasSnapshot.bind(ws);
  ws.hasSnapshot = async () => true;
  let planThrew = false;
  try {
    await planRestore(state, {
      entryId: "bad",
      parentEntryId: null,
      prompt: "bad target",
      timestamp: Date.now(),
      snapshot: { ...before, "": "0".repeat(40) },
    });
  } catch {
    planThrew = true;
  } finally {
    ws.hasSnapshot = originalHasSnapshot;
  }
  ok(planThrew, "planRestore surfaces the failed diff");
  ok(state.undo === priorUndo, "failed planning preserves the prior undo object");
  const undoRef = execFileSync("git", ["--git-dir", join(ws.storeDir, "root.git"), "rev-parse", "refs/pi/diff-failure-session/undo"]).toString().trim();
  ok(undoRef === before[""], "failed planning preserves the prior undo ref");
}

// ── 38. promised replacements are materialized before destructive swaps ─────
async function testTypeChangePreflight() {
  console.log("\n38. missing replacement leaves confirmed type changes untouched");
  const d = newRepo("type-preflight");
  writeFileSync(join(d, "thing"), "target file\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  rmSync(join(d, "thing"));
  mkdirSync(join(d, "thing"));
  writeFileSync(join(d, "thing", "keep.txt"), "user data\n");
  const now = await ws.snapshot(before, "cp2");
  const plan = await ws.buildPlan(now, before);
  const rootRepo = (ws as any).repos.get("");
  const originalCatBlob = rootRepo.catBlob.bind(rootRepo);
  rootRepo.catBlob = async () => null;
  const result = await ws.apply(plan, { includeTypeChanges: true });
  rootRepo.catBlob = originalCatBlob;
  ok(result.errors.length > 0, "missing project replacement is reported");
  ok(readFileSync(join(d, "thing", "keep.txt"), "utf8") === "user data\n", "project directory survives missing replacement");

  const { state } = await session("outside-type-preflight");
  const ext = join(homedir(), "outside-type-preflight", "thing");
  mkdirSync(dirname(ext), { recursive: true });
  writeFileSync(ext, "target file\n");
  const cp = await ensureCheckpoint(state, "e1", "p1", Date.now());
  state.outside!.touch(ext, state.checkpoints.values());
  rmSync(ext);
  mkdirSync(ext);
  writeFileSync(join(ext, "keep.txt"), "outside user data\n");
  const outsidePlan = (await planRestore(state, cp!))!;
  rmSync((state.outside as any).blobDir, { recursive: true, force: true });
  const outsideResult = await applyPlan(state, outsidePlan, { includeTypeChanges: true, includeOutside: true });
  ok(outsideResult !== null && outsideResult.skipped.some((item) => item.action === "unprotected"), "missing outside replacement is reported as unprotected");
  ok(readFileSync(join(ext, "keep.txt"), "utf8") === "outside user data\n", "outside directory survives missing replacement");
}

// ── 39. multi-repo undo publication rolls back on partial failure ───────────
async function testUndoRefPromotionRollback() {
  console.log("\n39. partial multi-repo undo publication rolls back");
  const d = newRepo("undo-ref-rollback");
  writeFileSync(join(d, "root.txt"), "root v1\n");
  const dep = join(d, "vendor", "dep");
  mkdirSync(dep, { recursive: true });
  sh(dep, "git", ["init", "-q"]);
  sh(dep, "git", ["config", "user.email", "t@t"]);
  sh(dep, "git", ["config", "user.name", "t"]);
  writeFileSync(join(dep, "lib.txt"), "dep v1\n");
  sh(dep, "git", ["add", "-A"]);
  sh(dep, "git", ["commit", "-qm", "i"]);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);

  const ws = await open(d);
  const before = await ws.snapshot(null, "cp1");
  const state = createInitialState();
  state.ws = ws;
  state.outside = new OutsideStore(ws.cwd, ws.storeDir);
  state.head = before;
  state.sessionId = "undo-ref-rollback-session";
  const priorUndo = { snapshot: before, timestamp: 1, label: "prior undo" };
  state.undo = priorUndo;
  await ws.setSnapshotRef(before, state.sessionId, "undo");
  writeFileSync(join(d, "root.txt"), "root v2\n");
  writeFileSync(join(dep, "lib.txt"), "dep v2\n");

  const nestedRepo = (ws as any).repos.get("vendor/dep");
  const originalSetRef = nestedRepo.setRef.bind(nestedRepo);
  nestedRepo.setRef = async (ref: string, commit: string) => {
    if (ref.endsWith("/undo")) throw new Error("injected nested update-ref failure");
    return originalSetRef(ref, commit);
  };
  let threw = false;
  try {
    const plan = await planRestore(state, {
      entryId: "e1",
      parentEntryId: null,
      prompt: "target",
      timestamp: Date.now(),
      snapshot: before,
    });
    await applyPlan(state, plan!);
  } catch {
    threw = true;
  } finally {
    nestedRepo.setRef = originalSetRef;
  }
  ok(threw, "nested ref publication failure is surfaced");
  ok(state.undo === priorUndo, "prior undo object remains published");
  for (const [sub, expected] of Object.entries(before)) {
    const repo = (ws as any).repos.get(sub);
    const actual = execFileSync("git", ["--git-dir", repo.gitDir, "rev-parse", "refs/pi/undo-ref-rollback-session/undo"]).toString().trim();
    ok(actual === expected, `${sub || "root"} undo ref rolled back to the prior snapshot`);
    let pending = true;
    try {
      execFileSync("git", ["--git-dir", repo.gitDir, "show-ref", "--verify", "--quiet", "refs/pi/undo-ref-rollback-session/undo-pending"]);
    } catch {
      pending = false;
    }
    ok(!pending, `${sub || "root"} pending undo ref cleaned after failure`);
  }
}

// ── 40. apply/undo revalidate type changes after preview ─────────────────────
async function testApplyAndUndoTypeRevalidation() {
  console.log("\n40. apply and undo never delete an unconfirmed late directory");
  const d = newRepo("late-type-change");
  const path = join(d, "thing");
  writeFileSync(path, "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws = await open(d);
  const state = createInitialState();
  state.ws = ws;
  state.sessionId = "late-type-change-session";
  state.outside = new OutsideStore(ws.cwd, ws.storeDir);
  const before = await ws.snapshot(null, "cp1");
  state.head = before;
  const cp = { entryId: "e1", parentEntryId: null, prompt: "target", timestamp: Date.now(), snapshot: before };

  writeFileSync(path, "v2\n");
  const latePlan = (await planRestore(state, cp))!;
  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, "keep.txt"), "late user data\n");
  const lateResult = await applyPlan(state, latePlan);
  ok(lateResult !== null && lateResult.skipped.some((item) => item.action === "type-change"), "late file-to-directory change is re-planned and skipped");
  ok(readFileSync(join(path, "keep.txt"), "utf8") === "late user data\n", "bulk checkout leaves unconfirmed directory untouched");

  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, "v2\n");
  const normalPreview = (await planRestore(state, cp))!;
  writeFileSync(path, "v3 during confirmation\n");
  const restored = await applyPlan(state, normalPreview);
  ok(restored !== null && restored.errors.length === 0 && readFileSync(path, "utf8") === "v1\n", "normal restore succeeds and publishes undo");
  const exactUndo = await applyUndo(state, (await planUndo(state))!);
  ok(exactUndo !== null && readFileSync(path, "utf8") === "v3 during confirmation\n", "undo restores same-type edits made during restore confirmation");

  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, "keep.txt"), "post-rewind user data\n");
  const undo = (await planUndo(state))!;
  const undoResult = await applyUndo(state, undo);
  ok(undoResult !== null && undoResult.skipped.some((item) => item.action === "type-change"), "undo skips unconfirmed late type change");
  ok(readFileSync(join(path, "keep.txt"), "utf8") === "post-rewind user data\n", "undo leaves new directory contents untouched");
  ok(state.undo !== null, "incomplete undo remains available for explicit confirmation");
}

// ── 41. missing nested repos do not invalidate the root checkpoint ──────────
async function testMissingNestedKeepsRootRestorable() {
  console.log("\n41. deleted nested repo leaves root checkpoint partially restorable");
  const d = newRepo("missing-nested");
  writeFileSync(join(d, "root.txt"), "root v1\n");
  const dep = join(d, "vendor", "dep");
  mkdirSync(dep, { recursive: true });
  sh(dep, "git", ["init", "-q"]);
  sh(dep, "git", ["config", "user.email", "t@t"]);
  sh(dep, "git", ["config", "user.name", "t"]);
  writeFileSync(join(dep, "lib.txt"), "dep v1\n");
  sh(dep, "git", ["add", "-A"]);
  sh(dep, "git", ["commit", "-qm", "i"]);
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const ws1 = await open(d);
  const checkpoint = await ws1.snapshot(null, "cp1");
  writeFileSync(join(d, "root.txt"), "root v2\n");
  rmSync(dep, { recursive: true, force: true });

  const ws2 = await open(d);
  ok(await ws2.hasSnapshot(checkpoint), "checkpoint remains valid for repos still present");
  const now = await ws2.snapshot(null, "current");
  const plan = await ws2.buildPlan(now, checkpoint);
  ok(plan.items.some((item) => item.action === "unprotected" && item.display === "vendor/dep"), "missing nested component is declared unprotected");
  const result = await ws2.apply(plan);
  ok(result.errors.length === 0 && readFileSync(join(d, "root.txt"), "utf8") === "root v1\n", "root file restores despite missing nested repo");
}

// ── 42. persisted outside state is schema/path/hash validated ────────────────
async function testPersistedOutsideValidation() {
  console.log("\n42. persisted outside state cannot bypass path or blob guards");
  const d = join(homedir(), "persisted-validation");
  mkdirSync(d, { recursive: true });
  const denied = join(homedir(), ".ssh", "id_rsa");
  const safe = join(d, "safe.txt");
  const arbitraryDelete = join(d, "delete-me.txt");
  writeFileSync(arbitraryDelete, "must survive\n");
  const forged = [{
    type: "custom",
    customType: "pi-rewind-cp",
    data: {
      checkpoints: [{
        entryId: "e1",
        parentEntryId: null,
        prompt: "forged",
        timestamp: Date.now(),
        snapshot: {},
        outside: {
          [denied]: { absent: true },
          [safe]: { sha: "../../outside-file", mode: 0o600 },
          [arbitraryDelete]: { absent: true },
        },
      }],
    },
  }];
  const state = createInitialState();
  loadIndex(state, forged);
  beginWorkspace(state, d);
  await state.ready;
  const cp = state.checkpoints.get("e1")!;
  ok(Object.keys(cp.outside ?? {}).length === 0, "denied, malformed, and unregistered paths are removed on adoption");
  ok(readFileSync(arbitraryDelete, "utf8") === "must survive\n", "forged absent entry cannot request an arbitrary delete");
  const store = state.outside!;
  ok((store as any).readBlob("../../outside-file") === null, "blob reader rejects traversal-shaped sha");
}

// ── 43. reload restores current shadow ancestry from the active branch ──────
async function testRestorePosition() {
  console.log("\n43. reload restores head/current entry from active branch");
  const state = createInitialState();
  const snapshot = { "": "a".repeat(40) };
  state.checkpoints.set("u1", { entryId: "u1", parentEntryId: null, prompt: "p", timestamp: 1, snapshot });
  restorePosition(state, [
    { id: "u1", type: "message", message: { role: "user" } },
    { id: "a1", type: "message", message: { role: "assistant" } },
  ]);
  ok(state.currentEntryId === "u1", "active user checkpoint restored as current entry");
  ok(state.head === snapshot, "active user checkpoint restored as shadow head");
}

// ── 44. concurrent workspace initialization uses the store lock ─────────────
async function testConcurrentInitialization() {
  console.log("\n44. concurrent workspace initialization is serialized");
  const d = newRepo("concurrent-init");
  writeFileSync(join(d, "a.txt"), "v1\n");
  sh(d, "git", ["add", "-A"]);
  sh(d, "git", ["commit", "-qm", "i"]);
  const [first, second] = await Promise.all([Workspace.open(d), Workspace.open(d)]);
  await Promise.all([first.prime(), second.prime()]);
  const [one, two] = await Promise.all([first.snapshot(null, "one"), second.snapshot(null, "two")]);
  ok(Boolean(one[""] && two[""]), "both concurrently initialized workspaces produce valid snapshots");
}

// ── 45. outside registry merges long-lived session writers ──────────────────
async function testOutsideRegistryMerge() {
  console.log("\n45. outside path registry merges concurrent-session knowledge");
  const d = newRepo("outside-registry-merge");
  const storeDir = storeDirFor(realpathSync(d));
  const first = new OutsideStore(d, storeDir);
  const second = new OutsideStore(d, storeDir);
  const one = join(homedir(), "outside-registry-one.txt");
  const two = join(homedir(), "outside-registry-two.txt");
  writeFileSync(one, "one\n");
  writeFileSync(two, "two\n");
  first.touch(one, []);
  second.touch(two, []);
  const reloaded = new OutsideStore(d, storeDir);
  reloaded.adopt([one, two]);
  ok(reloaded.size === 2, "stale in-memory writers preserve the union of registered paths");
}

// ── run ─────────────────────────────────────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

await testRoundTrip();
await testTrackedButIgnored();
await testForceTrack();
await testHardlink();
await testSymlink();
await testTypeChange();
await testNested();
await testCaseCollision();
await testByteExact();
await testWarmReopen();
await testConcurrency();
await testFailureSurfacing();
await testMaintenance();
await testReadyBudget();
await testIdent();
await testStageFailureSurfaced();
await testSubmoduleReseed();
await testSymlinkParentGuard();
await testMidSessionNestedRepo();
await testLockSteal();
await testGcGrace();
await testRefInsideSnapshot();
await testApplySnapshotSerialised();
await testInfoExclude();
await testGuardVersionUpgrade();
await testUndoRefStable();
await testHeadNotAdvancedOnError();
await testOutsideEdit();
await testOutsideCreate();
await testOutsideGuard();
await testAbsolutePathBreaksCheckpoint();
await testProjectless();
await testReaper();
await testProjectlessUsable();
await testReloadKeepsTracked();
await testOutsideUndoFailureKeepsRetry();
await testDiffFailureThrows();
await testTypeChangePreflight();
await testUndoRefPromotionRollback();
await testApplyAndUndoTypeRevalidation();
await testMissingNestedKeepsRootRestorable();
await testPersistedOutsideValidation();
await testRestorePosition();
await testConcurrentInitialization();
await testOutsideRegistryMerge();

console.log(`\n${"─".repeat(60)}\n${passed} passed, ${failed} failed\n`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
