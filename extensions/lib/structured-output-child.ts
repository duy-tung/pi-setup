/**
 * structured-output-child: loaded ONLY into sub-agent pi processes (via -e by
 * subagent.ts, never auto-discovered — lib/ has no index.ts).
 *
 * Ported from DeepSeek Harness (subagent-in-process-driver/structured.ts),
 * four pieces that only work together:
 *   1. a tool `structured_output` whose parameters ARE the real schema the
 *      parent asked for — no reliance on provider JSON mode;
 *   2. prompt guidance: only the tool call counts as the result;
 *   3. a monotonic guard: once the result is recorded, every further tool
 *      call is blocked — a captured result cannot be overwritten or followed
 *      by surprise side effects;
 *   4. commit = atomic file write (temp + rename); the parent's agent_wait
 *      treats a finished run without the file as an error, never re-prompts.
 *
 * Contract with subagent.ts:
 *   PI_STRUCTURED_SCHEMA  - path to a JSON Schema file (object-rooted)
 *   PI_STRUCTURED_RESULT  - path where the validated arguments are written
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	const schemaPath = process.env.PI_STRUCTURED_SCHEMA;
	const resultPath = process.env.PI_STRUCTURED_RESULT;
	if (!schemaPath || !resultPath) return; // not a structured-output run

	let schema: Record<string, unknown>;
	try {
		schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	} catch (err) {
		// Fail loud at load: a structured run without a schema is misconfigured.
		throw new Error(`structured-output-child: cannot read schema at ${schemaPath}: ${(err as Error).message}`);
	}

	let captured = false;

	pi.registerTool({
		name: "structured_output",
		label: "Structured output",
		description:
			"Deliver your final result as structured data matching the required schema. " +
			"Call this EXACTLY ONCE when your work is complete — this call is your deliverable; " +
			"prose in your reply is not a result. After this call every other tool is blocked, " +
			"so finish all other work first.",
		promptSnippet: "Deliver the final structured result (call exactly once, when done)",
		promptGuidelines: [
			"Your final deliverable is one structured_output call matching the required schema. Only that tool call counts as the result — a prose answer without it is a failed run.",
			"Call structured_output last: after it succeeds, all other tools are blocked.",
		],
		// The parent's JSON Schema is used verbatim as the tool parameters.
		parameters: schema as never,
		async execute(_toolCallId, params) {
			if (captured) {
				return {
					content: [{ type: "text", text: "structured_output was already recorded; the first result stands." }],
					isError: true,
					details: {},
				};
			}
			// Atomic commit: a crash mid-write must not leave a half-parseable file.
			const tmp = `${resultPath}.tmp`;
			writeFileSync(tmp, JSON.stringify(params, null, 2), { mode: 0o600 });
			renameSync(tmp, resultPath);
			captured = true;
			return {
				content: [
					{
						type: "text",
						text: "Result recorded. Do not call any more tools; finish your reply with a one-line confirmation.",
					},
				],
				details: {},
			};
		},
	});

	// Monotonic guard: once captured, no tool call whatsoever goes through.
	pi.on("tool_call", (e) => {
		if (!captured || e.toolName === "structured_output") return;
		return {
			block: true,
			reason:
				"structured_output has already been recorded — no further tool calls are allowed. Finish your reply now.",
		};
	});
}
