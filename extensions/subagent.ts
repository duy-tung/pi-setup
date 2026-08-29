import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  parseSessionEntries,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { isUnder, isUnsafeWorkspaceRoot, resolvePolicyPath } from "./lib/path-policy.ts";
import {
  clearPermissionSubagents,
  getPermissionMode,
  markWorkSubagentRunning,
  rememberPermissionSubagent,
} from "./lib/permission-mode.ts";
import { resolvePiInvocation } from "./lib/pi-invocation.ts";
import { SEATBELT_AVAILABLE } from "./lib/seatbelt.ts";
import {
  ManagedRpcChild,
  RpcProcessExitError,
  RpcProtocolError,
  assistantSnapshotFromRpcEvent,
  type RpcEvent,
} from "./lib/subagent-rpc.ts";
import {
  SUBAGENT_OUTPUT_LIMIT_BYTES,
  SUBAGENT_PROFILES,
  SUBAGENT_STATE_TYPE,
  SUBAGENT_STATE_VERSION,
  assertSubagentAdmission,
  buildSubagentCliArgs,
  expectedSubagentArtifactDir,
  foldSubagentRecords,
  SCRATCH_DIR_NAME,
  childHasNetwork,
  sanitizeSubagentReport,
  staleScratchDirs,
  subagentRecordPathsAreValid,
  subagentScratchDir,
  subagentTools,
  truncateUtf8,
  unavailableProfileTools,
  type CatalogDiagnostic,
  type SubagentProfile,
  type SubagentRecord,
  type SubagentStatus,
} from "./lib/subagent-state.ts";

const MAX_DEPTH = 1;
const DEPTH = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const MAX_ACTIVE = 4;
const MAX_RECENT_MODEL_ROWS = 20;
const MAX_ACTIVATION_MS = 30 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_CONSECUTIVE_WAKES = 3;
const PRIVATE_DIR_MODE = 0o700;

interface UsageSummary {
  tokens: number;
  cost: number;
}

interface ActiveChild {
  record: SubagentRecord;
  rpc: ManagedRpcChild;
  background: boolean;
  published: boolean;
  settled: boolean;
  latestText: string | null;
  latestStopReason?: string;
  latestErrorMessage?: string;
  latestActivity: string;
  usage: UsageSummary;
  interruptReason?: "explicit" | "shutdown" | "caller";
  unsubscribe: () => void;
  finalizePromise: Promise<ActivationResult>;
}

interface ActivationResult {
  record: SubagentRecord;
  report: string;
  isError: boolean;
}

interface StartingLifecycle {
  controller: AbortController;
  done: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(path, PRIVATE_DIR_MODE);
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function labelOf(description: string): string {
  const label = oneLine(description, 80);
  return label || "delegated task";
}

function fmtAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function fmtTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function activityOf(event: RpcEvent): string | undefined {
  if (event.type !== "tool_execution_start") return undefined;
  const tool = typeof event.toolName === "string" ? event.toolName : "tool";
  if (!isRecord(event.args)) return tool;
  for (const key of ["path", "file_path", "command", "pattern", "query"]) {
    const value = event.args[key];
    if (typeof value === "string" && value.trim()) return `${tool} ${oneLine(value)}`;
  }
  return tool;
}

function failureKind(error: unknown): string {
  if (error instanceof RpcProtocolError) return "RPC protocol failure";
  if (error instanceof RpcProcessExitError) return "RPC process exited before settlement";
  const message = error instanceof Error ? error.message : String(error);
  if (/did not settle within/.test(message)) return "activation timeout";
  if (/aborted/i.test(message)) return "activation aborted";
  return "RPC activation failure";
}

function resultText(record: SubagentRecord, report: string): string {
  const headline = record.status === "ready"
    ? `Subagent ${record.id} (${record.profile}) finished this turn and is ready for follow-up.`
    : record.status === "interrupted"
      ? `Subagent ${record.id} (${record.profile}) was interrupted and remains resumable.`
      : `Subagent ${record.id} (${record.profile}) failed${record.lastOutcome ? `: ${record.lastOutcome}` : "."}`;
  return truncateUtf8(`${headline}\n\n${sanitizeSubagentReport(report)}`, SUBAGENT_OUTPUT_LIMIT_BYTES,
    "\n\n[truncated — inspect the private transcript with /agents]");
}

const traceCache = new Map<string, { key: string; lines: string[] }>();

function toolArgument(args: unknown): string {
  if (!isRecord(args)) return "";
  for (const key of ["path", "file_path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `  ${oneLine(value, 120)}`;
  }
  return "";
}

function childTrace(record: SubagentRecord, live?: ActiveChild): string[] {
  const path = record.sessionFile;
  if (!path) return [live?.latestActivity ? `· ${live.latestActivity}` : "(session has not written a transcript yet)"];
  if (!subagentRecordPathsAreValid(record)) return ["(invalid parent-scoped transcript path)"];
  if (!existsSync(path)) {
    return [live?.latestActivity ? `· ${live.latestActivity}` : "(session has not written a transcript yet)"];
  }
  let key: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return ["(transcript path is not a regular file)"];
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      return [`(transcript is ${stat.size} bytes; /agents will not load more than ${MAX_TRANSCRIPT_BYTES})`];
    }
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return ["(transcript unavailable)"];
  }
  const cached = traceCache.get(path);
  if (cached?.key === key) return cached.lines;

  const lines: string[] = [];
  try {
    for (const entry of parseSessionEntries(readFileSync(path, "utf8"))) {
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      const message = entry.message;
      if (message.role === "toolResult") {
        if (message.isError === true) lines.push(`! ${typeof message.toolName === "string" ? message.toolName : "tool"} failed`);
        continue;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "toolCall" && typeof block.name === "string") {
          lines.push(`→ ${block.name}${toolArgument(block.arguments)}`);
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lines.push(...block.text.trim().split("\n").map((line) => `· ${line}`));
        }
      }
    }
  } catch {
    return ["(transcript is being updated; retry shortly)"];
  }
  const bounded = lines.slice(-2_000);
  traceCache.set(path, { key, lines: bounded });
  while (traceCache.size > 16) traceCache.delete(traceCache.keys().next().value as string);
  return bounded.length > 0 ? bounded : ["(no assistant activity recorded)"];
}

export default function (pi: ExtensionAPI) {
  const records = new Map<string, SubagentRecord>();
  const diagnostics: CatalogDiagnostic[] = [];
  /** Every live RPC process, including prompt preflight not yet published. */
  const resident = new Map<string, ActiveChild>();
  /** Prompt-accepted children exposed to model/user controls. */
  const active = new Map<string, ActiveChild>();
  const starting = new Map<string, SubagentProfile>();
  const startupLifecycles = new Map<string, StartingLifecycle>();
  const controlTails = new Map<string, Promise<void>>();
  /** Profiles already reported as short of tools, so the notice appears once. */
  const reportedToolGaps = new Set<SubagentProfile>();
  let ownerSessionId: string | undefined;
  let uiCtx: ExtensionContext | undefined;
  let shuttingDown = false;
  let wakesUsed = 0;
  let overlayOpen = false;

  function currentSessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
  }

  function ownedRecord(id: string, ctx: ExtensionContext): SubagentRecord | undefined {
    const record = records.get(id);
    return record?.parentSessionId === currentSessionId(ctx) ? record : undefined;
  }

  async function withChildControl<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = controlTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    controlTails.set(id, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (controlTails.get(id) === tail) controlTails.delete(id);
    }
  }

  function commit(record: SubagentRecord): void {
    pi.appendEntry(SUBAGENT_STATE_TYPE, record);
    records.set(record.id, record);
    rememberPermissionSubagent(record.id, record.profile);
  }

  function syncWidget(ctx = uiCtx): void {
    if (!ctx || ctx.mode !== "tui") return;
    const rows = [...records.values()]
      .filter((record) => record.status === "running")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 7)
      .map((record) => {
        const live = active.get(record.id);
        const stats = live
          ? `${fmtAge(Date.now() - record.updatedAt)} ↓${fmtTokens(live.usage.tokens)} $${live.usage.cost.toFixed(3)}`
          : record.status;
        const activity = live?.latestActivity ? ` · ${oneLine(live.latestActivity, 60)}` : "";
        return `◐ ${record.profile.padEnd(7)} ${oneLine(record.label, 42)} · ${stats}${activity}`;
      });
    try {
      if (rows.length === 0) ctx.ui.setWidget("subagents", undefined);
      else ctx.ui.setWidget("subagents", [`Subagents · /agents`, ...rows], { placement: "belowEditor" });
    } catch {
      // A session replacement may invalidate the captured UI between event and render.
    }
  }

  function noteCompletion(record: SubagentRecord, report: string): void {
    if (!uiCtx || shuttingDown || ownerSessionId !== record.parentSessionId) return;
    const note = {
      customType: "subagent-settled",
      content: resultText(record, report),
      display: true,
      details: { id: record.id, profile: record.profile, status: record.status },
    };
    let idle = false;
    try {
      idle = uiCtx.isIdle();
    } catch {
      // A stale UI context is handled by sendMessage failing below.
    }
    try {
      if (!idle) pi.sendMessage(note, { deliverAs: "steer" });
      else if (wakesUsed < MAX_CONSECUTIVE_WAKES) {
        wakesUsed++;
        pi.sendMessage(note, { deliverAs: "steer", triggerTurn: true });
      } else {
        uiCtx.ui.notify(
          `Subagent ${record.id} finished, but the wake budget is exhausted; its report waits for your next message.`,
          "warning",
        );
        pi.sendMessage(note, { deliverAs: "nextTurn" });
      }
    } catch {
      // Durable state remains available through list_agents and /agents.
    }
  }

  function observe(activeChild: ActiveChild, event: RpcEvent): void {
    if (activeChild.published) {
      if (active.get(activeChild.record.id) !== activeChild) return;
    } else if (resident.get(activeChild.record.id) !== activeChild) {
      return;
    }
    if (event.type === "agent_settled") activeChild.settled = true;
    const facts = assistantSnapshotFromRpcEvent(event);
    if (facts) {
      // One completed assistant message is one authoritative snapshot. A later
      // successful retry must clear an earlier error/abort fact rather than
      // inheriting sticky failure state.
      activeChild.latestText = facts.text ?? null;
      activeChild.latestStopReason = facts.stopReason;
      activeChild.latestErrorMessage = facts.errorMessage;
      if (facts.tokens !== undefined) activeChild.usage.tokens = facts.tokens;
      if (facts.cost !== undefined) activeChild.usage.cost += facts.cost;
    }
    const activity = activityOf(event);
    if (activity) activeChild.latestActivity = activity;
    syncWidget();
  }

  async function finishActivation(
    activeChild: ActiveChild,
    settlement: Promise<void>,
  ): Promise<ActivationResult> {
    let failure: unknown;
    try {
      await settlement;
    } catch (error) {
      failure = error;
    }

    let report = activeChild.latestText ?? "";
    if (!failure && !activeChild.interruptReason) {
      try {
        report = (await activeChild.rpc.getLastAssistantText()) ?? report;
      } catch {
        // The completed message event remains the fallback.
      }
    }

    let status: SubagentStatus;
    let outcome: string | undefined;
    if (activeChild.interruptReason) {
      status = "interrupted";
      outcome = activeChild.interruptReason === "shutdown" ? "parent session ended" : "current turn interrupted";
    } else if (failure) {
      status = "failed";
      outcome = failureKind(failure);
    } else if (activeChild.latestStopReason === "error" || activeChild.latestStopReason === "aborted" || activeChild.latestErrorMessage) {
      status = "failed";
      outcome = activeChild.latestStopReason === "aborted" ? "child turn aborted" : "child model or tool failure";
    } else if (!report.trim()) {
      status = "failed";
      outcome = "child produced no final report";
    } else {
      status = "ready";
      outcome = "completed";
    }

    let sessionFile = activeChild.record.sessionFile;
    try {
      sessionFile = (await activeChild.rpc.getState()).sessionFile ?? sessionFile;
    } catch {
      // A process/protocol failure may make the final state unavailable.
    }

    const terminal: SubagentRecord = {
      ...activeChild.record,
      ...(sessionFile ? { sessionFile } : {}),
      status,
      lastOutcome: outcome,
      updatedAt: Date.now(),
    };
    activeChild.record = terminal;
    try {
      commit(terminal);
    } catch {
      records.set(terminal.id, terminal);
      uiCtx?.ui?.notify?.(`subagent: could not persist terminal state for ${terminal.id}`, "warning");
    }

    const safeReport = report || (outcome ?? "no report");
    if (activeChild.background && activeChild.interruptReason !== "shutdown") noteCompletion(terminal, safeReport);

    try {
      activeChild.unsubscribe();
      await activeChild.rpc.dispose();
    } finally {
      if (active.get(terminal.id) === activeChild) active.delete(terminal.id);
      if (resident.get(terminal.id) === activeChild) resident.delete(terminal.id);
      if (terminal.profile === "work") markWorkSubagentRunning(terminal.id, false);
      syncWidget();
    }
    return { record: terminal, report: safeReport, isError: status !== "ready" };
  }

  function recordForNew(
    id: string,
    label: string,
    profile: SubagentProfile,
    ctx: ExtensionContext,
    network = false,
  ): SubagentRecord {
    const canonicalCwd = resolvePolicyPath(ctx.cwd, ctx.cwd).canonical;
    const parentSessionId = currentSessionId(ctx);
    const artifactDir = expectedSubagentArtifactDir(parentSessionId, id);
    return {
      version: SUBAGENT_STATE_VERSION,
      id,
      parentSessionId,
      label,
      profile,
      canonicalCwd,
      artifactDir,
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
      projectTrustedAtCreation: profile === "work" && ctx.isProjectTrusted(),
      network: profile === "work" && network,
      generation: 1,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * A profile names tools by string, so removing a package silently shrinks a
   * child instead of failing anywhere visible. Refuse the empty case, and
   * report a partial one once rather than letting the child discover it.
   */
  function assertProfileToolsAvailable(profile: SubagentProfile, ctx: ExtensionContext): void {
    // A diagnostic, not a gate: a host without the registry keeps delegating.
    if (typeof pi.getAllTools !== "function") return;
    const wanted = subagentTools(profile, SEATBELT_AVAILABLE);
    const missing = unavailableProfileTools(wanted, pi.getAllTools().map((tool) => tool.name));
    if (missing.length === 0) return;
    if (missing.length === wanted.length) {
      throw new Error(
        `The ${profile} profile has no installed tool left (${missing.join(", ")}); `
          + "restore its packages before delegating.",
      );
    }
    if (reportedToolGaps.has(profile)) return;
    reportedToolGaps.add(profile);
    ctx.ui?.notify?.(
      `subagent: the ${profile} profile is missing ${missing.join(", ")}; the child starts without them`,
      "warning",
    );
  }

  function discardScratch(paths: readonly string[]): void {
    for (const path of paths) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Leftover scratch is inert; the next sweep tries again.
      }
    }
  }

  /** Scratch left by a session that never shut down cleanly. */
  function sweepAbandonedScratch(): void {
    const root = join(homedir(), ".pi", "agent", "subagents");
    const candidates: { path: string; mtimeMs: number }[] = [];
    try {
      for (const parent of readdirSync(root, { withFileTypes: true })) {
        if (!parent.isDirectory()) continue;
        for (const child of readdirSync(join(root, parent.name), { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          const path = join(root, parent.name, child.name, SCRATCH_DIR_NAME);
          try {
            candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
          } catch {
            // No scratch directory for this child.
          }
        }
      }
    } catch {
      // No subagent artifacts yet.
      return;
    }
    discardScratch(staleScratchDirs(candidates, Date.now()));
  }

  async function startActivation(
    base: SubagentRecord,
    prompt: string,
    background: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    isNew = false,
  ): Promise<ActivationResult | SubagentRecord> {
    if (shuttingDown) throw new Error("Parent session is shutting down; no new subagent can start.");
    if (base.profile === "work" && getPermissionMode() === "plan") {
      throw new Error("Work subagents cannot start or resume while Plan mode is active.");
    }
    if (base.parentSessionId !== currentSessionId(ctx)) throw new Error("Subagent does not belong to this parent session.");
    assertProfileToolsAvailable(base.profile, ctx);
    const expectedArtifactDir = expectedSubagentArtifactDir(base.parentSessionId, base.id);
    if (!subagentRecordPathsAreValid(base)) {
      throw new Error("Subagent artifact or session identity is outside its parent-scoped private directory.");
    }
    if (canonical(ctx.cwd) !== base.canonicalCwd) throw new Error("Parent cwd changed; refusing to resume the child in another workspace.");
    if (
      base.profile === "work"
      && (!base.projectTrustedAtCreation || !ctx.isProjectTrusted() || isUnsafeWorkspaceRoot(base.canonicalCwd))
    ) {
      throw new Error("The work profile requires its creation-time trust grant and a currently trusted, non-broad project workspace.");
    }
    if (!isNew) {
      if (!base.sessionFile || !existsSync(base.sessionFile)) {
        throw new Error("The saved child session is unavailable; start a new subagent instead.");
      }
      const sessionRoot = canonical(join(expectedArtifactDir, "sessions"));
      const sessionFile = canonical(base.sessionFile);
      if (!isUnder(sessionFile, sessionRoot)) {
        throw new Error("The saved child session path is outside its private artifact directory.");
      }
    }

    const activeProfiles = new Map([...active].map(([id, child]) => [id, child.record.profile] as const));
    assertSubagentAdmission(base.id, base.profile, activeProfiles, starting, MAX_ACTIVE);
    const record: SubagentRecord = isNew ? base : {
      ...base,
      generation: base.generation + 1,
      status: "running",
      lastOutcome: undefined,
      updatedAt: Date.now(),
    };
    let rpc: ManagedRpcChild | undefined;
    const startupController = new AbortController();
    let startupFinished = false;
    let resolveStartup!: () => void;
    const startupDone = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    const finishStartup = () => {
      if (startupFinished) return;
      startupFinished = true;
      resolveStartup();
    };
    const lifecycle: StartingLifecycle = {
      controller: startupController,
      done: startupDone,
    };
    const disposeStartupRpc = () => {
      void rpc?.dispose().catch(() => {});
    };
    startupController.signal.addEventListener("abort", disposeStartupRpc);
    const abortStartup = () => {
      startupController.abort("subagent startup cancelled");
    };
    starting.set(base.id, base.profile);
    if (base.profile === "work") markWorkSubagentRunning(base.id, true);
    startupLifecycles.set(base.id, lifecycle);
    if (signal?.aborted) abortStartup();
    else signal?.addEventListener("abort", abortStartup, { once: true });

    try {
      if (startupController.signal.aborted) throw new Error("Subagent startup was aborted");
      ensurePrivateDir(join(homedir(), ".pi", "agent", "subagents"));
      ensurePrivateDir(join(homedir(), ".pi", "agent", "subagents", base.parentSessionId));
      ensurePrivateDir(base.artifactDir);
      ensurePrivateDir(join(base.artifactDir, "sessions"));
      if (SUBAGENT_PROFILES[base.profile].scratch) ensurePrivateDir(subagentScratchDir(base.artifactDir));
      const invocation = resolvePiInvocation();
      const args = [...invocation.args, ...buildSubagentCliArgs(record)];
      rpc = await ManagedRpcChild.start({
        command: invocation.command,
        args,
        cwd: record.canonicalCwd,
        env: {
          PI_SUBAGENT_DEPTH: String(DEPTH + 1),
          PI_SUBAGENT_PARENT_ID: record.parentSessionId,
          // Always explicit, so a mutation-capable child can never inherit a
          // stale read-only flag or a read-only child a missing one.
          PI_SUBAGENT_READONLY: SUBAGENT_PROFILES[record.profile].readOnlyBash ? "1" : "0",
          PI_SUBAGENT_SCRATCH: SUBAGENT_PROFILES[record.profile].scratch
            ? subagentScratchDir(record.artifactDir)
            : "",
          // A child reaches the network only through a grant recorded at
          // activation, so an unattended turn cannot acquire one later.
          PI_SUBAGENT_NETWORK: childHasNetwork(record) ? "1" : "0",
        },
        stderrPath: join(record.artifactDir, `stderr-${record.generation}.log`),
        signal: startupController.signal,
      });
      if (startupController.signal.aborted) throw new Error("Subagent startup was aborted");

      const initialState = await rpc.getState();
      const activeChild: ActiveChild = {
        record,
        rpc,
        background,
        published: false,
        settled: false,
        latestText: null,
        latestActivity: "starting",
        usage: { tokens: 0, cost: 0 },
        unsubscribe: () => {},
        finalizePromise: Promise.resolve(undefined as never),
      };
      resident.set(record.id, activeChild);
      activeChild.unsubscribe = rpc.onEvent((event) => observe(activeChild, event));
      const settlement = rpc.nextSettlement(MAX_ACTIVATION_MS);
      // Process exit/protocol failure may reject before prompt acceptance returns.
      void settlement.catch(() => {});

      await rpc.prompt(prompt);
      // Prompt acceptance is the publication boundary, but a cancellation that
      // won before this continuation resumes still owns startup and publishes no
      // child into a departing/stale parent session.
      if (startupController.signal.aborted || shuttingDown) {
        throw new Error("Subagent startup was cancelled before publication");
      }
      signal?.removeEventListener("abort", abortStartup);
      activeChild.record = {
        ...record,
        ...(initialState.sessionFile ? { sessionFile: initialState.sessionFile } : {}),
        updatedAt: Date.now(),
      };
      commit(activeChild.record);
      activeChild.published = true;
      active.set(record.id, activeChild);
      starting.delete(record.id);
      startupLifecycles.delete(record.id);
      finishStartup();
      activeChild.latestActivity = "working";
      syncWidget(ctx);

      activeChild.finalizePromise = finishActivation(activeChild, settlement);
      if (background) {
        void activeChild.finalizePromise.catch(() => {});
        return activeChild.record;
      }

      const abortForeground = () => {
        if (!markInterruption(activeChild, "caller")) return;
        void activeChild.rpc.abort().catch(() => activeChild.rpc.dispose()).catch(() => {});
      };
      signal?.addEventListener("abort", abortForeground, { once: true });
      if (signal?.aborted) abortForeground();
      try {
        return await activeChild.finalizePromise;
      } finally {
        signal?.removeEventListener("abort", abortForeground);
      }
    } catch (error) {
      starting.delete(record.id);
      active.delete(record.id);
      resident.delete(record.id);
      if (record.profile === "work") markWorkSubagentRunning(record.id, false);
      await rpc?.dispose();
      if (isNew && !records.has(record.id)) {
        try {
          rmSync(record.artifactDir, { recursive: true, force: true });
        } catch {
          // Partial private artifacts are harmless and remain inspectable.
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortStartup);
      startupController.signal.removeEventListener("abort", disposeStartupRpc);
      if (startupLifecycles.get(record.id) === lifecycle) startupLifecycles.delete(record.id);
      finishStartup();
    }
  }

  async function resumeStored(
    record: SubagentRecord,
    message: string,
    ctx: ExtensionContext,
  ): Promise<SubagentRecord> {
    const result = await startActivation(record, message, true, ctx, undefined, false);
    return result as SubagentRecord;
  }

  function markInterruption(
    child: ActiveChild,
    reason: NonNullable<ActiveChild["interruptReason"]>,
  ): boolean {
    if (child.settled) return false;
    child.interruptReason = reason;
    return true;
  }

  async function continueChild(
    initial: SubagentRecord,
    message: string,
    ctx: ExtensionContext,
    delivery: "followUp" | "steer",
  ): Promise<"queued" | "resumed"> {
    return withChildControl(initial.id, async () => {
      let record = records.get(initial.id) ?? initial;
      const live = active.get(record.id);
      if (live) {
        if (!live.settled) {
          try {
            if (delivery === "followUp") await live.rpc.followUp(message);
            else await live.rpc.steer(message);
            // Drain already-emitted stdout events before deciding whether the
            // command joined the live run or arrived after settlement.
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (!live.settled) return "queued";
          } catch {
            // A failed RPC command delivered nothing. Resume the same message
            // only after this activation has reached its durable terminal state.
          }
        }
        await live.finalizePromise;
        record = records.get(record.id) ?? record;
      }
      await resumeStored(record, message, ctx);
      return "resumed";
    });
  }

  async function interruptLive(child: ActiveChild): Promise<void> {
    await withChildControl(child.record.id, async () => {
      if (!markInterruption(child, "explicit")) {
        await child.finalizePromise;
        return;
      }
      try {
        await child.rpc.abort();
      } catch {
        await child.rpc.dispose();
      }
      await child.finalizePromise;
    });
  }

  async function showAgentView(ctx: ExtensionContext, id: string): Promise<void> {
    await ctx.ui.custom<null>((tui, theme: Theme, _keybindings, done) => {
      const container = new Container();
      const header = new Text("", 1, 0);
      const body = new Text("", 1, 0);
      const input = new Input();
      let poll: ReturnType<typeof setInterval> | undefined;
      let viewWidth = process.stdout.columns ?? 120;
      let scrollBack = 0;
      let currentLines: string[] = [];

      const rowBudget = () => Math.max(8, (process.stdout.rows ?? 40) - 12);
      const draw = () => {
        const record = records.get(id);
        if (!record) {
          header.setText(theme.fg("warning", `${id} is no longer in this session.`));
          body.setText("");
          tui.requestRender();
          return;
        }
        const live = active.get(id);
        const nextLines = childTrace(record, live);
        if (scrollBack > 0 && nextLines.length > currentLines.length) {
          scrollBack += nextLines.length - currentLines.length;
        }
        currentLines = nextLines;
        const budget = rowBudget();
        const maxScroll = Math.max(0, currentLines.length - budget);
        scrollBack = Math.min(scrollBack, maxScroll);
        const start = Math.max(0, currentLines.length - budget - scrollBack);
        const visible = currentLines
          .slice(start, start + budget)
          .map((line) => truncateToWidth(line, Math.max(10, viewWidth - 2)));
        const mode = live && !live.settled ? "running · type to steer · ctrl+k interrupt" : "stored · type to resume";
        const position = scrollBack > 0 ? ` · ↑${scrollBack} from tail` : " · following tail";
        header.setText(
          `${theme.fg("accent", theme.bold(oneLine(record.label, 80)))}\n`
          + `${theme.fg("muted", `${record.id} · ${record.profile} · ${record.status} · ${mode}${position}`)}\n`
          + theme.fg("dim", record.sessionFile ?? record.artifactDir),
        );
        body.setText(visible.join("\n"));
        tui.requestRender();
      };

      const scroll = (amount: number) => {
        const maxScroll = Math.max(0, currentLines.length - rowBudget());
        scrollBack = Math.max(0, Math.min(maxScroll, scrollBack + amount));
        draw();
      };

      input.onSubmit = (value: string) => {
        const message = value.trim();
        input.setValue("");
        if (!message) return;
        void (async () => {
          const record = records.get(id);
          if (!record) return;
          try {
            await continueChild(record, message, ctx, "steer");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          draw();
        })();
      };
      input.onEscape = () => done(null);

      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(header);
      container.addChild(body);
      container.addChild(new DynamicBorder((text: string) => theme.fg("dim", text)));
      container.addChild(input);
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      draw();
      poll = setInterval(draw, 700);
      poll.unref?.();

      return {
        render(width: number) {
          viewWidth = width;
          return container.render(width);
        },
        invalidate: () => container.invalidate(),
        dispose() {
          if (poll) clearInterval(poll);
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) return done(null);
          if (matchesKey(data, Key.ctrl("k"))) {
            const live = active.get(id);
            if (live) void interruptLive(live).then(draw);
            return;
          }
          if (matchesKey(data, Key.pageUp)) return scroll(rowBudget() - 1);
          if (matchesKey(data, Key.pageDown)) return scroll(-(rowBudget() - 1));
          input.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function openAgentPicker(ctx: ExtensionContext): Promise<void> {
    if (overlayOpen || ctx.mode !== "tui") return;
    const sorted = [...records.values()].sort((a, b) => {
      const aLive = active.has(a.id) ? 0 : 1;
      const bLive = active.has(b.id) ? 0 : 1;
      return aLive - bLive || b.updatedAt - a.updatedAt;
    });
    if (sorted.length === 0) {
      ctx.ui.notify("No subagents in this session.", "info");
      return;
    }

    overlayOpen = true;
    try {
      const items: SelectItem[] = sorted.map((record) => ({
        value: record.id,
        label: `${record.profile}  ${oneLine(record.label, 80)}`,
        description: `${record.status} · ${fmtAge(Date.now() - record.updatedAt)} · ${record.id}`,
      }));
      const selected = await ctx.ui.custom<string | null>((tui, theme: Theme, _keybindings, done) => {
        const container = new Container();
        const list = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        });
        list.onSelect = (item: SelectItem) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "enter open · x interrupt · esc close"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (data === "x") {
              const item = list.getSelectedItem();
              const live = item ? active.get(item.value) : undefined;
              if (live) void interruptLive(live);
              return;
            }
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (selected) await showAgentView(ctx, selected);
    } finally {
      overlayOpen = false;
    }
  }

  pi.on("input", (event) => {
    if (event.source !== "extension") wakesUsed = 0;
  });

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    ownerSessionId = currentSessionId(ctx);
    shuttingDown = false;
    overlayOpen = false;
    records.clear();
    clearPermissionSubagents();
    diagnostics.length = 0;
    const folded = foldSubagentRecords(ctx.sessionManager.getBranch(), ownerSessionId);
    for (const [id, record] of folded.records) {
      records.set(id, record);
      rememberPermissionSubagent(id, record.profile);
    }
    diagnostics.push(...folded.diagnostics);
    sweepAbandonedScratch();

    for (const record of [...records.values()]) {
      if (record.status !== "running") continue;
      const interrupted: SubagentRecord = {
        ...record,
        status: "interrupted",
        lastOutcome: "parent runtime restarted before settlement",
        updatedAt: Date.now(),
      };
      try {
        commit(interrupted);
      } catch {
        records.set(interrupted.id, interrupted);
      }
    }
    syncWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    overlayOpen = false;
    const startups = [...startupLifecycles.values()];
    for (const startup of startups) startup.controller.abort("parent session shutdown");
    const unpublished = [...resident.values()].filter((child) => !child.published);
    await Promise.allSettled(unpublished.map((child) => child.rpc.dispose()));
    await Promise.allSettled(startups.map((startup) => startup.done));

    const children = [...active.values()];
    await Promise.allSettled(children.map(async (child) => {
      if (!markInterruption(child, "shutdown")) {
        await child.finalizePromise;
        return;
      }
      try {
        await Promise.race([
          child.rpc.abort(),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref?.();
          }),
        ]);
      } catch {
        // Disposal below is authoritative.
      }
      await child.rpc.dispose();
      await child.finalizePromise;
    }));
    // Scratch belongs to this parent session; the transcripts beside it stay.
    discardScratch([...records.values()].map((record) => subagentScratchDir(record.artifactDir)));
    uiCtx?.ui?.setWidget?.("subagents", undefined);
    uiCtx = undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a complete standalone task to a fresh Pi child session. The child keeps bulk work out of this context and remains resumable by ID. "
      + "Runs in the background by default and sends one completion notice; set run_in_background false only when your next action depends on the result.",
    promptSnippet: "Delegate focused work to a resumable Pi subagent",
    promptGuidelines: [
      "Start independent background subagents together and continue useful work while they run; use foreground only when the next step needs the result.",
      "Give every fresh subagent a complete standalone prompt: it does not see this conversation.",
      "Use explore for local read-only work including git history and other offline Bash inspection, web for online research without project files, and work only for changes in a trusted workspace.",
      "A work child is offline unless you request network, which the user must approve; ask for it only when the task itself fetches, such as installing dependencies.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Short 3-5 word display label" }),
      prompt: Type.String({ description: "Complete standalone task, constraints, relevant paths, and deliverable" }),
      profile: StringEnum(["explore", "web", "work"] as const),
      network: Type.Optional(Type.Boolean({
        description: "Work profile only: allow the child's Bash to reach the network. Defaults to false and requires user approval; it cannot be changed by resuming the child.",
      })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true; false waits for the final report" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (DEPTH >= MAX_DEPTH) {
        return {
          content: [{ type: "text", text: `Subagent depth limit reached (${MAX_DEPTH}); do the delegated work yourself.` }],
          details: { refused: "max-depth" },
          isError: true,
        };
      }
      const profile = params.profile as SubagentProfile;
      if (params.network === true && profile !== "work") {
        return {
          content: [{ type: "text", text: `The ${profile} profile has no network by design; drop the network argument.` }],
          details: { refused: "network-profile" },
          isError: true,
        };
      }
      const id = randomUUID();
      const record = recordForNew(id, labelOf(params.description), profile, ctx, params.network === true);
      try {
        const background = params.run_in_background !== false;
        const result = await startActivation(record, params.prompt, background, ctx, signal, true);
        if (background) {
          const started = result as SubagentRecord;
          ctx.ui?.notify?.(`Subagent ${started.id} started (${profile})`, "info");
          return {
            content: [{ type: "text", text: `Started background subagent ${started.id} (${profile}). Its completion will arrive automatically.` }],
            details: { id: started.id, profile, status: started.status },
          };
        }
        const finished = result as ActivationResult;
        return {
          content: [{ type: "text", text: resultText(finished.record, finished.report) }],
          details: { id: finished.record.id, profile, status: finished.record.status },
          isError: finished.isError,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to start subagent: ${error instanceof Error ? error.message : String(error)}` }],
          details: { profile },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Message subagent",
    description:
      "Send a follow-up to one of this session's subagents. A running child queues it for a later turn; a stored child cold-resumes the same conversation in the background. This call confirms acceptance but does not return the later answer.",
    promptSnippet: "Continue an existing subagent conversation",
    parameters: Type.Object({
      subagent_id: Type.String({ description: "Stable child ID returned by subagent" }),
      message: Type.String({ description: "Follow-up task for the existing child context" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = ownedRecord(params.subagent_id, ctx);
      if (!record) {
        return {
          content: [{ type: "text", text: `No subagent ${params.subagent_id} owned by this parent session.` }],
          details: { id: params.subagent_id },
          isError: true,
        };
      }
      try {
        const delivery = await continueChild(record, params.message, ctx, "followUp");
        return delivery === "queued"
          ? {
              content: [{ type: "text", text: `Queued a later turn for subagent ${record.id}.` }],
              details: { id: record.id, queued: true },
            }
          : {
              content: [{ type: "text", text: `Resumed subagent ${record.id}; its completion will arrive automatically.` }],
              details: { id: record.id, resumed: true },
            };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Could not continue subagent ${record.id}: ${error instanceof Error ? error.message : String(error)}` }],
          details: { id: record.id },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List subagents",
    description:
      "List this parent session's resumable subagents by stable ID. Use it to recall children, not to poll for completion; background completion is delivered automatically.",
    promptSnippet: "Recall this session's subagents",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (currentSessionId(ctx) !== ownerSessionId) {
        return { content: [{ type: "text", text: "Subagent catalog is not bound to this session." }], details: {}, isError: true };
      }
      const rows = [...records.values()]
        .sort((a, b) => {
          const aLive = active.has(a.id) ? 0 : 1;
          const bLive = active.has(b.id) ? 0 : 1;
          return aLive - bLive || b.updatedAt - a.updatedAt;
        });
      const visible = rows.slice(0, MAX_RECENT_MODEL_ROWS);
      const rawText = visible.length === 0 && diagnostics.length === 0
        ? "(no subagents)"
        : [
            ...visible.map((record) => `${record.id} [${record.status}] (${record.profile}) — ${oneLine(record.label, 80)}`),
            ...(rows.length > visible.length ? [`… ${rows.length - visible.length} older subagents; inspect with /agents`] : []),
            ...diagnostics.slice(0, 5).map((diagnostic) => `[diagnostic: ${diagnostic.reason}] entry ${diagnostic.entryId}`),
          ].join("\n");
      const text = truncateUtf8(rawText, SUBAGENT_OUTPUT_LIMIT_BYTES, "\n[truncated — inspect with /agents]");
      return { content: [{ type: "text", text }], details: { count: rows.length, diagnostics: diagnostics.length } };
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt subagent",
    description:
      "Stop a running child activation and wait for it to become idle. The durable child conversation remains available for later send_message calls. Interrupting a known inactive child is a no-op.",
    promptSnippet: "Interrupt a subagent's current activation",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = ownedRecord(params.agent_id, ctx);
      if (!record) {
        return {
          content: [{ type: "text", text: `No subagent ${params.agent_id} owned by this parent session.` }],
          details: { id: params.agent_id },
          isError: true,
        };
      }
      const live = active.get(record.id);
      if (!live) {
        return { content: [{ type: "text", text: `Subagent ${record.id} is not running; nothing to interrupt.` }], details: { id: record.id } };
      }
      await interruptLive(live);
      return {
        content: [{ type: "text", text: `Interrupted subagent ${record.id}; its session remains resumable.` }],
        details: { id: record.id },
      };
    },
  });

  pi.registerCommand("agents", {
    description: "Open this session's subagent list",
    handler: async (_args, ctx) => openAgentPicker(ctx),
  });
}
