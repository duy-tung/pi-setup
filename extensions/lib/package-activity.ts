import { randomUUID } from "node:crypto";

interface Bus {
  emit(name: string, data: unknown): void;
  on(name: string, listener: (data: any) => void): () => void;
}

/** A restore-time query, not a second job manager. Unknown state blocks restore. */
export async function packageRestoreBlocker(events: Bus, timeoutMs = 1000): Promise<string | null> {
  let agents: boolean | undefined;
  events.emit("pi-setup:subagents:activity", {
    reply: (result: { active?: unknown }) => {
      if (typeof result?.active === "boolean") agents = result.active;
    },
  });
  if (agents === undefined) return "Subagent activity is unavailable; check the package patch before rewinding.";
  if (agents) return "Agents or workflows are still running/queued. Wait or stop them in /agents before rewinding.";

  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (message: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    };
    const unsubscribe = events.on("pi-background-tasks:response:v1", (response) => {
      if (response?.request_id !== requestId) return;
      if (!response.ok || !Array.isArray(response.result?.tasks)) {
        finish("Background task state is unavailable; retry after the package is ready.");
      } else if (response.result.tasks.some((task: any) => task.status === "running")) {
        finish("Background jobs are still running. Wait or stop them in /jobs before rewinding.");
      } else {
        // A scheduled agent may have started while the async job query ran.
        let active: boolean | undefined;
        events.emit("pi-setup:subagents:activity", { reply: (r: any) => { active = r?.active; } });
        finish(active === false ? null : "Agent activity changed; wait for agents to finish before rewinding.");
      }
    });
    const timer = setTimeout(() => finish("Background task state timed out; retry before rewinding."), timeoutMs);
    events.emit("pi-background-tasks:request:v1", {
      schema_version: "pi-background-tasks.extension-request.v1",
      request_id: requestId,
      operation: "status",
      payload: {},
    });
  });
}
