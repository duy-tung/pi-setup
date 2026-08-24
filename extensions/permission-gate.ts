/**
 * The single pre-execution policy owner for model tool calls.
 *
 * Credential hard-denies and canonical path identity are invariant. The active
 * permission mode then decides whether an operation runs, asks once, or blocks.
 * Bash confinement remains independently owned by sandbox-bash.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isUnder, isTemporary, isUnsafeWorkspaceRoot, protectedWrite, resolvePolicyPath, sensitivePath } from "./lib/path-policy.ts";
import {
  getPermissionMode,
  isNoApprovalTool,
  permissionSubagentProfile,
} from "./lib/permission-mode.ts";

/** Bash commands that pause in Auto. First match wins. */
export const CONFIRM_CMD: { id: string; re: RegExp; what: string }[] = [
  { id: "sudo", re: /\bsudo\b/, what: "sudo (root privileges)" },
  {
    id: "rm-recursive-force",
    re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]|\brm\s+.*--(force|recursive)\b/,
    what: "rm with -r/-f (recursive/forced delete)",
  },
  { id: "find-delete", re: /\bfind\b[^\n|;]*\s-delete\b/, what: "find -delete (bulk delete)" },
  { id: "xargs-rm", re: /\bxargs\b[^\n|;]*\brm\b/, what: "xargs rm (bulk delete)" },
  {
    id: "git-destructive",
    re: /\bgit\s+(push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b|--delete\b|\s:\S)|reset\s+--hard\b|clean\s+(-[a-zA-Z]*f|--force)|branch\s+(-D\b|--delete\s+--force))/,
    what: "destructive git (force-push, hard reset, clean, branch -D)",
  },
  {
    id: "disk-destroyer",
    re: /\bdd\b[^\n|;]*\bof=|\b(mkfs|diskutil\s+(erase\w*|partitionDisk)|shred)\b/,
    what: "raw disk write / erase",
  },
  {
    id: "recursive-perms",
    re: /\b(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*\b|--recursive\b)/,
    what: "recursive chmod/chown",
  },
  {
    id: "pipe-to-shell",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?\S*(sh|bash|zsh)\b/,
    what: "piping a download into a shell",
  },
  { id: "power", re: /\b(shutdown|reboot|halt)\b/, what: "shutdown/reboot" },
  { id: "publish", re: /\b(npm|pnpm|yarn)\s+publish\b/, what: "package publish (public, irreversible)" },
];

const DENY_CMD: { re: RegExp; what: string }[] = [
  { re: /\bgh\s+auth\s+token\b/, what: "GitHub authentication token" },
  { re: /\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)\b/, what: "macOS keychain dump" },
  { re: /\bpass\s+show\b/, what: "pass secret store" },
  { re: /\bop\s+(read|item\s+get)\b/, what: "1Password secret read" },
];

const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);

function commandPaths(command: string): string[] {
  return command
    .split(/[\s'";|&$()<>]+/)
    .filter((token) => token && !token.startsWith("-") && !/[*?]/.test(token));
}

function blocked(reason: string) {
  return { block: true as const, reason };
}

async function confirmOnce(ctx: any, what: string, detail: string, cwd: string) {
  if (!ctx.hasUI || IS_SUBAGENT) {
    return blocked(
      `permission-gate: ${what} requires user approval, but no attended UI is available. `
        + "Do not retry or work around it; report the exact operation to the user.",
    );
  }
  const approved = await ctx.ui.confirm(
    `permission-gate: ${what}`,
    `Working directory:\n${cwd}\n\nOperation:\n${detail}\n\nAllow this operation once?`,
  );
  return approved
    ? undefined
    : blocked(`permission-gate: user denied ${what}. Do not retry or work around it.`);
}

function workDelegation(event: { toolName: string; input: Record<string, unknown> }): { work: boolean; detail: string } | undefined {
  if (event.toolName === "subagent") {
    const profile = event.input.profile;
    if (profile !== "work") return { work: false, detail: "" };
    const description = typeof event.input.description === "string" ? event.input.description.trim() : "delegated task";
    return { work: true, detail: `work subagent activation: ${description.slice(0, 300)}` };
  }
  if (event.toolName === "send_message") {
    const id = typeof event.input.subagent_id === "string" ? event.input.subagent_id : "";
    return {
      work: Boolean(id && permissionSubagentProfile(id) === "work"),
      detail: `resume/queue work subagent: ${id || "unknown id"}`,
    };
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const workspace = resolvePolicyPath(cwd, cwd).canonical;
    const mode = getPermissionMode();

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      const denied = DENY_CMD.find((rule) => rule.re.test(command));
      if (denied) {
        return blocked(`permission-gate: blocked ${denied.what}. Ask the user to run it manually if required.`);
      }
      for (const token of commandPaths(command)) {
        const resolved = resolvePolicyPath(token, cwd);
        const sensitive = sensitivePath(resolved.canonical);
        if (sensitive) {
          return blocked(`permission-gate: '${token}' resolves to ${sensitive.what}. Credential access is blocked.`);
        }
      }
      if (mode === "plan") {
        return blocked("permission-gate: Bash is unavailable in Plan mode. Use dedicated read/search tools or ask the user to change mode.");
      }
      if (mode === "bypass") return;
      const dangerous = CONFIRM_CMD.find((rule) => rule.re.test(command));
      if (mode === "manual" || mode === "accept-edits") {
        return confirmOnce(ctx, dangerous?.what ?? "Bash command", command, workspace);
      }
      return dangerous ? confirmOnce(ctx, dangerous.what, command, workspace) : undefined;
    }

    if (PATH_TOOLS.has(event.toolName)) {
      const input = event.input as { path?: string };
      if (typeof input.path !== "string" || input.path.length === 0) return;

      const resolved = resolvePolicyPath(input.path, cwd);
      const sensitive = sensitivePath(resolved.canonical);
      if (sensitive) {
        return blocked(
          `permission-gate: '${input.path}' resolves to ${sensitive.what}. `
            + "Read/write/edit access is blocked; ask the user to handle it manually if required.",
        );
      }

      // Execute the identity that was checked rather than following an unchecked alias.
      input.path = resolved.canonical;
      if (!MUTATING_TOOLS.has(event.toolName)) return;
      if (mode === "plan") {
        return blocked(`permission-gate: ${event.toolName} is unavailable in Plan mode. Ask the user to change mode before modifying files.`);
      }

      const protectedHit = protectedWrite(resolved.canonical, workspace);
      const outside = !isUnder(resolved.canonical, workspace) && !isTemporary(resolved.canonical);
      const broadRoot = isUnsafeWorkspaceRoot(workspace) && !isTemporary(resolved.canonical);
      const boundary = protectedHit || outside || broadRoot;
      const what = protectedHit?.what ?? (broadRoot ? "writing from a broad workspace root" : outside ? "writing outside the workspace" : "file change");
      const detail = resolved.requested === resolved.canonical
        ? resolved.canonical
        : `${resolved.requested}\nresolves to: ${resolved.canonical}`;

      if (mode === "bypass") {
        return boundary
          ? blocked(`permission-gate: Bypass skips prompts but does not permit ${what}. Ask the user to perform it directly if required.`)
          : undefined;
      }
      if (mode === "manual") return confirmOnce(ctx, what, detail, workspace);
      return boundary ? confirmOnce(ctx, what, detail, workspace) : undefined;
    }

    const delegation = workDelegation({ toolName: event.toolName, input: event.input as Record<string, unknown> });
    if (delegation) {
      if (!delegation.work) return;
      if (mode === "plan") {
        return blocked("permission-gate: work subagents are unavailable in Plan mode; use explore or web instead.");
      }
      if (mode === "manual" || mode === "accept-edits") {
        return confirmOnce(ctx, "mutation-capable work subagent", delegation.detail, workspace);
      }
      return;
    }

    if (isNoApprovalTool(event.toolName)) return;
    if (mode === "plan") {
      return blocked(`permission-gate: unknown tool '${event.toolName}' is unavailable in Plan mode because its side effects are not declared.`);
    }
    if (mode === "manual" || mode === "accept-edits") {
      return confirmOnce(ctx, `tool '${event.toolName}' with unknown side effects`, event.toolName, workspace);
    }
    // Auto preserves the setup's existing behavior; Bypass skips soft prompts.
  });
}
