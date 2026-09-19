/** `+/−` preview counts: numstat parsing, bounds, failure handling, and the plan/summary rendering. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStat, lineStats, MAX_STAT_BYTES, noIndexEnv, parseNumstat, readRegular, statKey } from "../src/line-stats.js";
import { formatPlan, summarise } from "../src/plan.js";
import { OUTSIDE, type PlanItem, type RestorePlan } from "../src/types.js";

// --- parser: the exact `-z --no-index` shape, including binary and /dev/null sides
const raw = "2\t1\t\0a/0\0b/0\0" + "0\t2\t\0a/1\0/dev/null\0" + "1\t0\t\0/dev/null\0b/2\0" + "-\t-\t\0a/3\0b/3\0";
assert.deepEqual(parseNumstat(raw), [
  { name: "0", added: 2, removed: 1, binary: false },
  { name: "1", added: 0, removed: 2, binary: false },
  { name: "2", added: 1, removed: 0, binary: false },
  { name: "3", added: 0, removed: 0, binary: true },
]);
assert.deepEqual(parseNumstat(""), []);

// --- env: repo pointers and command-scope config never reach the --no-index call
const env = noIndexEnv({ PATH: "/bin", GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_CONFIG_PARAMETERS: "'core.bigFileThreshold=1'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bigFileThreshold", GIT_CONFIG_VALUE_0: "1" });
assert.equal(env.PATH, "/bin");
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) assert.equal(env[k], undefined, k);
assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");

// --- end to end against real git, with every item kind the preview can show
const dir = mkdtempSync(join(tmpdir(), "pi-rewind-stat-test-"));
try {
  const on = (name: string, body: string | Buffer) => { writeFileSync(join(dir, name), body); };
  on("edit.ts", "a\nb\nc\n");
  on("gone.ts", "x\ny\n");
  on("same.ts", "keep\n");
  on("bin.dat", Buffer.from([0, 1, 2, 3]));
  on("big.txt", "x".repeat(MAX_STAT_BYTES + 1));
  on("secret.ts", "hidden\n");
  chmodSync(join(dir, "secret.ts"), 0o000);
  symlinkSync("edit.ts", join(dir, "link"));

  const item = (display: string, action: PlanItem["action"], extra: Partial<PlanItem> = {}): PlanItem =>
    ({ repo: "", path: display, display, action, targetSha: "t", ...extra });
  const plan: RestorePlan = {
    from: {}, to: {},
    items: [
      item("edit.ts", "restore"),
      item("gone.ts", "delete"),
      item("new.ts", "restore"),
      item("same.ts", "restore", { writer: "in-place" }),
      item("bin.dat", "restore"),
      item("big.txt", "restore"),
      item("big-target.txt", "restore"),
      item("secret.ts", "restore"),
      item("link", "restore", { targetMode: "120000" }),
      item("missing-blob.ts", "restore"),
      item("dir/", "type-change", { reason: "directory with 3 file(s) → file" }),
      // Same display text as a project file: must not share a stats entry.
      item("~/elsewhere/edit.ts", "restore"),
      { repo: OUTSIDE, path: join(dir, "edit.ts"), display: "~/elsewhere/edit.ts", action: "restore", targetSha: "t" },
      item("skipped.ts", "unprotected", { reason: "not protected" }),
    ],
  };
  const targets: Record<string, Buffer | null | "large"> = {
    "edit.ts": Buffer.from("a\nX\nc\nd\n"),
    "new.ts": Buffer.from("fresh\n"),
    "same.ts": Buffer.from("keep\n"),
    "bin.dat": Buffer.from([0, 9, 9, 9, 9]),
    "big.txt": Buffer.from("small\n"),
    "big-target.txt": "large",
    "secret.ts": Buffer.from("x\n"),
    "link": Buffer.from("edit.ts"),
    "missing-blob.ts": null,
    "~/elsewhere/edit.ts": Buffer.from("a\n"),
  };
  const source = {
    current: (i: PlanItem, max: number) => readRegular(i.repo === OUTSIDE ? i.path : join(dir, i.display), max),
    target: (i: PlanItem) => targets[i.display] ?? null,
  };
  const key = (display: string, repo = "") => statKey({ repo, path: display, display, action: "restore" } as PlanItem);
  const outsideKey = statKey(plan.items.find((i) => i.repo === OUTSIDE)!);

  const stats = await lineStats(plan, source);
  assert.deepEqual(stats.get(key("edit.ts")), { kind: "lines", added: 2, removed: 1 });
  assert.deepEqual(stats.get(key("gone.ts")), { kind: "lines", added: 0, removed: 2 });
  assert.deepEqual(stats.get(key("new.ts")), { kind: "lines", added: 1, removed: 0 });
  assert.deepEqual(stats.get(key("same.ts")), { kind: "lines", added: 0, removed: 0 }, "identical bytes count as ±0, not unknown");
  assert.deepEqual(stats.get(key("bin.dat")), { kind: "binary" });
  assert.deepEqual(stats.get(key("big.txt")), { kind: "large" }, "oversized current side is refused by size, before reading");
  assert.deepEqual(stats.get(key("big-target.txt")), { kind: "large" }, "oversized target side is refused by the source");
  if (process.getuid?.() !== 0) assert.deepEqual(stats.get(key("secret.ts")), { kind: "unknown" }, "unreadable is unknown, never an addition");
  assert.equal(stats.has(key("link")), false, "symlink targets are never counted");
  assert.deepEqual(stats.get(key("missing-blob.ts")), { kind: "unknown" });
  assert.equal(stats.has(key("dir/")), false, "type changes are a separate decision, not a line count");
  assert.equal(stats.has(key("skipped.ts")), false);
  assert.deepEqual(stats.get(key("~/elsewhere/edit.ts")), { kind: "lines", added: 1, removed: 0 }, "project file named ~/…: absent on disk, so the restore is an addition");
  assert.deepEqual(stats.get(outsideKey), { kind: "lines", added: 0, removed: 2 }, "outside item with the same display text keeps its own entry");

  // --- rendering
  assert.equal(formatStat(stats.get(key("edit.ts"))), "+2 −1");
  assert.equal(formatStat(stats.get(key("same.ts"))), "±0");
  assert.equal(formatStat(undefined), "");

  const text = formatPlan(plan, stats);
  assert.match(text, /^  restore   edit\.ts +\+2 −1$/m);
  assert.match(text, /^  restore   same\.ts +±0   \(in place: hardlinked\)$/m);
  assert.match(text, /^  restore   bin\.dat +\(binary\)$/m);
  assert.match(text, /^  restore   big-target\.txt +\(large\)$/m);
  assert.match(text, /^  restore   link$/m, "no stat column for a symlink");
  assert.match(text, /^  delete    gone\.ts +−2$/m);
  assert.match(text, /^  restore   ~\/elsewhere\/edit\.ts +\+1$/m);
  assert.match(text, /^  restore   ~\/elsewhere\/edit\.ts +−2   \(outside the project\)$/m);
  assert.match(text, /^  REPLACE   dir\/ /m);
  assert.equal(formatPlan(plan), text.replace(/ +(\+\d+ −\d+|[+−]\d+|±0|\(binary\)|\(large\)|\(size unknown\))/g, ""), "stats are purely additive to the existing preview");

  // Counted: edit +2−1, gone −2, new +1, same ±0, ~/… +1, outside −2 → +4 −5.
  // Uncounted: bin, big, big-target, secret, missing (5 entries) + link (never counted) = 6.
  const uncounted = process.getuid?.() === 0 ? 5 : 6;
  assert.equal(summarise(plan, stats), `11 restore, 1 delete, 1 replace, 1 unprotected, 1 outside · +4 −5, ${uncounted} uncounted`);
  assert.equal(summarise(plan), "11 restore, 1 delete, 1 replace, 1 unprotected, 1 outside");

  // --- bound: items past the limit are neither counted nor silently dropped from the total
  const limited = await lineStats(plan, source, 2);
  assert.equal(limited.size, 2);
  assert.match(summarise(plan, limited), /, 10 uncounted$/);

  // --- a broken source never breaks the preview, and never invents ±0
  const broken = await lineStats(plan, { current: () => { throw new Error("boom"); }, target: () => null });
  assert.equal(broken.get(key("edit.ts"))?.kind, "unknown");
  assert.equal(broken.get(key("gone.ts"))?.kind, "unknown");
  assert.ok([...broken.values()].every((s) => s.kind === "unknown"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("PASS line stats: numstat parse, env sanitising, +/− per file, binary/large/unreadable/symlink/missing handling, key collisions, summary totals, bound, failure tolerance");
