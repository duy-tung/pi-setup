/**
 * Claude-style rewind for Pi, backed by shadow git repos.
 *
 * A checkpoint records the eligible worktree before a prompt, supplemented by
 * named first-touch preimages, in a shadow repo separate from the project's .git. Because
 * each commit's parent is the point we last stood at, the shadow DAG mirrors
 * the session tree: the worktree becomes a function of the node you are on.
 *
 * Historical before-only benchmark: 224 ms per checkpoint on the 95k-file
 * linux kernel; not a measurement of the 0.4 pipeline. See spike/README.md.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MUTATING_TOOLS } from "./types.js";
import { createInitialState, isCurrentSession, resetState } from "./state.js";
import { closeBackend, createBackendLifetime, drainBackend, runBackend } from "./backend-lifetime.js";
import type { RewindState } from "./state.js";
import {
  beginWorkspace,
  captureProjectPreimage,
  captureOperationAfter,
  ensureCheckpoint,
  loadIndex,
  persistIndex,
  persistLocalIndex,
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
import { packageRestoreBlocker } from "../../lib/package-activity.ts";

function toolPath(input: unknown): string | null {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === "string" && p.trim() ? p : null;
}

/**
 * Bind the pre-agent snapshot to the user entry after Pi has persisted it.
 * `turn_start` is the first awaited extension event after user `message_end`;
 * unlike `before_agent_start` and user `message_end`, its leaf is current.
 */
export async function checkpointCurrentUserEntry(
  state: RewindState,
  ctx: any,
  ensure: typeof ensureCheckpoint = ensureCheckpoint,
) {
  const generation = state.gen;
  if (!isCurrentSession(state, ctx)) return null;
  const leaf = ctx.sessionManager.getLeafEntry?.();
  if (leaf?.type !== "message" || leaf.message?.role !== "user") return null;
  const cp = await ensure(
    state,
    leaf.id,
    state.currentPrompt || "(prompt)",
    Date.parse(leaf.timestamp) || Date.now(),
  );
  if (state.gen !== generation || state.lifetime?.closed) return null;
  state.currentEntryId = leaf.id;
  if (!cp && state.lastGap && ctx.hasUI) ctx.ui.notify(state.lastGap, "warning");
  return cp;
}

/** Stop admission before cancellation, then drain whole jobs, not just locks.
 * Pi quit can emit shutdown without first aborting foreground work. */
export async function settleBackend(state: RewindState): Promise<void> {
  const lifetime = state.lifetime;
  const wasClosed = lifetime.closed;
  closeBackend(lifetime);
  state.primeAbort?.abort();
  await Promise.allSettled([state.ready, state.operationCapture]);
  await drainBackend(lifetime);
  if (!wasClosed && state.lifetime === lifetime) state.gen++;
}

// The optional state is a test seam; the runtime always creates a hosted owner.
export default function (pi: ExtensionAPI, state = createInitialState(true)) {
  state.restoreBlocker = () => packageRestoreBlocker(pi.events);
  registerCommands(pi, state);
  let closing: Promise<void> | null = null;
  const closeSession = (ctx?: any) => closing ??= (async () => {
    const ws = state.ws, sessionId = state.sessionId, outside = state.outside;
    const maintenance = createBackendLifetime(true);
    try {
      await settleBackend(state);
      persistIndex(pi, state, ctx?.sessionManager?.getBranch?.()); // Includes metadata published after a lock released.
      // Zero wait bounds lock acquisition only. Once acquired, retention/GC
      // finishes before release; it is not disguised as a two-second timeout.
      try {
        if (ws && sessionId) await ws.maintain({ sessionId, lockTimeoutMs: 0 }, maintenance);
      } catch { /* best effort; an unavailable lock never waits */ }
      try {
        if (outside) {
          mkdirSync(outside.storeDir, { recursive: true, mode: 0o700 });
          await withLock(join(outside.storeDir, "snapshot.lock"), async () => outside.maintain(30, sessionId ?? undefined), { timeoutMs: 0, lifetime: maintenance });
        }
      } catch { /* best effort */ }
    } finally {
      try {
        if (ws && sessionId) await withLock(join(ws.storeDir, "snapshot.lock"), async () => ws.releaseSession(sessionId), { timeoutMs: 0, lifetime: maintenance });
      } catch { /* A contended lease is retained, never removed without its lock. */ }
      closeBackend(maintenance);
      await drainBackend(maintenance);
    }
  })();

  pi.on("session_start", async (_event, ctx) => {
    try { await closeSession(); }
    catch {
      // A public append failure must not poison every later session. Private
      // metadata remains authoritative; still prove backend drainage first.
      await settleBackend(state);
    }
    resetState(state);
    closing = null;
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
    // Private pre-tool metadata may be newer than the last JSONL index entry.
    restorePosition(state, ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries());
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
      if (state.recoveryError) ctx.ui.notify(state.recoveryError, "warning");
      else if (state.recovery?.journal) ctx.ui.notify("An interrupted file restore was found. Nothing was replayed. Use /rewind → Undo last rewind to review recovery.", "warning");
      updateStatus(state, ctx);
      const generation = state.gen;
      void waitReady(state).then(() => {
        if (state.gen === generation && isCurrentSession(state, ctx)) updateStatus(state, ctx);
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => { await closeSession(ctx); });

  // Pi has built but not persisted the user message at this point. Capture the
  // prompt only; binding to `getLeafEntry()` here would target the previous leaf.
  pi.on("before_agent_start", async (event, ctx) => {
    const generation = state.gen;
    // Pi reports idle before dispatching agent_settled. A new run must not
    // race the previous run's in-flight observation (including same-prompt retries).
    await state.operationCapture;
    if (state.gen !== generation || !isCurrentSession(state, ctx)) return;
    state.currentPrompt = String(event.prompt ?? "").slice(0, 200);
    if (ctx.hasUI) updateStatus(state, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (!isCurrentSession(state, ctx) || !msg || msg.role !== "user") return;
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
  });

  // Pi persists the user message immediately after its awaited `message_end`
  // dispatch. `turn_start` is therefore the first hook with the current user
  // entry as the leaf, and still runs before the model or any tool can edit.
  pi.on("turn_start", async (_event, ctx) => {
    const generation = state.gen, lifetime = state.lifetime;
    if (!isCurrentSession(state, ctx)) return;
    await runBackend(lifetime, async () => {
      const leaf = ctx.sessionManager.getLeafEntry?.();
      if (leaf?.type === "message" && leaf.message?.role === "user" && state.operationEntryId && leaf.id !== state.operationEntryId) {
        // A queued/steering prompt closes the prior operation boundary.
        await captureOperationAfter(state);
      }
      if (state.gen !== generation || lifetime.closed) return;
      const checkpoint = await checkpointCurrentUserEntry(state, ctx);
      if (state.gen !== generation || lifetime.closed) return;
      if (checkpoint) state.operationEntryId = checkpoint.entryId;
      if (ctx.hasUI) updateStatus(state, ctx);
    });
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
  pi.on("tool_call", async (event, ctx) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    const lifetime = state.lifetime, gen = state.gen;
    const stopped = () => ({ block: true, reason: "Rewind session changed or is closing; tool not run" });
    if (!isCurrentSession(state, ctx)) return stopped();
    const raw = toolPath(event.input);
    if (!raw) return;
    const rel = toRelPath(state.cwd, raw);
    return runBackend(lifetime, async () => {
      try {
        // Projectless sessions keep their existing guarded per-file mechanism.
        if (isAbsolute(rel) || state.outside?.projectless) {
          if (state.outside) {
            const store = state.outside;
            mkdirSync(store.storeDir, { recursive: true, mode: 0o700 });
            await withLock(join(store.storeDir, "snapshot.lock"), async () => {
              if (gen !== state.gen) throw new Error("session changed before capture");
              if (store.touch(raw, state.checkpoints.values())) state.dirty = true;
              if (state.dirty) persistLocalIndex(state);
            }, { lifetime });
          }
        } else {
          await captureProjectPreimage(state, rel);
        }
        // Capture succeeding is not authority for a late core write after quit.
        if (lifetime.closed || state.gen !== gen) return stopped();
      } catch (error) {
        const reason = `Rewind could not preserve the pre-write state; tool not run: ${error instanceof Error ? error.message : String(error)}`;
        if (gen === state.gen && !lifetime.closed) {
          state.lastGap = reason;
          if (ctx.hasUI) ctx.ui.notify(reason, "warning");
        }
        return { block: true, reason };
      }
    });
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isCurrentSession(state, ctx)) return;
    await runBackend(state.lifetime, () => {
      persistIndex(pi, state, ctx.sessionManager?.getBranch?.());
      if (ctx.hasUI) updateStatus(state, ctx);
    });
  });

  // Unlike agent_end, this is after automatic retries/compaction/continuations.
  pi.on("agent_settled", async (_event, ctx) => {
    const generation = state.gen, lifetime = state.lifetime;
    if (!isCurrentSession(state, ctx)) return;
    await runBackend(lifetime, async () => {
      await captureOperationAfter(state);
      if (state.gen === generation && !lifetime.closed && ctx.hasUI) updateStatus(state, ctx);
    });
  });

  pi.on("session_before_fork", async (event, ctx) => handleForkRestore(state, event as any, ctx));
  pi.on("session_before_tree", async (event, ctx) => handleTreeRestore(state, event as any, ctx));
}

export { clearStatus };
