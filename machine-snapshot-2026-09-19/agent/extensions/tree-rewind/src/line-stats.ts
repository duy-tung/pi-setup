import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readBoundedRegular } from "./storage.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMETIC_ENV, runGit } from "./git.js";
import type { PlanItem, RestorePlan } from "./types.js";

/**
 * Line counts for a restore preview: `+added −removed` per file, the way the
 * reader would see it after applying the plan (current → target).
 *
 * The shadow repos declare `* -diff` so capture never mangles content, which
 * also makes `git diff --numstat` inside them report every file as binary.
 * So the counts come from `git diff --no-index` over a throwaway pair of
 * directories instead: one spawn for the whole plan, no attributes involved,
 * and git's own binary/text heuristics apply.
 */
export type LineStat =
  | { kind: "lines"; added: number; removed: number }
  | { kind: "binary" }
  | { kind: "large" }
  | { kind: "unknown" };

/** Keyed by `statKey(item)`, not by display: a project file literally named
 *  `~/x` and an outside file displayed as `~/x` are different items. */
export type LineStats = Map<string, LineStat>;

export const statKey = (item: PlanItem): string => `${item.repo}\0${item.path}`;

/** Per-side cap: the preview must stay cheap even for a huge generated file. */
export const MAX_STAT_BYTES = 1024 * 1024;

/** `"large"` is decided from the size before any content is read, so the cap
 *  bounds allocation, not just what gets diffed. */
export type Side = Buffer | null | "large";

export interface StatSource {
  /** Bytes on disk now; null if absent or not a regular file. Throw on a read
   *  error: an unreadable file must not be counted as an addition. */
  current: (item: PlanItem, maxBytes: number) => Side;
  /** Bytes the plan would write; null if the blob is missing. */
  target: (item: PlanItem, maxBytes: number) => Promise<Side> | Side;
}

/** Items a line count can describe. Symlink targets store link text, not
 *  content, so they are counted as "uncounted" in totals, never as lines. */
export const countable = (item: PlanItem): boolean =>
  item.action === "restore" || item.action === "delete";
export const statable = (item: PlanItem): boolean =>
  countable(item) && item.targetMode !== "120000";

/** Never throws: a preview without numbers is still a preview. An item gets a
 *  `lines` entry only once its bytes are in place and git has looked at them. */
export async function lineStats(
  plan: RestorePlan,
  source: StatSource,
  limit = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Promise<LineStats> {
  const out: LineStats = new Map();
  const items = plan.items.filter(statable).slice(0, limit);
  if (!items.length) return out;

  let dir: string | null = null;
  try {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rewind-stat-")));
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);

    const staged = new Map<string, PlanItem>();
    for (const [index, item] of items.entries()) {
      if (signal?.aborted) return out;
      const name = String(index);
      try {
        const cur = source.current(item, MAX_STAT_BYTES);
        const tgt: Side = item.action === "delete" ? null : await source.target(item, MAX_STAT_BYTES);
        if (item.action === "restore" && tgt === null) {
          out.set(statKey(item), { kind: "unknown" });
          continue;
        }
        if (cur === "large" || tgt === "large" || (cur?.length ?? 0) > MAX_STAT_BYTES || (tgt?.length ?? 0) > MAX_STAT_BYTES) {
          out.set(statKey(item), { kind: "large" });
          continue;
        }
        if (cur) writeFileSync(join(a, name), cur);
        if (tgt) writeFileSync(join(b, name), tgt);
        staged.set(name, item);
      } catch {
        // A half-staged pair must not stay behind: git would otherwise diff
        // the leftover side against some other item's file.
        rmSync(join(a, name), { force: true });
        rmSync(join(b, name), { force: true });
        out.set(statKey(item), { kind: "unknown" });
      }
    }
    if (!staged.size) return out;

    // `--no-renames`: git would otherwise pair a deleted file with an added
    // one of the same content and report both as ±0 under a single name.
    // Relative paths from the temp dir: with absolute paths git maps them
    // onto any repository that happens to contain the temp dir and applies
    // that repository's `.gitattributes` to the count (measured).
    const r = await runGit(["diff", "--no-index", "--no-renames", "--numstat", "-z", "--", "a", "b"], noIndexEnv(dir), { cwd: dir, signal });
    // 0 = identical, 1 = differences; anything else is a real failure.
    if (r.code !== 0 && r.code !== 1) {
      for (const item of staged.values()) out.set(statKey(item), { kind: "unknown" });
      return out;
    }
    // Identical bytes (mode-only or hardlink writer) print nothing: ±0.
    for (const item of staged.values()) out.set(statKey(item), { kind: "lines", added: 0, removed: 0 });
    for (const rec of parseNumstat(r.stdout.toString("utf8"))) {
      const item = staged.get(rec.name);
      if (!item) continue;
      out.set(statKey(item), rec.binary ? { kind: "binary" } : { kind: "lines", added: rec.added, removed: rec.removed });
    }
    return out;
  } catch {
    return out;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** No repo is involved, so nothing inherited from the shell may steer git:
 *  repo pointers, and command-scope config (`GIT_CONFIG_PARAMETERS`,
 *  `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`) which the hermetic set does not cover. */
export function noIndexEnv(tempDir?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_INDEX_FILE" || k === "GIT_COMMON_DIR" || k === "GIT_NAMESPACE") continue;
    if (k.startsWith("GIT_CONFIG_") || k === "GIT_ATTR_SOURCE" || k === "GIT_CEILING_DIRECTORIES" || k === "GIT_EXTERNAL_DIFF") continue;
    env[k] = v;
  }
  // If the temp dir sits under some repository (TMPDIR inside a project), git
  // would discover it and apply its `.gitattributes` to the count. Pointing
  // GIT_DIR at a path that does not exist disables discovery entirely;
  // `--no-index` does not need a repository.
  return { ...env, ...HERMETIC_ENV, ...(tempDir ? { GIT_DIR: join(tempDir, "no-repository") } : {}) };
}

/** `-z` numstat with `--no-index` prints `added\tremoved\t\0src\0dst\0` per
 *  file, one path being `/dev/null` for creations and deletions. */
export function parseNumstat(raw: string): { name: string; added: number; removed: number; binary: boolean }[] {
  const parts = raw.split("\0");
  const out: { name: string; added: number; removed: number; binary: boolean }[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const m = /^(\d+|-)\t(\d+|-)\t$/.exec(parts[i]);
    if (!m) { i -= 2; continue; }
    const src = parts[i + 1];
    const dst = parts[i + 2];
    const path = dst !== "/dev/null" ? dst : src;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const binary = m[1] === "-" || m[2] === "-";
    out.push({ name, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

export function formatStat(stat: LineStat | undefined): string {
  if (!stat) return "";
  switch (stat.kind) {
    case "lines": {
      const bits: string[] = [];
      if (stat.added) bits.push(`+${stat.added}`);
      if (stat.removed) bits.push(`−${stat.removed}`);
      return bits.length ? bits.join(" ") : "±0";
    }
    case "binary": return "(binary)";
    case "large": return "(large)";
    case "unknown": return "(size unknown)";
  }
}

export function totalStat(stats: LineStats): { added: number; removed: number; counted: number; other: number } {
  let added = 0, removed = 0, counted = 0, other = 0;
  for (const s of stats.values()) {
    if (s.kind === "lines") { added += s.added; removed += s.removed; counted++; }
    else other++;
  }
  return { added, removed, counted, other };
}

/** Current bytes for the preview. Absent (or not a regular file) is null; an
 *  oversized file is `"large"` without being read; any other failure throws so
 *  the caller records "unknown" rather than treating the file as empty. */
export function readRegular(path: string, maxBytes = MAX_STAT_BYTES): Side {
  return readBoundedRegular(path, maxBytes);
}
