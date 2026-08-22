/**
 * Best-effort redaction of known credential shapes from final text tool results.
 *
 * Pre-execution path/command decisions live in permission-gate.ts. This hook
 * transforms final text before it enters the session/model path, but it is not
 * DLP: raw streaming/temp output, binary/image data, unknown formats, and user
 * Bash are outside its coverage. spill.ts uses the same pattern source.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redact } from "./lib/redact";

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event, ctx) => {
    const hits: string[] = [];
    let changed = false;

    const content = event.content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      const result = redact(part.text);
      if (result.text === part.text) return part;
      changed = true;
      for (const hit of result.hits) if (!hits.includes(hit)) hits.push(hit);
      return { ...part, text: result.text };
    });

    if (!changed) return;
    ctx.ui?.notify?.(`secret-guard: redacted ${hits.join(", ")} from ${event.toolName} output`, "warning");
    return { content };
  });
}
