import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("migration-mock", {
    api: "migration-mock",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture-only",
    models: [{
      id: "fixture", name: "Migration fixture", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter((m: any) => m.role === "user").at(-1);
      const text = typeof last?.content === "string" ? last.content
        : (last?.content ?? []).map((c: any) => c.text ?? "").join("");
      const message: any = {
        role: "assistant", api: "migration-mock", provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: "text", text: "fixture answer: " + text }],
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      };
      setTimeout(() => {
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      }, 120);
      return stream;
    },
  });
}
