/**
 * ask-user: structured questions for the human, DSH's ask_user_question for pi.
 *
 * The model calls ask_user when it hits a decision that belongs to the human:
 * scope, trade-offs, preferences, anything where guessing would bake an
 * assumption into the work. Schema and answer shape follow DeepSeek Harness
 * (interaction/tool-ask-user):
 *
 *   questions: [{ id, question, header?, multi_select?, options?[{label, description?}] }]
 *   result:    { answers: [{ id, selected: string[], custom?: string }] }
 *
 * Semantics ported from DSH:
 *   - `id` is stable and echoed back, so the model maps answers with certainty
 *     instead of matching question prose;
 *   - recommended option = first in the list with "(Recommended)" appended to
 *     its label (a convention taught in the schema, not a boolean);
 *   - single-select: a typed answer OVERRIDES the options (selected stays []);
 *     multi-select: a typed answer is ADDED alongside the toggled options;
 *   - skip/cancel yields selected: [] with no custom — an explicit non-answer.
 *
 * Multi-select is emulated with a toggle loop over ctx.ui.select because pi's
 * ExtensionUIContext has no native multi-select dialog.
 *
 * Non-interactive runs (print mode, subagents) have no dialog UI; the tool
 * errors with instructions to proceed with the recommended option or surface
 * the question in the report.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Sub-agent panes have a UI nobody watches — treat them as non-interactive. */
const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

const FREE_TEXT = "✏️  Type a different answer";
const ADD_TEXT = "✏️  Add a typed answer";
const DONE = "✅ Done with this question";
const SKIP = "⏭  Skip this question";

interface Answer {
	id: string;
	selected: string[];
	custom?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one or more structured questions and wait for their answers. " +
			"Use for decisions that are the user's to make: scope, trade-offs, preferences, ambiguous requirements. " +
			"Each question carries a stable id that is echoed back in its answer. " +
			"Returns JSON { answers: [{ id, selected, custom? }] }: selected holds chosen option labels " +
			"(empty when skipped), custom holds a typed answer — it replaces the options for single-select " +
			"and supplements them for multi-select. " +
			"Do not use for facts you can find yourself by reading files or searching.",
		promptSnippet: "Ask the user structured questions when a decision is theirs to make",
		promptGuidelines: [
			"Use ask_user before committing to a choice that materially affects the outcome when the user's preference is unknown — present concrete options with one recommended, instead of assuming silently.",
			"Facts are your job, decisions are the user's: never ask_user for anything you can determine by reading files, running commands, or searching.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String({
						description: "Stable id for this question; echoed in the answer.",
					}),
					header: Type.Optional(
						Type.String({ description: "Short topic label shown above the question, e.g. 'Install scope'" }),
					),
					question: Type.String({ description: "The specific question to ask the user" }),
					multi_select: Type.Optional(
						Type.Boolean({ description: "Whether the user may select more than one option. Defaults to false." }),
					),
					options: Type.Optional(
						Type.Array(
							Type.Object({
								label: Type.String({ description: "Short user-facing option label" }),
								description: Type.Optional(
									Type.String({ description: "One sentence explaining the tradeoff or impact" }),
								),
							}),
							{
								minItems: 2,
								maxItems: 6,
								description:
									"Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label. Omit for a free-text question.",
							},
						),
					),
				}),
				{ minItems: 1, maxItems: 4, description: "Questions to ask, 1-4" },
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI || IS_SUBAGENT) {
				return {
					content: [
						{
							type: "text",
							text:
								"ask_user unavailable: this run is non-interactive. Proceed with the recommended option " +
								"if one exists and note the assumption; otherwise state the open question in your report.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const answers: Answer[] = [];

			for (const [i, q] of params.questions.entries()) {
				if (signal?.aborted) break;

				const n = params.questions.length > 1 ? ` (${i + 1}/${params.questions.length})` : "";
				const title = `${q.header ? `[${q.header}] ` : ""}${q.question}${n}`;
				const answer: Answer = { id: q.id, selected: [] };
				const labels = (q.options ?? []).map((o) => o.label);
				const row = (label: string, marked?: boolean) => {
					const desc = q.options?.find((o) => o.label === label)?.description;
					const mark = marked === undefined ? "" : marked ? "[x] " : "[ ] ";
					return `${mark}${label}${desc ? ` — ${desc}` : ""}`;
				};

				if (labels.length === 0) {
					// Free-text question: no options were provided.
					const typed = await ctx.ui.input(title, "your answer");
					if (typed?.trim()) answer.custom = typed.trim();
				} else if (q.multi_select) {
					// Toggle loop: select flips one entry per round until Done/Skip.
					const picked = new Set<string>();
					for (;;) {
						if (signal?.aborted) break;
						const rows = labels.map((l) => row(l, picked.has(l)));
						rows.push(ADD_TEXT, DONE, SKIP);
						const choice = await ctx.ui.select(title, rows);
						if (choice === undefined || choice === SKIP) {
							picked.clear();
							delete answer.custom;
							break;
						}
						if (choice === DONE) break;
						if (choice === ADD_TEXT) {
							const typed = await ctx.ui.input(q.question, "additional answer");
							if (typed?.trim()) answer.custom = typed.trim();
							continue;
						}
						const label = labels.find((l) => row(l, picked.has(l)) === choice);
						if (label) picked.has(label) ? picked.delete(label) : picked.add(label);
					}
					answer.selected = labels.filter((l) => picked.has(l));
				} else {
					const rows = labels.map((l) => row(l));
					rows.push(FREE_TEXT, SKIP);
					const choice = await ctx.ui.select(title, rows);
					if (choice === FREE_TEXT) {
						// A typed answer overrides the options for single-select.
						const typed = await ctx.ui.input(q.question, "your answer");
						if (typed?.trim()) answer.custom = typed.trim();
					} else if (choice !== undefined && choice !== SKIP) {
						const label = labels.find((l) => row(l) === choice);
						if (label) answer.selected = [label];
					}
					// undefined/SKIP: explicit non-answer — selected stays [].
				}

				answers.push(answer);
			}

			return {
				content: [{ type: "text", text: JSON.stringify({ answers }, null, 2) }],
				details: { answers },
			};
		},
	});
}
