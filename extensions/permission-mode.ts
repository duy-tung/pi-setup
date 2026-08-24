import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  disabledToolsForPlanMode,
  getPermissionMode,
  hasRunningWorkSubagent,
  parsePermissionMode,
  resetPermissionMode,
  setPermissionMode,
  toolsForPlanMode,
  type PermissionMode,
} from "./lib/permission-mode.ts";
import { SEATBELT_AVAILABLE } from "./lib/seatbelt.ts";

const STATE_TYPE = "permission-mode-state";
const STATE_VERSION = 1;
const CONTEXT_TYPE = "permission-mode-context";
const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

type DurablePermissionMode = Exclude<PermissionMode, "bypass">;

type PersistedState = {
  version: 1;
  mode: DurablePermissionMode;
};

const MODE_UI: Record<PermissionMode, { label: string; description: string }> = {
  auto: {
    label: "Auto",
    description: "Pi policy handles low-risk permission decisions",
  },
  manual: {
    label: "Manual",
    description: "Always ask before a tool makes changes",
  },
  "accept-edits": {
    label: "Accept edits",
    description: "Accept workspace file edits; ask before Bash or broad delegation",
  },
  plan: {
    label: "Plan",
    description: "Read-only exploration and planning",
  },
  bypass: {
    label: "Bypass permissions",
    description: "Skip prompts this session; sandbox and credential guards remain",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedState(entries: readonly unknown[]): PersistedState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_TYPE || !isRecord(entry.data)) continue;
    const mode = parsePermissionMode(entry.data.mode);
    if (entry.data.version !== STATE_VERSION || !mode || mode === "bypass") continue;
    return { version: STATE_VERSION, mode };
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function lastModeContext(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
      return textOf(entry.content);
    }
  }
  return null;
}

function modeContext(mode: PermissionMode): string {
  const policy: Record<PermissionMode, string> = {
    auto:
      "Low-risk workspace edits and ordinary sandboxed Bash may run automatically. High-risk, destructive, protected, or outside operations require approval; credential access remains blocked.",
    manual:
      "Dedicated read-only tools may run automatically. Every file edit, every Bash call, and each mutation-capable delegation requires one user approval before it runs.",
    "accept-edits":
      "Ordinary edit/write calls inside the workspace run automatically. Every Bash call, protected/outside writes, unknown side-effect tools, and mutation-capable delegation still require approval.",
    plan:
      "This is enforced read-only planning mode. Explore and produce a concrete plan only. Bash/edit/write are unavailable, work subagents are blocked, and unknown side-effect tools are blocked.",
    bypass:
      "Approval prompts are skipped for this session. This does not disable safety boundaries: Bash remains workspace-confined, built-in writes outside/protected areas are blocked, and credential access remains blocked.",
  };
  return `Current permission mode: ${mode}. This supersedes earlier permission-mode context.\n\n${policy[mode]}`;
}

function styledStatus(ctx: ExtensionContext, mode: PermissionMode): string {
  const raw: Record<PermissionMode, string> = {
    auto: "◆ auto",
    manual: "◆ manual",
    "accept-edits": "✓ accept edits",
    plan: "⏸ plan",
    bypass: "⚠ BYPASS",
  };
  const color: Record<PermissionMode, "muted" | "warning" | "success" | "accent" | "error"> = {
    auto: "muted",
    manual: "warning",
    "accept-edits": "success",
    plan: "accent",
    bypass: "error",
  };
  try {
    return ctx.ui.theme.fg(color[mode], raw[mode]);
  } catch {
    return raw[mode];
  }
}

function updateStatus(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus("permission-mode", styledStatus(ctx, getPermissionMode()));
}

function modeFromArgument(raw: string): PermissionMode | undefined {
  const value = raw.trim().toLowerCase();
  const aliases: Record<string, PermissionMode> = {
    auto: "auto",
    manual: "manual",
    accept: "accept-edits",
    edits: "accept-edits",
    "accept-edits": "accept-edits",
    plan: "plan",
    bypass: "bypass",
  };
  return aliases[value];
}

async function selectMode(ctx: ExtensionContext): Promise<PermissionMode | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Permission mode: ${getPermissionMode()}. Usage: /mode ${PERMISSION_MODES.join("|")}`, "info");
    return undefined;
  }
  const active = getPermissionMode();
  const items: SelectItem[] = PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: `${mode === active ? "✓ " : "  "}${MODE_UI[mode].label}${mode === DEFAULT_PERMISSION_MODE ? "  Default" : ""}`,
    description: MODE_UI[mode].description,
  }));

  const selected = await ctx.ui.custom<string | null>((tui, theme: Theme, _keybindings, done) => {
    const container = new Container();
    const list = new SelectList(items, items.length, {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    list.onSelect = (item: SelectItem) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Mode")), 1, 0));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "1–5 select · ↑↓ navigate · enter confirm · esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (/^[1-5]$/.test(data)) {
          done(items[Number(data) - 1]?.value ?? null);
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return parsePermissionMode(selected ?? undefined);
}

export default function permissionModeExtension(pi: ExtensionAPI): void {
  let planDisabledTools: string[] = [];
  let lastEmitted: string | null = null;

  function appendState(mode: DurablePermissionMode): void {
    pi.appendEntry(STATE_TYPE, { version: STATE_VERSION, mode } satisfies PersistedState);
  }

  function enterPlanProjection(): void {
    const active = pi.getActiveTools();
    planDisabledTools = disabledToolsForPlanMode(active);
    pi.setActiveTools(toolsForPlanMode(active));
  }

  function leavePlanProjection(): void {
    if (planDisabledTools.length === 0) return;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const restored = [...pi.getActiveTools()];
    for (const name of planDisabledTools) {
      if (available.has(name) && !restored.includes(name)) restored.push(name);
    }
    pi.setActiveTools(restored);
    planDisabledTools = [];
  }

  function restoreBranchMode(ctx: ExtensionContext, preserveTransientBypass: boolean): void {
    const branch = ctx.sessionManager.getBranch();
    lastEmitted = lastModeContext(branch);
    if (preserveTransientBypass && getPermissionMode() === "bypass") {
      updateStatus(ctx);
      return;
    }

    const target = IS_SUBAGENT
      ? DEFAULT_PERMISSION_MODE
      : (persistedState(branch)?.mode ?? DEFAULT_PERMISSION_MODE);
    const previous = getPermissionMode();
    if (target !== previous && hasRunningWorkSubagent()) {
      ctx.ui.notify(
        `The selected conversation branch uses ${target}, but a work subagent is still running; permission mode remains ${previous}.`,
        "warning",
      );
      updateStatus(ctx);
      return;
    }
    if (previous === "plan" && target !== "plan") leavePlanProjection();
    if (previous !== "plan" && target === "plan") enterPlanProjection();
    resetPermissionMode(target);
    updateStatus(ctx);
  }

  async function changeMode(target: PermissionMode, ctx: ExtensionContext): Promise<void> {
    const previous = getPermissionMode();
    if (target === previous) {
      ctx.ui.notify(`Permission mode is already ${target}.`, "info");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to settle before changing permission mode.", "warning");
      return;
    }
    if (hasRunningWorkSubagent()) {
      ctx.ui.notify("A work subagent is still running. Wait for it or interrupt it before changing permission mode.", "warning");
      return;
    }
    if (target === "bypass") {
      if (!SEATBELT_AVAILABLE) {
        ctx.ui.notify("Bypass is unavailable because macOS Seatbelt is not active.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Bypass requires an attended confirmation UI.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Enable Bypass permissions?",
        "Approval prompts will be skipped for this session.\n\nSeatbelt workspace confinement, protected/outside write blocking, and credential hard-denies remain active. Bypass resets to Auto on reload, resume, or a new session.",
      );
      if (!confirmed) return;
      if (!ctx.isIdle() || hasRunningWorkSubagent()) {
        ctx.ui.notify("Runtime activity changed while the confirmation was open; mode was not changed.", "warning");
        return;
      }
    }

    const activeBefore = pi.getActiveTools();
    const previousDisabled = [...planDisabledTools];
    try {
      if (previous === "plan") leavePlanProjection();
      if (target === "plan") enterPlanProjection();

      // Bypass is intentionally transient. Its durable reset point is always Auto.
      appendState(target === "bypass" ? DEFAULT_PERMISSION_MODE : target);
      setPermissionMode(target);
    } catch (error) {
      planDisabledTools = previousDisabled;
      setPermissionMode(previous);
      try {
        pi.setActiveTools(activeBefore);
      } catch {
        // The original mode remains authoritative even if tool restoration fails.
      }
      throw error;
    }

    updateStatus(ctx);
    ctx.ui.notify(
      target === "bypass"
        ? "Bypass enabled for this session; sandbox and credential guards remain active."
        : `Permission mode changed to ${target}.`,
      target === "bypass" ? "warning" : "info",
    );
  }

  async function handleMode(raw: string, ctx: ExtensionContext): Promise<void> {
    if (IS_SUBAGENT) {
      ctx.ui.notify("Permission mode is fixed by the parent for this subagent activation.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to settle before changing permission mode.", "warning");
      return;
    }
    const target = raw.trim() ? modeFromArgument(raw) : await selectMode(ctx);
    if (!target) {
      if (raw.trim()) ctx.ui.notify(`Unknown mode '${raw.trim()}'. Use auto, manual, accept-edits, plan, or bypass.`, "warning");
      return;
    }
    await changeMode(target, ctx);
  }

  pi.registerCommand("mode", {
    description: "Select Auto, Manual, Accept edits, Plan, or transient Bypass permissions",
    getArgumentCompletions: (prefix) => PERMISSION_MODES
      .filter((mode) => mode.startsWith(prefix.toLowerCase()))
      .map((mode) => ({ value: mode, label: mode, description: MODE_UI[mode].description })),
    handler: handleMode,
  });

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Open permission mode selector",
    handler: async (ctx) => handleMode("", ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    planDisabledTools = [];
    resetPermissionMode(DEFAULT_PERMISSION_MODE);
    restoreBranchMode(ctx, false);
  });

  pi.on("session_before_tree", (_event, ctx) => {
    if (!hasRunningWorkSubagent()) return;
    ctx.ui.notify("Conversation navigation is blocked while a work subagent is starting or running; wait or interrupt it first.", "warning");
    return { cancel: true };
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreBranchMode(ctx, true);
  });

  pi.on("session_shutdown", () => {
    if (getPermissionMode() === "plan") leavePlanProjection();
  });

  pi.on("before_agent_start", () => {
    const content = modeContext(getPermissionMode());
    if (content === lastEmitted) return;
    lastEmitted = content;
    return {
      message: {
        customType: CONTEXT_TYPE,
        content,
        display: false,
        details: undefined,
      },
    };
  });
}
