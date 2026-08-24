import type { RewindState } from "./state.js";

const STATUS_KEY = "rewind";

/** Coverage is always shown, never implied. A checkpoint that quietly skips
 *  files is worse than one that says which files it skips. */
export function updateStatus(state: RewindState, ctx: any): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;

  // Off by policy is dim, not a warning: nothing went wrong and there is nothing
  // to act on. A broken workspace in a directory that should have worked is the
  // only case that earns the warning colour.
  //
  // Refusing to *stage* the directory is not refusing to protect anything, and
  // the line has to say which one happened. Reporting "off" for a store that
  // had simply not been written to yet was wrong in the direction that costs
  // the user something: it invites them to go and arrange protection that is
  // already there.
  //
  // Which of the three states earns pixels is a separate question from which
  // is true. Silence carries "per-file rewind, nothing edited yet" perfectly
  // well, and it is the state you are in every time you start pi outside a
  // project — a permanent caption on the normal case is noise. So the line
  // appears only once it has a number to report, or once there is nothing to
  // report ever.
  if (state.disabled) {
    const store = state.outside;
    const n = store?.size ?? 0;
    if (!store?.usable) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `◆ rewind off (${state.disabled})`));
    } else if (n) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `◆ ${n} file${n === 1 ? "" : "s"} tracked`));
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    return;
  }
  if (state.readyError) {
    ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `◆ rewind off (${state.readyError})`));
    return;
  }
  if (!state.ws) {
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "◆ ") + theme.fg("muted", "indexing…"));
    return;
  }

  const n = state.checkpoints.size;
  const parts = [`${n} checkpoint${n === 1 ? "" : "s"}`];

  const cov = state.ws.coverage;
  if (cov.nestedCount) parts.push(`${cov.nestedCount} nested`);
  if (state.outside?.size) parts.push(`${state.outside.size} outside`);

  const gaps: string[] = [];
  if (cov.unrepresentable.length) gaps.push(`${cov.unrepresentable.length} case-collision`);
  if (cov.skippedNested.length) gaps.push(`${cov.skippedNested.length} nested skipped`);
  // Not a gap in the warning sense — it is a deliberate default — but it does
  // mean files on disk are outside the checkpoint, so it belongs on the line.
  if (cov.defaultExcluded.length) parts.push("build output excluded");

  const text =
    theme.fg("dim", "◆ ") +
    theme.fg("muted", parts.join(" · ")) +
    (gaps.length ? theme.fg("warning", `  ⚠ ${gaps.join(", ")} unprotected`) : "") +
    (state.lastGap ? theme.fg("warning", `  ⚠ ${state.lastGap}`) : "");
  ctx.ui.setStatus(STATUS_KEY, text);
}

export function clearStatus(ctx: any): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
