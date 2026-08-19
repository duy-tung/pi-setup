/**
 * repeat-reminder: advisory loop-breaker for identical repeated tool calls.
 *
 * Ported from DeepSeek Harness (packages/guard/repeat-tool-reminder): count
 * consecutive calls of the same tool with canonically-identical arguments and,
 * at escalating thresholds (3, 5, 8), append a <system-reminder> to the tool
 * result telling the model to stop and reconsider. Never a veto — the decision
 * stays with the model; this only makes the loop visible to it.
 *
 * DSH details kept on purpose:
 *   - arguments are canonicalized (deep key sort) so key order noise does not
 *     break the chain, and capped so huge args stay cheap to compare;
 *   - counting happens post-execution, so blocked/failed calls count too;
 *   - state is in-memory only and resets on real user input — a human message
 *     is what legitimately breaks a loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SIGNATURE_CAP = 500;

const REMINDERS: Record<number, string> = {
	3: "You have made this exact tool call with identical arguments 3 times in a row. Re-read the previous results before repeating a call — the answer may already be there.",
	5: "This is the 5th identical call in a row. Repeating it again will not produce a different result; change the arguments or take a different approach.",
	8: "This is the 8th identical call in a row. Stop repeating this call. Conclude from what you already have, or ask the user how to proceed.",
};

function deepSort(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(deepSort);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = deepSort((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export default function (pi: ExtensionAPI) {
	let lastSignature: string | null = null;
	let runLength = 0;

	const reset = () => {
		lastSignature = null;
		runLength = 0;
	};

	pi.on("session_start", reset);
	pi.on("input", () => {
		reset();
	});

	pi.on("tool_result", (e) => {
		let signature: string;
		try {
			signature = `${e.toolName} ${JSON.stringify(deepSort(e.input))}`.slice(0, SIGNATURE_CAP);
		} catch {
			return; // unserializable args — skip counting rather than crash the chain
		}

		runLength = signature === lastSignature ? runLength + 1 : 1;
		lastSignature = signature;

		const reminder = REMINDERS[runLength];
		if (!reminder) return;

		return {
			content: [
				...e.content,
				{ type: "text" as const, text: `\n<system-reminder>${reminder}</system-reminder>` },
			],
		};
	});
}
