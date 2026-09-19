import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCurrentSession, type RewindState } from "./state.js";
import type { ApplyResult, PromptCheckpoint, RestoreMode, RestorePlan } from "./types.js";
import { applySucceeded } from "./apply-result.js";
import { applyPlan, applyUndo, discardRestorePlan, pickCheckpointForEntry, planRestore, planUndo, projectModeChangeCount, projectModeMapChangeCount, waitReady } from "./checkpoints.js";
import { formatPlan, formatTotal, group, isEmpty, isOutsideItem, needsConfirmation, outsideItems, summarise } from "./plan.js";
import { countable, lineStats, readRegular, type LineStats } from "./line-stats.js";
import { join } from "node:path";
import { runBackend } from "./backend-lifetime.js";

function flowGuard(state: RewindState): () => boolean {
  const generation = state.gen, lifetime = state.lifetime;
  return () => state.gen === generation && state.lifetime === lifetime && !lifetime?.closed;
}

/** Code options exist only for prompts that have a checkpoint, as in Claude
 *  Code's menu: offering a restore that ends in "no checkpoint" is noise. */
const ACTIONS: { label: string; value: RestoreMode; needsCheckpoint?: boolean }[] = [
  { label: "Restore code and conversation", value: "all", needsCheckpoint: true },
  { label: "Restore conversation only", value: "conversation" },
  { label: "Restore code only", value: "files", needsCheckpoint: true },
  { label: "Compact, focusing on this prompt", value: "compact-focus" },
  { label: "Cancel", value: "cancel" },
];

/** Files past this many are applied but not counted; the preview says so. */
const MAX_STAT_ITEMS = 200;

const UNDO_LABEL = "↩ Undo last rewind";

function userText(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

function formatTime(ts: number | string): string {
  const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  if (Number.isNaN(d.getTime())) return "??:??:??";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
}

function listUserPrompts(state: RewindState, ctx: any) {
  const branch = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  const out: { id: string; label: string; text: string }[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = userText(entry);
    if (!text.trim()) continue;
    const ts = entry.message.timestamp ?? Date.parse(entry.timestamp);
    const mark = state.checkpoints.has(entry.id) ? "⏺" : " ";
    out.push({ id: entry.id, text, label: `${mark} ${formatTime(ts)}  ${truncate(text, 68)}` });
  }
  return out.reverse();
}

export function reportApply(ctx: any, result: ApplyResult | null, plan?: RestorePlan, stats?: LineStats): void {
  if (!result) {
    ctx.ui.notify("Rewind unavailable (no workspace)", "warning");
    return;
  }
  const bits: string[] = [];
  if (result.restored) bits.push(`${result.restored} restored`);
  if (result.deleted) bits.push(`${result.deleted} deleted`);
  // Equal file counts do not prove equal paths or bytes. Keep these explicitly
  // labelled as preview estimates, never measured results of the locked apply.
  const previewed = plan?.items.filter(countable).length ?? 0;
  if (plan && stats?.size && !result.skipped.length && !result.errors.length && result.restored + result.deleted === previewed) {
    bits.push(`preview estimate: ${formatTotal(plan, stats)}`);
  }
  const base = bits.length ? bits.join(", ") : "nothing to change";

  if (result.errors.length) {
    ctx.ui.notify(`${base}; ${result.errors.length} error(s): ${result.errors[0]}`, "error");
  } else if (result.skipped.length) {
    ctx.ui.notify(`${base}; ${result.skipped.length} skipped (see /rewind preview)`, "warning");
  } else {
    ctx.ui.notify(base, "info");
  }
}

/** `+/−` per file for the preview. Best effort and bounded: it must never
 *  turn a restore that would have worked into one that cannot be previewed. */
async function previewStats(state: RewindState, plan: RestorePlan): Promise<LineStats> {
  const ws = state.ws;
  const cwd = ws?.cwd ?? state.cwd;
  try {
    return await lineStats(plan, {
      current: (item, max) => readRegular(isOutsideItem(item) ? item.path : join(cwd, item.display), max),
      target: (item, max) => (isOutsideItem(item) ? state.outside?.targetBlob(item, max) ?? null : ws?.targetBlob(item, max) ?? null),
    }, MAX_STAT_ITEMS, state.lifetime?.queued.signal);
  } catch {
    return new Map();
  }
}

/**
 * Preview then apply. Type changes can `rm -rf` a directory that the snapshot
 * never described, so they are always a second, explicit decision.
 */
async function restoreBlocked(state: RewindState, ctx: any): Promise<boolean> {
  const alive = flowGuard(state);
  if (!alive()) return true;
  const reason = ctx.isIdle?.() === false
    ? "Wait for the active response to finish before restoring files."
    : await state.restoreBlocker?.();
  if (!alive()) return true;
  if (!reason) return false;
  ctx.ui.notify(reason, "warning");
  return true;
}

async function restoreFiles(state: RewindState, ctx: any, cp: PromptCheckpoint): Promise<boolean> {
  const alive = flowGuard(state);
  try { return await restoreFilesChecked(state, ctx, cp); }
  catch (error) {
    if (alive()) ctx.ui.notify(`File rewind failed: ${(error as Error).message}`, "error");
    return false;
  }
}

async function restoreFilesChecked(state: RewindState, ctx: any, cp: PromptCheckpoint): Promise<boolean> {
  const alive = flowGuard(state);
  if (!alive() || await restoreBlocked(state, ctx) || !alive()) return false;
  // A projectless session has no workspace by design, and its plan is made of
  // outside items only — not a failure to report.
  const ready = await waitReady(state);
  if (!alive()) return false;
  if (!ready && !state.disabled) {
    ctx.ui.notify(state.readyError ?? "Workspace not ready", "warning");
    return false;
  }

  const plan: RestorePlan | null = await runBackend(state.lifetime, () => planRestore(state, cp));
  if (!alive()) return false;
  if (!plan) {
    ctx.ui.notify("That checkpoint is no longer in the shadow store", "warning");
    return false;
  }
  const modeChanges = projectModeChangeCount(state, cp);
  if (isEmpty(plan) && modeChanges === 0) {
    await runBackend(state.lifetime, () => discardRestorePlan(state, plan));
    if (!alive()) return false;
    ctx.ui.notify(plan.items.length ? `${summarise(plan)}:\n\n${formatPlan(plan)}` : "No file changes to rewind", plan.items.length ? "warning" : "info");
    return true;
  }

  const modeSummary = modeChanges === 0 ? "" : `${modeChanges} permission change(s); `;
  const stats = await runBackend(state.lifetime, () => previewStats(state, plan));
  if (!alive()) return false;
  const proceed = await ctx.ui.confirm(
    `Rewind files (${modeSummary}${summarise(plan, stats)}):\n\n${formatPlan(plan, stats)}`,
    "Apply these changes?",
  );
  if (!alive()) return false;
  if (!proceed) {
    await runBackend(state.lifetime, () => discardRestorePlan(state, plan));
    if (!alive()) return false;
    ctx.ui.notify("Rewind cancelled", "info");
    return false;
  }

  // A separate decision from the preview above, and never a default: these
  // paths are shared with the rest of the machine, and "restore my project"
  // is not consent to rewrite a file in someone's home directory.
  let includeOutside = false;
  const outside = outsideItems(plan);
  if (outside.length) {
    includeOutside = await ctx.ui.confirm(
      `${outside.length} path(s) are OUTSIDE this project. Restoring them changes\n` +
        `files that other work may depend on:\n\n` +
        outside.map((i) => `  ${i.action === "delete" ? "delete " : "restore"}   ${i.display}`).join("\n"),
      "Restore those too?",
    );
    if (!alive()) return false;
  }

  let includeTypeChanges = false;
  if (needsConfirmation(plan)) {
    const tc = group(plan)["type-change"];
    includeTypeChanges = await ctx.ui.confirm(
      `${tc.length} path(s) changed type since the checkpoint. Applying these\n` +
        `DELETES whatever is there now, including directory contents:\n\n` +
        tc.map((i) => `  ${i.display}   ${i.reason ?? ""}`).join("\n"),
      "Replace them too?",
    );
    if (!alive()) return false;
  }

  const blocked = await restoreBlocked(state, ctx);
  if (!alive()) return false;
  if (blocked) {
    await runBackend(state.lifetime, () => discardRestorePlan(state, plan));
    return false;
  }
  const result = await runBackend(state.lifetime, () => applyPlan(state, plan, { includeTypeChanges, includeOutside }));
  if (!alive()) return false;
  // Content and permission restoration both finish inside applyPlan's lock.
  reportApply(ctx, result, plan, stats);
  return applySucceeded(result);
}

async function restoreConversation(state: RewindState, ctx: any, entryId: string): Promise<void> {
  const alive = flowGuard(state);
  if (!alive()) return;
  if (typeof ctx.navigateTree !== "function") {
    ctx.ui.notify("Conversation rewind needs an interactive command context", "warning");
    return;
  }
  state.suppressTreeHook = true;
  try {
    await ctx.navigateTree(entryId);
  } catch (err) {
    if (alive()) ctx.ui.notify(`Conversation rewind failed: ${err instanceof Error ? err.message : err}`, "warning");
  } finally {
    if (alive()) state.suppressTreeHook = false;
  }
}

/**
 * Pi's `compact()` chooses its own cut point from the token budget; a command
 * cannot pin one (SPEC § Not covered). So this is an ordinary compaction whose
 * summary is asked to centre on the chosen prompt — not Claude Code's
 * "summarize up to / from here", which the menu no longer promises.
 */
function compactFocused(ctx: any, prompt: string, alive: () => boolean): void {
  if (typeof ctx.compact !== "function") {
    ctx.ui.notify("Compaction API not available", "warning");
    return;
  }
  ctx.compact({
    customInstructions:
      `The user selected the prompt below as the point that matters most. In the summary, preserve its intent, ` +
      `the decisions and outcomes that followed it, and any files or facts still needed to continue it.\n\n` +
      `Selected prompt:\n${prompt}`,
    onComplete: () => { if (alive()) ctx.ui.notify("Compaction finished (Pi chose the cut point; the selected prompt guided the summary)", "info"); },
    onError: (error: Error) => { if (alive()) ctx.ui.notify(`Compaction failed: ${error.message}`, "error"); },
  });
}

async function doUndo(state: RewindState, ctx: any): Promise<void> {
  const alive = flowGuard(state);
  try { await doUndoChecked(state, ctx); }
  catch (error) { if (alive()) ctx.ui.notify(`Undo failed: ${(error as Error).message}`, "error"); }
}

async function doUndoChecked(state: RewindState, ctx: any): Promise<void> {
  const alive = flowGuard(state);
  if (!alive() || await restoreBlocked(state, ctx) || !alive()) return;
  const prepared = await runBackend(state.lifetime, () => planUndo(state));
  if (!alive()) return;
  if (!prepared) {
    ctx.ui.notify("Nothing to undo", "warning");
    return;
  }
  const modeChanges = projectModeMapChangeCount(state, prepared.plan.projectModesTo);
  let stats: LineStats | undefined;
  if (!isEmpty(prepared.plan) || modeChanges > 0) {
    const modeSummary = modeChanges ? `${modeChanges} permission change(s); ` : "";
    stats = await runBackend(state.lifetime, () => previewStats(state, prepared.plan));
    if (!alive()) return;
    const proceed = await ctx.ui.confirm(
      `Undo last rewind (${modeSummary}${summarise(prepared.plan, stats)}):\n\n${formatPlan(prepared.plan, stats)}`,
      "Apply these changes?",
    );
    if (!alive()) return;
    if (!proceed) {
      ctx.ui.notify("Undo cancelled", "info");
      return;
    }
  }

  let includeTypeChanges = false;
  if (needsConfirmation(prepared.plan)) {
    const changes = group(prepared.plan)["type-change"];
    includeTypeChanges = await ctx.ui.confirm(
      `${changes.length} path(s) changed type since the rewind. Undoing them\n` +
        `DELETES whatever is there now, including directory contents:\n\n` +
        changes.map((item) => `  ${item.display}   ${item.reason ?? ""}`).join("\n"),
      "Replace them too?",
    );
    if (!alive()) return;
  }
  if (await restoreBlocked(state, ctx) || !alive()) return;
  const result = await runBackend(state.lifetime, () => applyUndo(state, prepared, { includeTypeChanges }));
  if (!alive()) return;
  reportApply(ctx, result, prepared.plan, stats);
}

async function showCoverage(state: RewindState, ctx: any): Promise<void> {
  const alive = flowGuard(state);
  const ws = await waitReady(state);
  if (!alive()) return;
  const out = state.outside;
  const refused = out ? [...out.refused] : [];
  const refusedLines = refused.length
    ? `  ${refused.length} path(s) were refused:\n` +
      refused.slice(0, 10).map(([p, why]) => `    ${p}  (${why})`).join("\n")
    : "";

  if (!ws) {
    if (!state.disabled) {
      ctx.ui.notify(state.readyError ?? "Workspace not ready", "warning");
      return;
    }
    await ctx.ui.confirm(
      [
        `no project here   ${state.disabled}`,
        `checkpoints       ${state.checkpoints.size}`,
        `files tracked     ${out?.size ?? 0} (named by write/edit, never bash)`,
        ``,
        `NOT protected:`,
        `  every file this session did not write with write/edit — the`,
        `  directory itself is never snapshotted here`,
        refusedLines,
      ]
        .filter((line) => line !== "")
        .join("\n"),
      "Rewind coverage",
    );
    return;
  }

  const c = ws.coverage;
  const lines = [
    `checkpoints    ${state.checkpoints.size}`,
    `shadow repos   1 root + ${c.nestedCount} nested`,
    `outside files  ${out?.size ?? 0} tracked (write/edit only, never bash)`,
    `filesystem     case-${c.caseInsensitive ? "insensitive" : "sensitive"}`,
    ``,
    `NOT protected:`,
    refusedLines,
    c.unrepresentable.length
      ? `  ${c.unrepresentable.length} path(s) collide by case:\n` +
        c.unrepresentable.slice(0, 10).map((p) => `    ${p}`).join("\n")
      : `  no case collisions`,
    c.skippedNested.length
      ? `  ${c.skippedNested.length} nested repo(s) skipped:\n` +
        c.skippedNested.map((p) => `    ${p}`).join("\n")
      : `  all nested repos checkpointed`,
    c.defaultExcluded.length
      ? `  no .git and no .gitignore here, so build output is excluded\n` +
        `  by default (agent-written files inside are still tracked):\n` +
        `    ${c.defaultExcluded.join("  ")}`
      : "",
  ].filter((line) => line !== "");
  await ctx.ui.confirm(lines.join("\n"), "Rewind coverage");
}

export async function runRewindFlow(state: RewindState, ctx: any): Promise<void> {
  const alive = flowGuard(state);
  if (!ctx.hasUI || !alive() || !isCurrentSession(state, ctx)) return;

  if (state.disabled) {
    const n = state.outside?.size ?? 0;
    ctx.ui.notify(
      `No project here (${state.disabled}), so the directory is not snapshotted. ` +
        `${n} file(s) written with write/edit are tracked individually, and ` +
        `conversation rewind works as usual. ` +
        `Set PI_REWIND_FORCE=1 to checkpoint this directory anyway.`,
      "warning",
    );
  }

  const prompts = listUserPrompts(state, ctx);
  const items: string[] = [];
  if (state.undo) items.push(UNDO_LABEL);
  items.push(...prompts.map((p) => p.label));
  items.push("· coverage report");

  if (prompts.length === 0 && !state.undo) {
    ctx.ui.notify("No prompts to rewind to yet", "warning");
    return;
  }

  const choice = await ctx.ui.select("Rewind to prompt:", items);
  if (!choice || !alive()) return;
  if (choice === UNDO_LABEL) return doUndo(state, ctx);
  if (choice === "· coverage report") return showCoverage(state, ctx);

  const picked = prompts.find((p) => p.label === choice);
  if (!picked) return;

  const cp = state.checkpoints.get(picked.id);
  const mode = await chooseAction(ctx, cp !== undefined);
  if (mode === "cancel" || !alive()) return;

  if (mode === "compact-focus") {
    compactFocused(ctx, picked.text, alive);
    return;
  }

  // Pi dispatches extension commands before its own streaming queue check. Do
  // not apply files for a combined rewind unless conversation navigation can
  // run too, or the two states diverge while the active answer continues.
  if ((mode === "conversation" || mode === "all") && ctx.isIdle?.() === false) {
    ctx.ui.notify("Wait for the active response to finish before rewinding the conversation", "warning");
    return;
  }

  if ((mode === "files" || mode === "all") && cp && !(await restoreFiles(state, ctx, cp))) {
    return;
  }
  if (alive() && (mode === "conversation" || mode === "all")) {
    await restoreConversation(state, ctx, picked.id);
  }
}

async function chooseAction(ctx: any, hasCheckpoint: boolean): Promise<RestoreMode> {
  const actions = ACTIONS.filter((a) => hasCheckpoint || !a.needsCheckpoint);
  const choice = await ctx.ui.select("Restore Options", actions.map((a) => a.label));
  return actions.find((a) => a.label === choice)?.value ?? "cancel";
}

/** Selecting a node in /tree is a rewind of the conversation; offer to bring
 *  the worktree along, which is the whole point of a session tree. */
export async function handleTreeRestore(
  state: RewindState,
  event: { preparation: { targetId: string } },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (!isCurrentSession(state, ctx)) return { cancel: true };
  if (state.suppressTreeHook || !ctx.hasUI) return undefined;
  return offerRestore(state, ctx, event.preparation.targetId, "Restore code only");
}

export async function handleForkRestore(
  state: RewindState,
  event: { entryId: string },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (!isCurrentSession(state, ctx)) return { cancel: true };
  if (!ctx.hasUI) return undefined;
  return offerRestore(state, ctx, event.entryId, "Restore code only (cancel fork)");
}

async function offerRestore(
  state: RewindState,
  ctx: any,
  targetId: string,
  codeOnlyLabel: string,
): Promise<{ cancel: true } | undefined> {
  const alive = flowGuard(state);
  if (!alive()) return { cancel: true };
  const cp = pickCheckpointForEntry(state, targetId, (id) => ctx.sessionManager.getEntry(id));

  // Nothing to add: with no checkpoint and no undo, every option in this menu is
  // something pi already does on its own. Returning undefined lets the navigation
  // happen as if the extension were not installed, which is what a directory
  // outside the extension's scope should feel like.
  if (!cp && !state.undo) return undefined;

  const options: string[] = [];
  if (state.undo) options.push(UNDO_LABEL);
  if (cp) {
    options.push("Restore code and conversation");
    options.push(codeOnlyLabel);
  }
  options.push("Restore conversation only");
  options.push("Cancel");

  const choice = await ctx.ui.select("Restore Options", options);
  if (!choice || choice === "Cancel" || !alive()) return { cancel: true };
  if (choice === UNDO_LABEL) {
    await doUndo(state, ctx);
    return { cancel: true };
  }
  if (choice === "Restore conversation only" || !cp) return undefined;

  const applied = await restoreFiles(state, ctx, cp);
  if (choice === codeOnlyLabel) return { cancel: true };
  return applied && alive() ? undefined : { cancel: true };
}

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  pi.registerCommand("rewind", {
    description: "Manage file checkpoints: restore, undo, or inspect coverage",
    handler: async (_args: string, ctx: any) => {
      await runRewindFlow(state, ctx);
    },
  });
}
