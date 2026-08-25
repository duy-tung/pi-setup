import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_CONTEXT_TYPE = "runtime-context";
export const PERMISSION_MODE_CONTEXT_TYPE = "permission-mode-context";
const SNAPSHOT_TYPES = new Set([RUNTIME_CONTEXT_TYPE, PERMISSION_MODE_CONTEXT_TYPE]);
const currentSnapshots = new Map<string, string>();

type CustomLike = AgentMessage & { role?: string; customType?: string; content?: unknown };

/** Keep event-sourced history intact while projecting only each newest snapshot to the model. */
export function keepLatestContextSnapshots(messages: AgentMessage[]): AgentMessage[] {
  const latest = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as CustomLike;
    if (message.role === "custom" && message.customType && SNAPSHOT_TYPES.has(message.customType)) {
      latest.set(message.customType, index);
    }
  }
  return messages.filter((raw, index) => {
    const message = raw as CustomLike;
    return message.role !== "custom"
      || !message.customType
      || !SNAPSHOT_TYPES.has(message.customType)
      || latest.get(message.customType) === index;
  });
}

export function setCurrentContextSnapshot(customType: string, content: string | null): void {
  if (!SNAPSHOT_TYPES.has(customType)) throw new Error(`unsupported context snapshot type: ${customType}`);
  if (content === null) currentSnapshots.delete(customType);
  else currentSnapshots.set(customType, content);
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

/** Reinsert current process state when compaction has cut all durable snapshots. */
export function projectCurrentContextSnapshots(messages: AgentMessage[]): AgentMessage[] {
  let projected = keepLatestContextSnapshots(messages);
  for (const customType of [RUNTIME_CONTEXT_TYPE, PERMISSION_MODE_CONTEXT_TYPE]) {
    const current = currentSnapshots.get(customType);
    if (current === undefined) continue;
    const existing = projected.find((raw) => {
      const message = raw as CustomLike;
      return message.role === "custom" && message.customType === customType;
    }) as CustomLike | undefined;
    if (existing && textOf(existing.content) === current) continue;
    projected = projected.filter((raw) => {
      const message = raw as CustomLike;
      return message.role !== "custom" || message.customType !== customType;
    });
    projected.push({
      role: "custom",
      customType,
      content: current,
      display: false,
      details: undefined,
      timestamp: 0,
    } as AgentMessage);
  }
  return projected;
}

export default function contextSnapshots(pi: ExtensionAPI): void {
  pi.on("context", (event) => ({ messages: projectCurrentContextSnapshots(event.messages) }));
}
