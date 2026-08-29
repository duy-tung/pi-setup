export const PERMISSION_MODES = ["auto", "manual", "accept-edits", "plan", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionSubagentProfile = "explore" | "web" | "work";

export const DEFAULT_PERMISSION_MODE = "auto" satisfies PermissionMode;

/**
 * Tools that never need a gate. Every name here is a standing pre-approval, so
 * it must name a tool that exists and has been reviewed; a name for a tool
 * nobody has seen yet would approve whatever later claims it.
 */
const NO_APPROVAL_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_user",
  "web_search",
  "resolve-library-id",
  "query-docs",
  "todowrite",
  "create_goal",
  "get_goal",
  "update_goal",
  "list_agents",
  "interrupt_agent",
]);

const PLAN_DISABLED_TOOLS = new Set(["bash", "edit", "write"]);

let currentMode: PermissionMode = DEFAULT_PERMISSION_MODE;
const subagentProfiles = new Map<string, PermissionSubagentProfile>();
const runningWorkSubagents = new Set<string>();

export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value)
    ? value as PermissionMode
    : undefined;
}

export function getPermissionMode(): PermissionMode {
  return currentMode;
}

export function setPermissionMode(mode: PermissionMode): void {
  currentMode = mode;
}

export function resetPermissionMode(mode: PermissionMode = DEFAULT_PERMISSION_MODE): void {
  currentMode = mode;
}

export function isNoApprovalTool(toolName: string): boolean {
  return NO_APPROVAL_TOOLS.has(toolName);
}

export function toolsForPlanMode(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => !PLAN_DISABLED_TOOLS.has(name));
}

export function disabledToolsForPlanMode(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => PLAN_DISABLED_TOOLS.has(name));
}

export function rememberPermissionSubagent(id: string, profile: PermissionSubagentProfile): void {
  subagentProfiles.set(id, profile);
}

export function permissionSubagentProfile(id: string): PermissionSubagentProfile | undefined {
  return subagentProfiles.get(id);
}

export function clearPermissionSubagents(): void {
  subagentProfiles.clear();
}

export function markWorkSubagentRunning(id: string, running: boolean): void {
  if (running) runningWorkSubagents.add(id);
  else runningWorkSubagents.delete(id);
}

export function hasRunningWorkSubagent(): boolean {
  return runningWorkSubagents.size > 0;
}

/** Test/session-reset helper; production session code normally uses the narrower resets above. */
export function resetPermissionRuntime(mode: PermissionMode = DEFAULT_PERMISSION_MODE): void {
  currentMode = mode;
  subagentProfiles.clear();
  runningWorkSubagents.clear();
}
