import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RewindState } from "./state.js";
import type { ApplyResult, PromptCheckpoint, RestoreMode, RestorePlan } from "./types.js";
import { applySucceeded } from "./apply-result.js";
import { applyPlan, applyUndo, discardRestorePlan, pickCheckpointForEntry, planRestore, planUndo, waitReady } from "./checkpoints.js";
import { formatPlan, group, isEmpty, needsConfirmation, outsideItems, summarise } from "./plan.js";

const ACTIONS: { label: string; value: RestoreMode }[] = [
  { label: "Restore code and conversation", value: "all" },
  { label: "Restore conversation only", value: "conversation" },
  { label: "Restore code only", value: "files" },
  { label: "Summarize up to here", value: "summarize-up" },
  { label: "Summarize from here", value: "summarize-from" },
  { label: "Cancel", value: "cancel" },
];

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

function reportApply(ctx: any, result: ApplyResult | null): void {
  if (!result) {
    ctx.ui.notify("Rewind unavailable (no workspace)", "warning");
    return;
  }
  const bits: string[] = [];
  if (result.restored) bits.push(`${result.restored} restored`);
  if (result.deleted) bits.push(`${result.deleted} deleted`);
  const base = bits.length ? bits.join(", ") : "nothing to change";

  if (result.errors.length) {
    ctx.ui.notify(`${base}; ${result.errors.length} error(s): ${result.errors[0]}`, "error");
  } else if (result.skipped.length) {
    ctx.ui.notify(`${base}; ${result.skipped.length} skipped (see /rewind preview)`, "warning");
  } else {
    ctx.ui.notify(base, "info");
  }
}

/**
 * Preview then apply. Type changes can `rm -rf` a directory that the snapshot
 * never described, so they are always a second, explicit decision.
 */
async function restoreFiles(state: RewindState, ctx: any, cp: PromptCheckpoint): Promise<boolean> {
  // A projectless session has no workspace by design, and its plan is made of
  // outside items only — not a failure to report.
  if (!(await waitReady(state)) && !state.disabled) {
    ctx.ui.notify(state.readyError ?? "Workspace not ready", "warning");
    return false;
  }

  const plan: RestorePlan | null = await planRestore(state, cp);
  if (!plan) {
    ctx.ui.notify("That checkpoint is no longer in the shadow store", "warning");
    return false;
  }
  if (isEmpty(plan)) {
    await discardRestorePlan(state, plan);
    ctx.ui.notify("No file changes to rewind", "info");
    return true;
  }

  const proceed = await ctx.ui.confirm(
    `Rewind files (${summarise(plan)}):\n\n${formatPlan(plan)}`,
    "Apply these changes?",
  );
  if (!proceed) {
    await discardRestorePlan(state, plan);
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
  }

  const result = await applyPlan(state, plan, { includeTypeChanges, includeOutside });
  reportApply(ctx, result);
  return applySucceeded(result);
}

async function restoreConversation(state: RewindState, ctx: any, entryId: string): Promise<void> {
  if (typeof ctx.navigateTree !== "function") {
    ctx.ui.notify("Conversation rewind needs an interactive command context", "warning");
    return;
  }
  state.suppressTreeHook = true;
  try {
    await ctx.navigateTree(entryId);
  } catch (err) {
    ctx.ui.notify(`Conversation rewind failed: ${err instanceof Error ? err.message : err}`, "warning");
  } finally {
    state.suppressTreeHook = false;
  }
}

function summarizeFrom(ctx: any, mode: "summarize-up" | "summarize-from", prompt: string): void {
  if (typeof ctx.compact !== "function") {
    ctx.ui.notify("Compaction API not available", "warning");
    return;
  }
  const focus =
    mode === "summarize-up"
      ? `Summarize conversation history BEFORE this user prompt; keep this prompt and everything after as the live tail.\n\nSelected prompt:\n${prompt}`
      : `Summarize from this user prompt through the latest messages; keep earlier messages intact if possible.\n\nSelected prompt:\n${prompt}`;
  ctx.compact({
    customInstructions: focus,
    onComplete: () => ctx.ui.notify("Summary compaction finished", "info"),
    onError: (error: Error) => ctx.ui.notify(`Summarize failed: ${error.message}`, "error"),
  });
}

async function doUndo(state: RewindState, ctx: any): Promise<void> {
  const prepared = await planUndo(state);
  if (!prepared) {
    ctx.ui.notify("Nothing to undo", "warning");
    return;
  }
  if (!isEmpty(prepared.plan)) {
    const proceed = await ctx.ui.confirm(
      `Undo last rewind (${summarise(prepared.plan)}):\n\n${formatPlan(prepared.plan)}`,
      "Apply these changes?",
    );
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
  }
  const result = await applyUndo(state, prepared, { includeTypeChanges });
  reportApply(ctx, result);
}

async function showCoverage(state: RewindState, ctx: any): Promise<void> {
  const ws = await waitReady(state);
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
  if (!ctx.hasUI) return;

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
  if (!choice) return;
  if (choice === UNDO_LABEL) return doUndo(state, ctx);
  if (choice === "· coverage report") return showCoverage(state, ctx);

  const picked = prompts.find((p) => p.label === choice);
  if (!picked) return;

  const mode = await chooseAction(ctx);
  if (mode === "cancel") return;

  if (mode === "summarize-up" || mode === "summarize-from") {
    summarizeFrom(ctx, mode, picked.text);
    return;
  }

  const cp = state.checkpoints.get(picked.id);
  if (mode === "files" || mode === "all") {
    if (!cp) {
      ctx.ui.notify("No file checkpoint for this prompt", "warning");
      if (mode === "files") return;
    } else if (!(await restoreFiles(state, ctx, cp))) {
      return;
    }
  }
  if (mode === "conversation" || mode === "all") {
    await restoreConversation(state, ctx, picked.id);
  }
}

async function chooseAction(ctx: any): Promise<RestoreMode> {
  const choice = await ctx.ui.select("Restore Options", ACTIONS.map((a) => a.label));
  return ACTIONS.find((a) => a.label === choice)?.value ?? "cancel";
}

/** Selecting a node in /tree is a rewind of the conversation; offer to bring
 *  the worktree along, which is the whole point of a session tree. */
export async function handleTreeRestore(
  state: RewindState,
  event: { preparation: { targetId: string } },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (state.suppressTreeHook || !ctx.hasUI) return undefined;
  return offerRestore(state, ctx, event.preparation.targetId, "Restore code only");
}

export async function handleForkRestore(
  state: RewindState,
  event: { entryId: string },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (!ctx.hasUI) return undefined;
  return offerRestore(state, ctx, event.entryId, "Restore code only (cancel fork)");
}

async function offerRestore(
  state: RewindState,
  ctx: any,
  targetId: string,
  codeOnlyLabel: string,
): Promise<{ cancel: true } | undefined> {
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
  if (!choice || choice === "Cancel") return { cancel: true };
  if (choice === UNDO_LABEL) {
    await doUndo(state, ctx);
    return { cancel: true };
  }
  if (choice === "Restore conversation only" || !cp) return undefined;

  const applied = await restoreFiles(state, ctx, cp);
  if (choice === codeOnlyLabel) return { cancel: true };
  return applied ? undefined : { cancel: true };
}

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  pi.registerCommand("rewind", {
    description: "Manage file checkpoints: restore, undo, or inspect coverage",
    handler: async (_args: string, ctx: any) => {
      await runRewindFlow(state, ctx);
    },
  });
}
