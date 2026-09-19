import { OUTSIDE, type PlanItem, type RestorePlan } from "./types.js";
import { countable, formatStat, statKey, totalStat, type LineStats } from "./line-stats.js";

/** Outside the project is the one distinction worth repeating on every line:
 *  the reader is deciding about files that are not theirs to lose. */
export const isOutsideItem = (i: PlanItem): boolean => i.repo === OUTSIDE;

export function outsideItems(plan: RestorePlan): PlanItem[] {
  return plan.items.filter((i) => isOutsideItem(i) && i.action !== "unprotected");
}

export function group(plan: RestorePlan): Record<PlanItem["action"], PlanItem[]> {
  const g: Record<PlanItem["action"], PlanItem[]> = {
    restore: [],
    delete: [],
    "type-change": [],
    unprotected: [],
  };
  for (const item of plan.items) g[item.action].push(item);
  return g;
}

export function isEmpty(plan: RestorePlan): boolean {
  return plan.items.every((i) => i.action === "unprotected");
}

/** Anything that could destroy data the snapshot does not describe. */
export function needsConfirmation(plan: RestorePlan): boolean {
  return plan.items.some((i) => i.action === "type-change");
}

export const MAX_LINES = 40;

/** `stats` is optional: a preview without numbers is still a preview. Each
 *  line reads current → target, so `+` is what applying the plan adds. */
export function formatPlan(plan: RestorePlan, stats?: LineStats): string {
  const g = group(plan);
  const lines: string[] = [];

  const tag = (i: PlanItem): string =>
    isOutsideItem(i) ? "   (outside the project)" : i.writer === "in-place" ? "   (in place: hardlinked)" : "";
  const width = Math.min(48, Math.max(0, ...[...g.restore, ...g.delete].map((i) => i.display.length)));
  const stat = (i: PlanItem): string => {
    const s = formatStat(stats?.get(statKey(i)));
    return s ? `${" ".repeat(Math.max(1, width - i.display.length + 3))}${s}` : "";
  };

  for (const i of g.restore) lines.push(`  restore   ${i.display}${stat(i)}${tag(i)}`);
  for (const i of g.delete) lines.push(`  delete    ${i.display}${stat(i)}${tag(i)}`);
  for (const i of g["type-change"]) lines.push(`  REPLACE   ${i.display}   ${i.reason ?? ""}${tag(i)}`);
  for (const i of g.unprotected) lines.push(`  skip      ${i.display}   (${i.reason ?? "not protected"})`);

  if (!lines.length) return "(no file changes)";

  const head = lines.slice(0, MAX_LINES).join("\n");
  const rest = lines.length - MAX_LINES;
  return rest > 0 ? `${head}\n  … ${rest} more` : head;
}

export function summarise(plan: RestorePlan, stats?: LineStats): string {
  const g = group(plan);
  const bits: string[] = [];
  if (g.restore.length) bits.push(`${g.restore.length} restore`);
  if (g.delete.length) bits.push(`${g.delete.length} delete`);
  if (g["type-change"].length) bits.push(`${g["type-change"].length} replace`);
  if (g.unprotected.length) bits.push(`${g.unprotected.length} unprotected`);
  const outside = outsideItems(plan).length;
  if (outside) bits.push(`${outside} outside`);
  const head = bits.length ? bits.join(", ") : "no changes";
  return stats?.size ? `${head} · ${formatTotal(plan, stats)}` : head;
}

/** `+A −R` over the files that have counts; the rest are named so a total
 *  never quietly stands for fewer files than the list shows. */
export function formatTotal(plan: RestorePlan, stats: LineStats): string {
  const t = totalStat(stats);
  const uncounted = t.other + Math.max(0, plan.items.filter(countable).length - stats.size);
  const lines = t.counted ? `+${t.added} −${t.removed}` : "";
  const other = uncounted ? `${uncounted} uncounted` : "";
  return [lines, other].filter(Boolean).join(", ");
}
