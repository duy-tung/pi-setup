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
 *   - skip/cancel yields selected: [] with no custom — an explicit non-answer;
 *   - long questions open at their tail while choices/input stay visible, with
 *     PageUp/PageDown available to inspect earlier question text.
 *
 * Multi-select is emulated with a toggle loop over the scrollable selector because
 * Pi's ExtensionUIContext has no native multi-select dialog.
 *
 * Non-interactive runs (print mode, subagents) have no dialog UI; the tool
 * errors with instructions to proceed with the recommended option or surface
 * the question in the report.
 */

import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Delegated RPC subagents have no human dialog channel — fail closed. */
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

interface DialogOption {
	value: string;
	label: string;
	description?: string;
}

const DEFAULT_TERMINAL_ROWS = 24;
const MAX_DIALOG_ROWS = 30;
const MIN_DIALOG_ROWS = 1;

class QuestionViewport {
	private scrollBack = 0;
	private pageSize = 1;
	private totalLines = 1;
	private firstVisible = 0;
	private lastVisible = 0;
	private text: Text;

	constructor(text: Text) {
		this.text = text;
	}

	setText(text: Text): void {
		this.text = text;
		this.scrollBack = 0;
	}

	render(width: number, rowBudget: number): string[] {
		const rendered = this.text.render(width);
		const lines = rendered.length > 0 ? rendered : [""];
		this.totalLines = lines.length;
		this.pageSize = Math.max(1, Math.min(lines.length, Math.floor(rowBudget)));
		const maxScrollBack = Math.max(0, lines.length - this.pageSize);
		this.scrollBack = Math.max(0, Math.min(maxScrollBack, this.scrollBack));
		const start = Math.max(0, lines.length - this.pageSize - this.scrollBack);
		this.firstVisible = start;
		this.lastVisible = Math.min(lines.length - 1, start + this.pageSize - 1);
		return lines.slice(start, start + this.pageSize);
	}

	handleInput(data: string): boolean {
		const step = Math.max(1, this.pageSize - 1);
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBack += step;
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBack = Math.max(0, this.scrollBack - step);
			return true;
		}
		return false;
	}

	status(): string {
		if (this.totalLines <= this.pageSize) return "Prompt fully visible";
		return `Prompt ${this.firstVisible + 1}–${this.lastVisible + 1}/${this.totalLines} · PgUp/PgDn scroll`;
	}
}

function dialogRowBudget(): number {
	return Math.max(MIN_DIALOG_ROWS, Math.min(MAX_DIALOG_ROWS, terminalRows()));
}

function terminalRows(): number {
	const detected = process.stdout.rows;
	return typeof detected === "number" && Number.isFinite(detected) && detected > 0
		? Math.floor(detected)
		: DEFAULT_TERMINAL_ROWS;
}

// The other dialogs in this setup are bordered, so these two are too — but the
// frame is paid for out of the slack between the content budget and the real
// terminal, never out of the question or the choices. A terminal short enough
// that the budget already fills it gets no border rather than fewer rows.
function framed(
	border: DynamicBorder,
	width: number,
	rowBudget: number,
	body: string[],
): string[] {
	const edge = terminalRows() - rowBudget >= 2 ? border.render(width) : [];
	return [...edge, ...body.slice(0, rowBudget), ...edge];
}

function compactTitle(raw: string): string {
	const title = raw.replace(/\s+/g, " ").trim() || "Question";
	return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function fixedLine(text: string, width: number): string {
	return truncateToWidth(` ${text}`, Math.max(1, width));
}

async function selectQuestion(
	ctx: ExtensionContext,
	title: string,
	question: string,
	options: DialogOption[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	const display = (option: DialogOption) => `${option.label}${option.description ? ` — ${option.description}` : ""}`;
	if (ctx.mode !== "tui") {
		const rows = options.map(display);
		const selected = await ctx.ui.select(`${title}\n${question}`, rows, { signal });
		return options.find((option) => display(option) === selected)?.value;
	}
	if (signal?.aborted) return undefined;

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		let selectedIndex = 0;
		const selected = () => options[selectedIndex] ?? null;
		const promptText = (option: DialogOption | null) => option
			? [
				"Selected choice:",
				option.label,
				option.description ?? "(no additional description)",
				"",
				"Question:",
				question,
			].join("\n")
			: question;
		const viewport = new QuestionViewport(new Text(theme.fg("text", promptText(selected())), 1, 0));
		const selectIndex = (index: number) => {
			selectedIndex = (index + options.length) % options.length;
			viewport.setText(new Text(theme.fg("text", promptText(selected())), 1, 0));
		};
		const renderOptions = (width: number, rowBudget: number): string[] => {
			const budget = Math.max(1, Math.floor(rowBudget));
			const needsIndicator = options.length > budget && budget > 1;
			const visibleCount = needsIndicator ? budget - 1 : Math.min(options.length, budget);
			const start = Math.max(0, Math.min(
				selectedIndex - Math.floor(visibleCount / 2),
				options.length - visibleCount,
			));
			const lines = options.slice(start, start + visibleCount).map((option, offset) => {
				const index = start + offset;
				const marker = option.description ? " ⓘ" : "";
				const text = `${index === selectedIndex ? "→" : " "} ${option.label}${marker}`;
				return truncateToWidth(theme.fg(index === selectedIndex ? "accent" : "text", text), width);
			});
			if (needsIndicator) {
				lines.push(fixedLine(theme.fg("dim", `choice ${selectedIndex + 1}/${options.length}`), width));
			}
			return lines;
		};
		const border = new DynamicBorder((text: string) => theme.fg("accent", text));
		const onAbort = () => done(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });

		return {
			render(width: number) {
				const rowBudget = dialogRowBudget();
				const optionBudget = Math.max(1, Math.min(options.length, rowBudget - 1));
				const optionLines = renderOptions(width, optionBudget);
				let spareRows = Math.max(0, rowBudget - optionLines.length - 1);
				const showTitle = spareRows > 0;
				if (showTitle) spareRows--;
				const showAction = spareRows > 0;
				if (showAction) spareRows--;
				const showStatus = spareRows > 0;
				if (showStatus) spareRows--;
				const questionBudget = Math.max(0, rowBudget
					- optionLines.length
					- (showTitle ? 1 : 0)
					- (showAction ? 1 : 0)
					- (showStatus ? 1 : 0));
				const questionLines = questionBudget > 0 ? viewport.render(width, questionBudget) : [];
				return framed(border, width, rowBudget, [
					...(showTitle ? [fixedLine(theme.fg("accent", theme.bold(title)), width)] : []),
					...questionLines,
					...(showStatus ? [fixedLine(theme.fg("dim", viewport.status()), width)] : []),
					...optionLines,
					...(showAction
						? [fixedLine(theme.fg("dim", "↑↓ choices · enter select · esc skip · PgUp/PgDn prompt"), width)]
						: []),
				]);
			},
			invalidate() {},
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
			handleInput(data: string) {
				if (viewport.handleInput(data)) {
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.up") || data === "k") {
					selectIndex(selectedIndex - 1);
				} else if (keybindings.matches(data, "tui.select.down") || data === "j") {
					selectIndex(selectedIndex + 1);
				} else if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
					const option = selected();
					if (option) done(option.value);
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
				}
				tui.requestRender();
			},
		};
	});
}

async function inputQuestion(
	ctx: ExtensionContext,
	title: string,
	question: string,
	placeholder: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		return ctx.ui.input(`${title}\n${question}`, placeholder, { signal });
	}
	if (signal?.aborted) return undefined;

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value: string) => done(value);
		input.onEscape = () => done(undefined);
		const viewport = new QuestionViewport(new Text(theme.fg("text", question), 1, 0));
		const border = new DynamicBorder((text: string) => theme.fg("accent", text));
		const onAbort = () => done(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });

		return {
			render(width: number) {
				const rowBudget = dialogRowBudget();
				const inputLines = input.render(width);
				const hasQuestion = rowBudget > inputLines.length;
				let spareRows = Math.max(0, rowBudget - inputLines.length - (hasQuestion ? 1 : 0));
				const showTitle = spareRows > 0;
				if (showTitle) spareRows--;
				const showAction = spareRows > 0;
				if (showAction) spareRows--;
				const showStatus = spareRows > 0;
				if (showStatus) spareRows--;
				const showLabel = spareRows > 0;
				if (showLabel) spareRows--;
				const questionBudget = hasQuestion
					? Math.max(1, rowBudget
						- inputLines.length
						- (showTitle ? 1 : 0)
						- (showAction ? 1 : 0)
						- (showStatus ? 1 : 0)
						- (showLabel ? 1 : 0))
					: 0;
				const questionLines = questionBudget > 0 ? viewport.render(width, questionBudget) : [];
				return framed(border, width, rowBudget, [
					...(showTitle ? [fixedLine(theme.fg("accent", theme.bold(title)), width)] : []),
					...questionLines,
					...(showStatus ? [fixedLine(theme.fg("dim", viewport.status()), width)] : []),
					...(showLabel ? [fixedLine(theme.fg("muted", `Answer · ${placeholder}`), width)] : []),
					...inputLines,
					...(showAction
						? [fixedLine(theme.fg("dim", "enter submit · esc skip · PgUp/PgDn prompt"), width)]
						: []),
				]);
			},
			invalidate: () => input.invalidate(),
			dispose() {
				input.focused = false;
				signal?.removeEventListener("abort", onAbort);
			},
			handleInput(data: string) {
				if (!viewport.handleInput(data)) input.handleInput(data);
				tui.requestRender();
			},
		};
	});
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
				const title = compactTitle(`${q.header?.trim() || "Question"}${n}`);
				const answer: Answer = { id: q.id, selected: [] };
				const labels = (q.options ?? []).map((o) => o.label);
				const row = (label: string, marked?: boolean) => {
					const desc = q.options?.find((o) => o.label === label)?.description;
					const mark = marked === undefined ? "" : marked ? "[x] " : "[ ] ";
					return `${mark}${label}${desc ? ` — ${desc}` : ""}`;
				};
				const dialogOption = (label: string, marked?: boolean): DialogOption => {
					const description = q.options?.find((o) => o.label === label)?.description;
					const mark = marked === undefined ? "" : marked ? "[x] " : "[ ] ";
					return {
						value: row(label, marked),
						label: `${mark}${label}`,
						...(description ? { description } : {}),
					};
				};
				const actionOption = (value: string): DialogOption => ({ value, label: value });

				if (labels.length === 0) {
					// Free-text question: no options were provided.
					const typed = await inputQuestion(ctx, title, q.question, "your answer", signal);
					if (typed?.trim()) answer.custom = typed.trim();
				} else if (q.multi_select) {
					// Toggle loop: select flips one entry per round until Done/Skip.
					const picked = new Set<string>();
					for (;;) {
						if (signal?.aborted) break;
						const rows = labels.map((l) => dialogOption(l, picked.has(l)));
						rows.push(actionOption(ADD_TEXT), actionOption(DONE), actionOption(SKIP));
						const choice = await selectQuestion(ctx, title, q.question, rows, signal);
						if (choice === undefined || choice === SKIP) {
							picked.clear();
							delete answer.custom;
							break;
						}
						if (choice === DONE) break;
						if (choice === ADD_TEXT) {
							const typed = await inputQuestion(ctx, title, q.question, "additional answer", signal);
							if (typed?.trim()) answer.custom = typed.trim();
							continue;
						}
						const label = labels.find((l) => row(l, picked.has(l)) === choice);
						if (label) picked.has(label) ? picked.delete(label) : picked.add(label);
					}
					answer.selected = labels.filter((l) => picked.has(l));
				} else {
					const rows = labels.map((l) => dialogOption(l));
					rows.push(actionOption(FREE_TEXT), actionOption(SKIP));
					const choice = await selectQuestion(ctx, title, q.question, rows, signal);
					if (choice === FREE_TEXT) {
						// A typed answer overrides the options for single-select.
						const typed = await inputQuestion(ctx, title, q.question, "your answer", signal);
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
