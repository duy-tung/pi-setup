/**
 * End-to-end cost of the real v0.3 code path on a large repo, to confirm the
 * spike numbers survive contact with the actual Workspace implementation.
 *
 *   node --import ./spike/register.mjs spike/perf-test.mts <repo>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "../src/workspace.js";
import { summarise } from "../src/plan.js";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: perf-test.mts <repo>");
  process.exit(1);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const v = await fn();
  console.log(`  ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${label}`);
  return v;
}

const ws = await timed("Workspace.open", () => Workspace.open(repo));
await timed("prime (cold: stage + nested discovery + coverage scan)", () => ws.prime());
console.log(
  `           repos: 1 root + ${ws.coverage.nestedCount} nested · ` +
    `${ws.coverage.unrepresentable.length} unrepresentable · case-${ws.coverage.caseInsensitive ? "in" : ""}sensitive`,
);

const cp1 = await timed("checkpoint #1", () => ws.snapshot(null, "cp1"));

// A realistic agent turn: edit three tracked files.
const tracked = (await ws.repos.get("")!.trackedPaths())
  .filter((p) => /\.(ts|c|h|go|js|md)$/.test(p))
  .slice(0, 3);
const originals = tracked.map((p) => readFileSync(join(repo, p)));
tracked.forEach((p) => writeFileSync(join(repo, p), Buffer.concat([readFileSync(join(repo, p)), Buffer.from("\n// edit\n")])));

const cp2 = await timed(`checkpoint #2 (${tracked.length} files edited)`, () => ws.snapshot(cp1, "cp2"));
const plan = await timed("buildPlan (rewind cp2 → cp1)", () => ws.buildPlan(cp2, cp1));
console.log(`           plan: ${summarise(plan)}`);
const res = await timed("apply", () => ws.apply(plan));
console.log(`           applied: ${res.restored} restored, ${res.deleted} deleted, ${res.errors.length} errors`);

const okAll = tracked.every((p, i) => readFileSync(join(repo, p)).equals(originals[i]));
console.log(`\n  ${okAll ? "✓" : "✗"} all ${tracked.length} edited files restored byte-exact`);
tracked.forEach((p, i) => writeFileSync(join(repo, p), originals[i]));
