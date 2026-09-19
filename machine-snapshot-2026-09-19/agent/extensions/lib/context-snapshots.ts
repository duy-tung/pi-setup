import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const RUNTIME_CONTEXT_TYPE = "runtime-context";
export const PERMISSION_MODE_CONTEXT_TYPE = "permission-mode-context";

type CustomLike = AgentMessage & { role?: string; customType?: string; content?: unknown };

/** Pure projection: keep history intact and never share mutable state across loaders. */
export function keepLatestContextSnapshots(messages: AgentMessage[]): AgentMessage[] {
  let latest = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as CustomLike;
    if (message.role === "custom" && message.customType === RUNTIME_CONTEXT_TYPE) latest = index;
  }
  return messages.filter((raw, index) => {
    const message = raw as CustomLike;
    if (message.role !== "custom") return true;
    // Preserve the transcript, but never reintroduce the retired approval policy.
    if (message.customType === PERMISSION_MODE_CONTEXT_TYPE) return false;
    return message.customType !== RUNTIME_CONTEXT_TYPE || index === latest;
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      !!item && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
}

/** Reinsert the caller's current snapshot when compaction removed its durable message. */
export function projectCurrentContextSnapshots(
  messages: AgentMessage[],
  currentSnapshot: string | null,
): AgentMessage[] {
  const projected = keepLatestContextSnapshots(messages);
  if (currentSnapshot === null) return projected;
  const existing = projected.find((raw) => {
    const message = raw as CustomLike;
    return message.role === "custom" && message.customType === RUNTIME_CONTEXT_TYPE;
  }) as CustomLike | undefined;
  if (existing && textOf(existing.content) === currentSnapshot) return projected;
  return [
    ...projected.filter((raw) => {
      const message = raw as CustomLike;
      return message.role !== "custom" || message.customType !== RUNTIME_CONTEXT_TYPE;
    }),
    {
      role: "custom",
      customType: RUNTIME_CONTEXT_TYPE,
      content: currentSnapshot,
      display: false,
      details: undefined,
      timestamp: 0,
    } as AgentMessage,
  ];
}
