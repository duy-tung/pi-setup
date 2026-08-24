/**
 * The single owner of Pi's Bash tool override.
 *
 * On macOS, each call gets a fresh Seatbelt profile derived from ctx.cwd:
 * writes stay in the workspace/temp areas, protected config stays read-only,
 * and known credential files are unreadable. Reads elsewhere and NETWORK are
 * deliberately unrestricted. There is no unsandboxed retry: a denial is final
 * for the agent, which reports the exact command for the user to decide on.
 *
 * This is Bash confinement, not a sandbox for Pi as a whole. Built-in file
 * tools use permission-gate's trusted canonical-path checks; user Bash and
 * extension-owned effects remain outside this wrapper.
 */

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildProfile,
  canonical,
  classifyFailure,
  confine,
  DENIAL_MARKER,
  PLAN_DENIAL_MARKER,
  RUNNER_MARKER,
  SEATBELT_AVAILABLE,
  writableRoots,
} from "./lib/seatbelt";
import { getPermissionMode } from "./lib/permission-mode.ts";
import {
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
    description: sandboxActive
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
        return base.execute(toolCallId, { command: effectiveCommand, timeout }, signal, onUpdate, ctx);
      }

      const canonicalCwd = canonical(cwd);
      const mode = getPermissionMode();
      const roots = mode === "plan"
        ? []
        : writableRoots(canonicalCwd).filter(
            (root) => !isUnsafeWorkspaceRoot(canonicalCwd) || root !== canonicalCwd,
          );
      const profile = buildProfile(
        roots,
        sensitiveReadRules(canonicalCwd),
        protectedWriteRules(canonicalCwd),
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
              `${error.message}\n\n${mode === "plan" ? PLAN_DENIAL_MARKER : DENIAL_MARKER}\n[sandbox: denial is final for the agent; report the exact command to the user]`,
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
