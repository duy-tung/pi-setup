/**
 * The single owner of Pi's Bash tool override.
 *
 * On macOS, each call gets a fresh Seatbelt profile derived from ctx.cwd:
 * writes stay in the workspace/temp areas, protected config stays read-only,
 * and known credential files are unreadable. Reads elsewhere and NETWORK are
 * deliberately unrestricted. There is no unsandboxed retry: a denial is final
 * for the agent, which reports the exact command for the user to decide on.
 *
 * A read-only subagent (PI_SUBAGENT_READONLY=1, set by subagent.ts for the
 * explore profile) has no network at all and one writable root: its own private
 * scratch directory. Its Bash can inspect history, keep an intermediate file,
 * and leave a large result for the parent to read, without touching the
 * workspace or reaching outside. That guarantee is the OS profile, so without
 * Seatbelt this Bash refuses to run rather than degrading into an unconfined
 * shell.
 *
 * This is Bash confinement, not a sandbox for Pi as a whole. Built-in file
 * tools use permission-gate's trusted canonical-path checks; user Bash and
 * extension-owned effects remain outside this wrapper.
 */

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildProfile,
  canonical,
  classifyFailure,
  confine,
  DENIAL_MARKER,
  OFFLINE_CHILD_DENIAL_MARKER,
  PLAN_DENIAL_MARKER,
  READ_ONLY_CHILD_DENIAL_MARKER,
  RUNNER_MARKER,
  SEATBELT_AVAILABLE,
  writableRoots,
} from "./lib/seatbelt";
import { getPermissionMode } from "./lib/permission-mode.ts";
import {
  isUnder,
  isUnsafeWorkspaceRoot,
  protectedWriteRules,
  sensitiveReadRules,
} from "./lib/path-policy.ts";

const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;
const ALLOWLIST = new Set<string>();
const PINNED: Record<string, string> = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
};

function scrub(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV.test(key) && !ALLOWLIST.has(key)) continue;
    out[key] = value;
  }
  Object.assign(out, PINNED);
  return out;
}

const sandboxActive = SEATBELT_AVAILABLE;
/** Set by subagent.ts for profiles whose Bash must be read-only and offline. */
const readOnlyChild = process.env.PI_SUBAGENT_READONLY === "1";
const isChild = process.env.PI_SUBAGENT_DEPTH !== undefined && Number(process.env.PI_SUBAGENT_DEPTH) > 0;
/**
 * A child reads material nobody has reviewed and cannot ask for anything mid
 * turn, so its network stays closed unless the user granted it when the child
 * was started. The parent keeps unrestricted network: it is attended.
 */
const offlineChild = isChild && process.env.PI_SUBAGENT_NETWORK !== "1";

/**
 * The child's own private directory, and the only writable root a read-only
 * child gets. It is accepted only inside the parent-scoped artifact tree, so a
 * stray value cannot reopen the workspace.
 */
function scratchRoot(): string[] {
  if (!readOnlyChild) return [];
  const requested = process.env.PI_SUBAGENT_SCRATCH;
  if (!requested) return [];
  const root = canonical(join(homedir(), ".pi", "agent", "subagents"));
  const scratch = canonical(requested);
  return isUnder(scratch, root) && existsSync(scratch) ? [scratch] : [];
}

function bashSettings(): { shellPath?: string; commandPrefix?: string } {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
    return {
      shellPath: typeof raw.shellPath === "string" ? raw.shellPath : undefined,
      commandPrefix: typeof raw.shellCommandPrefix === "string" ? raw.shellCommandPrefix : undefined,
    };
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  const { shellPath, commandPrefix } = bashSettings();
  const template = createBashToolDefinition(process.cwd(), { shellPath });

  pi.registerTool({
    ...template,
    executionMode: "sequential",
    description: readOnlyChild
      ? `${template.description} Commands run read-only under macOS Bash confinement: network is unavailable, reads of known credential paths are denied, and the only writable path is $PI_SUBAGENT_SCRATCH. Use it for inspection such as git history, log analysis, and counting. Sandbox denials cannot be escalated by the agent.`
      : sandboxActive
        ? `${template.description} Commands run with macOS Bash confinement: writes outside the current workspace and temp areas, writes to protected config, and reads of known credential paths are denied. Other reads and network are unrestricted. Sandbox denials cannot be escalated by the agent.`
        : `${template.description} The OS Bash sandbox is unavailable; only sensitive environment-variable scrubbing is active.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout } = params as { command: string; timeout?: number };
      const cwd = ctx.cwd ?? process.cwd();
      const base = createBashToolDefinition(cwd, {
        shellPath,
        spawnHook: (spawn) => ({ ...spawn, env: scrub(spawn.env) }),
      });
      const effectiveCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;

      if (!sandboxActive) {
        // A child's guarantee is the OS profile, not the prompt.
        if (readOnlyChild || offlineChild) {
          throw new Error(
            "sandbox-bash: confined subagent Bash requires the macOS sandbox, which is unavailable here. "
              + "Report this to the user instead of retrying.",
          );
        }
        return base.execute(toolCallId, { command: effectiveCommand, timeout }, signal, onUpdate, ctx);
      }

      const canonicalCwd = canonical(cwd);
      const mode = getPermissionMode();
      const roots = readOnlyChild
        ? scratchRoot()
        : mode === "plan"
          ? []
          : writableRoots(canonicalCwd).filter(
              (root) => !isUnsafeWorkspaceRoot(canonicalCwd) || root !== canonicalCwd,
            );
      const profile = buildProfile(
        roots,
        sensitiveReadRules(canonicalCwd),
        protectedWriteRules(canonicalCwd),
        readOnlyChild || offlineChild,
      );

      try {
        return await base.execute(
          toolCallId,
          { command: confine(effectiveCommand, profile), timeout },
          signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        if (error instanceof Error) {
          const kind = classifyFailure(error.message);
          if (kind === "runner") throw new Error(`${error.message}\n\n${RUNNER_MARKER}`);
          if (kind === "denial") {
            throw new Error(
              `${error.message}\n\n${readOnlyChild
                ? READ_ONLY_CHILD_DENIAL_MARKER
                : offlineChild
                  ? OFFLINE_CHILD_DENIAL_MARKER
                  : mode === "plan"
                    ? PLAN_DENIAL_MARKER
                    : DENIAL_MARKER}\n[sandbox: denial is final for the agent; report the exact command to the user]`,
            );
          }
        }
        throw error;
      }
    },
  });

  if (!sandboxActive) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui?.notify?.(
        "sandbox-bash: macOS sandbox-exec is unavailable — Bash runs without file confinement (env scrub remains active)",
        "warning",
      );
    });
  }
}
