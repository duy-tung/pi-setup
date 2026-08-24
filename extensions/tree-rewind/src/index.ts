/**
 * Claude-style rewind for Pi, backed by shadow git repos.
 *
 * A checkpoint is the whole worktree as it stood before a prompt, recorded as
 * a commit in a shadow repo that never touches the project's own .git. Because
 * each commit's parent is the point we last stood at, the shadow DAG mirrors
 * the session tree: the worktree becomes a function of the node you are on.
 *
 * Measured: 224 ms per checkpoint on the 95k-file linux kernel, taken while
 * the model is thinking. See spike/README.md and spike/DECISIONS.md.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MUTATING_TOOLS } from "./types.js";
import { createInitialState, resetState } from "./state.js";
import {
  beginWorkspace,
  ensureCheckpoint,
  loadIndex,
  persistIndex,
  restorePosition,
  toRelPath,
  waitReady,
} from "./checkpoints.js";
import { clearStatus, updateStatus } from "./ui.js";
import { reapStores } from "./reaper.js";
import { storeDirFor } from "./workspace.js";
import { resolveExisting } from "./eligibility.js";
import { withLock } from "./lock.js";
import { handleForkRestore, handleTreeRestore, registerCommands } from "./commands.js";

function toolPath(input: unknown): string | null {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === "string" && p.trim() ? p : null;
}

export default function (pi: ExtensionAPI) {
  const state = createInitialState();
  registerCommands(pi, state);

  pi.on("session_start", async (_event, ctx) => {
    resetState(state);
    state.sessionId = ctx.sessionManager.getSessionId();
    try {
      loadIndex(state, ctx.sessionManager.getEntries());
      restorePosition(
        state,
        ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries(),
      );
    } catch {
      /* a corrupt index must not take the session down */
    }
    // Not awaited: the cold snapshot runs while the user types.
    beginWorkspace(state, ctx.cwd);
    // Nothing else ever reaches a store whose project was deleted: maintain()
    // runs at shutdown *in* that project. Cheap (stat, no git) and guarded on
    // every side, so it rides along on session start rather than asking for a
    // command nobody would run.
    try {
      reapStores({ keep: storeDirFor(resolveExisting(ctx.cwd)) });
    } catch {
      /* housekeeping must never take a session down */
    }
    if (ctx.hasUI) {
      updateStatus(state, ctx);
      void waitReady(state).then(() => updateStatus(state, ctx));
    }
  });

  pi.on("session_shutdown", async () => {
    persistIndex(pi, state);
    // Bounded by age and count, and everything worth keeping carries a ref.
    // Never blocks shutdown: if the workspace is not up yet, skip it.
    try {
      if (state.ws && state.sessionId) await state.ws.maintain({ sessionId: state.sessionId });
      // Runs with or without a workspace: a projectless session is the case
      // where the blob store is the only thing that grew.
      state.outside?.maintain();
    } catch {
      /* maintenance is best effort */
    }
  });

  // The checkpoint is taken here, before the agent has touched anything, so it
  // captures the pre-edit worktree and binds it to the user message id.
  pi.on("before_agent_start", async (event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry?.();
    state.currentPrompt = String(event.prompt ?? "").slice(0, 200);
    if (leaf?.type === "message" && leaf.message?.role === "user") {
      // Bounded wait: on a cold kernel-sized repo we declare the prompt
      // unprotected rather than stalling the agent for 42s.
      const cp = await ensureCheckpoint(
        state,
        leaf.id,
        state.currentPrompt || "(prompt)",
        Date.parse(leaf.timestamp) || Date.now(),
      );
      state.currentEntryId = leaf.id;
      if (!cp && state.lastGap && ctx.hasUI) ctx.ui.notify(state.lastGap, "warning");
    }
    if (ctx.hasUI) updateStatus(state, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const leaf = ctx.sessionManager.getLeafEntry?.();
    if (!leaf || leaf.type !== "message") return;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join("\n")
          : "";
    state.currentPrompt = String(text).slice(0, 200);
    await ensureCheckpoint(state, leaf.id, state.currentPrompt || "(prompt)", msg.timestamp || Date.now());
    state.currentEntryId = leaf.id;
  });

  // Two jobs, split by where the path lands.
  //
  // Inside the project: force-track it, so an edit inside node_modules/ or
  // dist/ stays revertible even though .gitignore would hide it.
  //
  // Outside: snapshot the file itself. It must not go into forceTrack — an
  // absolute pathspec makes `git add -f` fatal, which failed the *entire*
  // checkpoint, so writing to one file outside the project used to leave the
  // whole prompt unprotected.
  //
  // pi awaits this hook before running the tool, so the capture below is the
  // pre-write content. Only write/edit carry a path: bash is not covered
  // either way, and the docs declare that instead of implying coverage.
  pi.on("tool_call", async (event) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    const raw = toolPath(event.input);
    if (!raw) return;
    const rel = toRelPath(state.cwd, raw);
    // Where there is no project there is no "inside": nothing is staged here,
    // so every edited path goes to the store or nowhere.
    if (isAbsolute(rel) || state.outside?.projectless) {
      // The back-fill rewrites checkpoints that are already persisted. Share
      // the store lock with outside apply/snapshot so capture cannot observe a
      // truncate-and-write halfway through another session's restore.
      if (state.outside) {
        const store = state.outside;
        mkdirSync(store.storeDir, { recursive: true, mode: 0o700 });
        await withLock(join(store.storeDir, "snapshot.lock"), async () => {
          if (store.touch(raw, state.checkpoints.values())) state.dirty = true;
        });
      }
      return;
    }
    state.forceTrack.add(rel);
  });

  pi.on("turn_end", async (_event, ctx) => {
    persistIndex(pi, state);
    if (ctx.hasUI) updateStatus(state, ctx);
  });

  pi.on("session_before_fork", async (event, ctx) => handleForkRestore(state, event as any, ctx));
  pi.on("session_before_tree", async (event, ctx) => handleTreeRestore(state, event as any, ctx));
}

export { clearStatus };
