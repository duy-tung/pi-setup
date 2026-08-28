/**
 * The single pre-execution policy owner for model tool calls.
 *
 * Credential hard-denies and canonical path identity are invariant. The active
 * permission mode then decides whether an operation runs, asks once, or blocks.
 * Bash confinement remains independently owned by sandbox-bash.ts.
 *
 * Auto follows Claude Code's permission model: rules in `Tool(specifier)` form
 * are sorted into deny > ask > allow, and anything unmatched asks once and
 * offers to remember the answer. The previous gate could only ask yes/no, so
 * the same question came back on every call — measured over this machine's
 * session history that was 394 of 400 write/edit calls, because a session
 * started in $HOME made every write look like a boundary crossing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isUnder, isTemporary, protectedWrite, resolvePolicyPath, sensitivePath } from "./lib/path-policy.ts";
import {
  getPermissionMode,
  isNoApprovalTool,
  permissionSubagentProfile,
} from "./lib/permission-mode.ts";
import {
  decideBash,
  decidePath,
  effectiveRules,
  isRememberable,
  rememberRule,
  suggestPathRule,
} from "./lib/permission-rules.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);

function blocked(reason: string) {
  return { block: true as const, reason };
}

function commandPaths(command: string): string[] {
  return command
    .split(/[\s'";|&$()<>]+/)
    .filter((token) => token && !token.startsWith("-") && !/[*?]/.test(token));
}

/**
 * The unit a remembered write approval is scoped to: the enclosing repository
 * if there is one, otherwise the containing directory. Approving "writes under
 * ~/repos/pi-setup" is a claim a user can actually evaluate; approving "writes
 * under $HOME" is not.
 */
function writeRoot(path: string): string {
  let current = dirname(path);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    // Ascend to the repository, not to $HOME: a bare directory high up is not a
    // scope a user can meaningfully approve.
    if (parent === current || current === homedir()) break;
    current = parent;
  }
  return dirname(path);
}

async function askOnce(
  ctx: any,
  what: string,
  detail: string,
  cwd: string,
  suggestion: string,
) {
  if (!ctx.hasUI || IS_SUBAGENT) {
    return blocked(
      `permission-gate: ${what} requires user approval, but no attended UI is available. `
        + "Do not retry or work around it; report the exact operation to the user.",
    );
  }

  const once = "Allow once";
  const always = suggestion ? `Always allow ${suggestion}` : "";
  const deny = "Deny";
  const options = always ? [once, always, deny] : [once, deny];
  // select() carries no message field, so the operation travels in the title.
  const choice = await ctx.ui.select(
    `permission-gate: ${what}\n\nWorking directory:\n${cwd}\n\nOperation:\n${detail}`,
    options,
  );

  if (choice === always) {
    rememberRule("allow", suggestion);
    return undefined;
  }
  if (choice === once) return undefined;
  // A dismissed dialog is not consent.
  return blocked(`permission-gate: user denied ${what}. Do not retry or work around it.`);
}

/** Always-ask authority: no remember option, however often it recurs. */
async function confirmEveryTime(ctx: any, what: string, detail: string, cwd: string) {
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
    const rules = effectiveRules();

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      for (const token of commandPaths(command)) {
        const resolved = resolvePolicyPath(token, cwd);
        const sensitive = sensitivePath(resolved.canonical);
        if (sensitive) {
          return blocked(`permission-gate: '${token}' resolves to ${sensitive.what}. Credential access is blocked.`);
        }
      }

      const decision = decideBash(rules, command);
      if (decision.tier === "deny") {
        return blocked(
          `permission-gate: blocked by rule ${decision.rule}. Ask the user to run it manually if required.`,
        );
      }
      if (mode === "plan") {
        return blocked("permission-gate: Bash is unavailable in Plan mode. Use dedicated read/search tools or ask the user to change mode.");
      }
      if (mode === "bypass") return;
      if (decision.tier === "ask") {
        // The suggestion is the matched rule itself so that remembering the
        // answer cancels exactly the rule that asked.
        return isRememberable(decision.rule)
          ? askOnce(ctx, `Bash matching ${decision.rule}`, command, workspace, decision.rule)
          : confirmEveryTime(ctx, `Bash matching ${decision.rule}`, command, workspace);
      }
      // An allow rule is the user's standing answer, so it holds everywhere
      // except Manual, whose entire purpose is to ask about every command.
      if (decision.tier === "allow" && mode !== "manual") return;
      // Manual and Accept-edits are deliberate ask-about-everything modes, and
      // offer no "always" option: a per-command prefix is far too fine-grained
      // to learn from (725 distinct ones across this machine's history).
      if (mode === "manual" || mode === "accept-edits") {
        return askOnce(ctx, "Bash command", command, workspace, "");
      }
      // Auto: unmatched commands run. The Seatbelt profile, not a prompt, is
      // what keeps them inside the workspace.
      return;
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

      const tool = event.toolName === "edit" ? "Edit" : "Write";
      const decision = decidePath(rules, tool, resolved.canonical);
      if (decision.tier === "deny") {
        return blocked(`permission-gate: writing ${resolved.canonical} is blocked by rule ${decision.rule}.`);
      }

      const protectedHit = protectedWrite(resolved.canonical, workspace);
      const detail = resolved.requested === resolved.canonical
        ? resolved.canonical
        : `${resolved.requested}\nresolves to: ${resolved.canonical}`;

      if (protectedHit) {
        if (mode === "bypass") {
          return blocked(
            `permission-gate: Bypass skips prompts but does not permit writing ${protectedHit.what}. `
              + "Ask the user to perform it directly if required.",
          );
        }
        return confirmEveryTime(ctx, protectedHit.what, detail, workspace);
      }

      // Claude Code treats the session's working directory as the workspace and
      // does not re-ask inside it; temp is likewise free. That is what removes
      // the old broad-root prompt on every write when a session starts in $HOME.
      const inside = isUnder(resolved.canonical, workspace) || isTemporary(resolved.canonical);
      const permitted = inside || decision.tier === "allow";
      const suggestion = suggestPathRule(tool, writeRoot(resolved.canonical));

      // Bypass suppresses prompts; it has never granted authority the user has
      // not given, so a write past the workspace edge stays a hard stop.
      if (mode === "bypass") {
        return permitted
          ? undefined
          : blocked(
              "permission-gate: Bypass skips prompts but does not permit writing outside the workspace. "
                + "Ask the user to perform it directly if required.",
            );
      }
      if (decision.tier === "ask") {
        return confirmEveryTime(ctx, `file change matching ${decision.rule}`, detail, workspace);
      }
      if (mode === "manual") return askOnce(ctx, "file change", detail, workspace, suggestion);
      if (permitted) return;
      return askOnce(ctx, "writing outside the workspace", detail, workspace, suggestion);
    }

    const delegation = workDelegation({ toolName: event.toolName, input: event.input as Record<string, unknown> });
    if (delegation) {
      if (!delegation.work) return;
      if (mode === "plan") {
        return blocked("permission-gate: work subagents are unavailable in Plan mode; use explore or web instead.");
      }
      if (mode === "manual" || mode === "accept-edits") {
        return confirmEveryTime(ctx, "mutation-capable work subagent", delegation.detail, workspace);
      }
      return;
    }

    if (isNoApprovalTool(event.toolName)) return;
    if (mode === "plan") {
      return blocked(`permission-gate: unknown tool '${event.toolName}' is unavailable in Plan mode because its side effects are not declared.`);
    }
    if (mode === "manual" || mode === "accept-edits") {
      return confirmEveryTime(ctx, `tool '${event.toolName}' with unknown side effects`, event.toolName, workspace);
    }
    // Auto preserves the setup's existing behavior; Bypass skips soft prompts.
  });
}
