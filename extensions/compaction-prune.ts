/**
 * compaction-prune: shrink oversized tool output before the summarizer sees it.
 *
 * Ported from DeepSeek Harness (compaction-tool-result-pruner): a deterministic,
 * model-free rewrite that runs BEFORE the compaction LLM call. pi's
 * generateSummary serializes the entire to-summarize region into one prompt
 * with no size cap (core/compaction/compaction.js:471-516), so a stale 50 KiB
 * `read` result (spill deliberately skips reads) rides into the summarizer
 * verbatim — slow, expensive, and it drowns the signal the summary needs.
 *
 * Rule (DSH numbers): any text block over 8192 chars in a message headed for
 * summarization becomes head 4096 + "[... middle pruned ...]" + tail 1024.
 * Output is always smaller than the threshold, so a second pass is a no-op
 * (idempotent by construction). Only summarizer INPUT shrinks — the messages
 * are discarded after compaction anyway, kept context is untouched, and the
 * session file keeps the originals forever.
 *
 * Mechanics: core reuses the same `preparation` object after the
 * session_before_compact event (AgentSession.compact/_runAutoCompaction, verified v0.84.4;
 * the 0.84.4 mid-run threshold path funnels into _runAutoCompaction, same hook),
 * so in-place mutation of the preparation arrays is honored. The message
 * objects themselves are SHARED with the live session, so pruning replaces
 * array elements with shallow copies and never mutates an original — an
 * aborted compaction must leave the session untouched.
 *
 * Bonus over DSH: also prunes `bashExecution` messages (output of `!`
 * commands), a pi-specific message type with the same unbounded-size problem.
 *
 * session_compact adds DSH's "reject summary that is not smaller" guard in
 * advisory form (pi appends the compaction before we see it, so no veto):
 * a summary estimated at >= tokensBefore triggers a warning notification.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const THRESHOLD_CHARS = 8192;
export const HEAD_CHARS = 4096;
export const TAIL_CHARS = 1024;

export function pruneText(text: string): string {
	if (text.length <= THRESHOLD_CHARS) return text;
	const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
	return (
		text.slice(0, HEAD_CHARS) +
		`\n[... tool result middle pruned for summarization: ${omitted} chars omitted ...]\n` +
		text.slice(-TAIL_CHARS)
	);
}

/**
 * Prune one preparation message list IN PLACE (array elements are replaced
 * with shallow copies; original message objects are never mutated).
 * Returns stats for observability.
 */
export function pruneMessages(messages: unknown[]): { messages: number; savedChars: number } {
	let pruned = 0;
	let savedChars = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as {
			role?: string;
			content?: unknown;
			output?: string;
		};

		if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
			let changed = false;
			const content = msg.content.map((block: { type?: string; text?: string }) => {
				if (block?.type !== "text" || typeof block.text !== "string") return block;
				const next = pruneText(block.text);
				if (next === block.text) return block;
				changed = true;
				savedChars += block.text.length - next.length;
				return { ...block, text: next };
			});
			if (changed) {
				messages[i] = { ...msg, content };
				pruned++;
			}
		} else if (msg?.role === "bashExecution" && typeof msg.output === "string") {
			const next = pruneText(msg.output);
			if (next !== msg.output) {
				savedChars += msg.output.length - next.length;
				messages[i] = { ...msg, output: next };
				pruned++;
			}
		}
	}

	return { messages: pruned, savedChars };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", (e) => {
		const a = pruneMessages(e.preparation.messagesToSummarize);
		const b = pruneMessages(e.preparation.turnPrefixMessages);
		const messages = a.messages + b.messages;
		const savedChars = a.savedChars + b.savedChars;
		if (messages > 0) {
			// Durable, TUI-only evidence that pruning ran; not part of LLM context.
			pi.appendEntry("compaction-prune", { messages, savedChars, reason: e.reason });
		}
		// No return: core proceeds with the (now smaller) preparation.
	});

	pi.on("session_compact", (e, ctx) => {
		// Advisory not-smaller guard: chars/4 mirrors core's estimateTokens heuristic.
		const summaryTokens = Math.ceil(e.compactionEntry.summary.length / 4);
		const before = e.compactionEntry.tokensBefore;
		if (before > 0 && summaryTokens >= before) {
			ctx.ui?.notify?.(
				`compaction-prune: summary (~${summaryTokens} tokens) is not smaller than what it replaced (${before}); context did not shrink`,
				"warning",
			);
		}
	});
}
