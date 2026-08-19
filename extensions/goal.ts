/**
 * goal: long-running objectives with self-continuing rounds — DSH's goal
 * domain (goal/goal-round-driver/tool-goal) for pi.
 *
 * One goal per session. State is event-sourced: every mutation appends a
 * FULL snapshot as a "goal-state" custom entry (last-write-wins fold over the
 * active branch), so rewind/fork behave correctly for free and compaction
 * cannot touch it (custom entries never enter LLM context).
 *
 * The central DSH invariant: `armed` — whether the driver may auto-continue —
 * is process-local and NEVER persisted. Every session_start disarms, whatever
 * the stored phase says. Reopening an old session with an active goal keeps
 * the objective but does not run; the human re-arms via update_goal resume,
 * /goal resume, or by creating a goal. This is the handbrake that stops
 * "rewind to an old checkpoint, agent burns 200 rounds on its own".
 *
 * Round driver (agent_settled):
 *   - only a goal-round prompt consumes round quota; human input never does;
 *   - the incremented snapshot is appended BEFORE the round prompt is sent
 *     (DSH reserve-then-drive);
 *   - a final assistant message with stopReason error/aborted disarms instead
 *     of driving (no infinite error loops; DSH cancel -> pause);
 *   - hitting maxRounds disarms and tells the user.
 *
 * Authority split (DSH tool-goal): edit/pause/resume belong to the human —
 * they are rejected inside a goal-round-initiated turn. complete is always
 * allowed. blocked is hard-gated until 3 rounds have run; the runtime can
 * only prove the round count — whether the same condition truly persisted is
 * the model's judgement, and the schema says so.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const DEFAULT_MAX_ROUNDS = 10;
const MAX_ROUNDS_CEILING = 50;
const BLOCKED_AFTER_ROUNDS = 3;

type Phase = "active" | "paused" | "blocked" | "complete";

interface GoalState {
	id: string;
	revision: number;
	objective: string;
	phase: Phase;
	roundsStarted: number;
	maxRounds: number;
	blockedReason?: string;
	updatedAt: number;
}

function roundPrompt(goal: GoalState): string {
	return [
		"<goal_round>",
		`Goal round ${goal.roundsStarted} of ${goal.maxRounds}.`,
		`Objective: ${goal.objective}`,
		"",
		"Continue working toward the objective. When it is actually achieved, call " +
			`update_goal with action "complete" (goal_id ${goal.id}, revision ${goal.revision}). ` +
			"If the same concrete blocking condition has persisted for at least " +
			`${BLOCKED_AFTER_ROUNDS} consecutive rounds, call update_goal with action "blocked" and that condition. ` +
			"Difficulty, uncertainty, or useful remaining work is not blocked. Do not stop early without one of those calls.",
		"</goal_round>",
	].join("\n");
}

const WRAPUP =
	"Now write a closing message for the user. Report only what earlier rounds and tool results " +
	"in this session actually establish — do not invent progress.";

export default function (pi: ExtensionAPI) {
	/** Never persisted (DSH activation invariant). */
	let armed = false;
	/** In-memory copy of the latest snapshot; entries are for durability/rewind. */
	let cached: GoalState | null = null;
	/** True while the current turn was initiated by a goal-round prompt. */
	let roundInFlight = false;

	function fold(ctx: ExtensionContext): GoalState | null {
		try {
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const en = entries[i] as { type?: string; customType?: string; data?: unknown };
				if (en.type === "custom" && en.customType === "goal-state") {
					return (en.data as GoalState) ?? null;
				}
			}
		} catch {
			// fall through to cache
		}
		return null;
	}

	function goalOf(ctx: ExtensionContext): GoalState | null {
		// Cache first: an entry appended this turn may not be foldable yet.
		return cached ?? fold(ctx);
	}

	function commit(next: GoalState) {
		cached = next;
		pi.appendEntry("goal-state", next);
	}

	function status(ctx: ExtensionContext | undefined) {
		if (!ctx?.hasUI) return;
		const g = cached;
		if (!g || g.phase === "complete" || g.phase === "blocked") {
			ctx.ui.setStatus("goal", undefined);
		} else if (g.phase === "paused" || !armed) {
			ctx.ui.setStatus("goal", "⏸ goal");
		} else {
			ctx.ui.setStatus("goal", `🎯 r${g.roundsStarted}/${g.maxRounds}`);
		}
	}

	function lastAssistantStopReason(ctx: ExtensionContext): string | undefined {
		try {
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const en = entries[i] as { type?: string; message?: { role?: string; stopReason?: string } };
				if (en.type === "message" && en.message?.role === "assistant") return en.message.stopReason;
			}
		} catch {
			// unknown is fine
		}
		return undefined;
	}

	pi.on("session_start", (_e, ctx) => {
		armed = false; // the invariant: activation never survives a session boundary
		roundInFlight = false;
		cached = fold(ctx);
		status(ctx);
	});

	pi.on("input", (e) => {
		if (e.source !== "extension") roundInFlight = false;
	});

	// ------------------------------------------------------------------ driver

	pi.on("agent_settled", (_e, ctx) => {
		const goal = goalOf(ctx);
		cached = goal;
		status(ctx);
		if (!goal || !armed || goal.phase !== "active") return;

		const stop = lastAssistantStopReason(ctx);
		if (stop === "error" || stop === "aborted") {
			armed = false;
			roundInFlight = false;
			status(ctx);
			ctx.ui?.notify?.(`goal: last turn ended with ${stop} — auto-continuation disarmed. /goal resume to continue.`, "warning");
			return;
		}

		if (goal.roundsStarted >= goal.maxRounds) {
			armed = false;
			status(ctx);
			ctx.ui?.notify?.(
				`goal: hit its round cap (${goal.maxRounds}) without completion — resume manually, or have the model complete/blocked it.`,
				"warning",
			);
			return;
		}

		driveRound(ctx, goal);
	});

	/** Reserve the round durably, then drive (DSH order). */
	function driveRound(ctx: ExtensionContext, goal: GoalState) {
		const next: GoalState = {
			...goal,
			revision: goal.revision + 1,
			roundsStarted: goal.roundsStarted + 1,
			updatedAt: Date.now(),
		};
		commit(next);
		roundInFlight = true;
		status(ctx);
		pi.sendMessage(
			{ customType: "goal-round", content: roundPrompt(next), display: true },
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	// ------------------------------------------------------------------- tools

	pi.registerTool({
		name: "create_goal",
		label: "Create goal",
		description:
			"Create one persisted completion goal for this session when the user's request is a long-running " +
			"objective that should continue across autonomous rounds. Do not use this for trivial single-turn work. " +
			"After your current turn settles, the goal driver starts a new round automatically until you call " +
			"update_goal with complete or blocked, or the round cap is reached.",
		promptSnippet: "Create a long-running session goal that auto-continues in rounds",
		promptGuidelines: [
			"Use create_goal only for long-running objectives the user asked for; mark it complete only when the objective is actually achieved.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "The concrete completion objective inferred from the user's request" }),
			max_goal_rounds: Type.Optional(
				Type.Number({ description: `Cap on automatic continuation rounds (default ${DEFAULT_MAX_ROUNDS}, max ${MAX_ROUNDS_CEILING})` }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
				const existing = goalOf(ctx);
			if (existing && existing.phase !== "complete" && existing.phase !== "blocked") {
				return {
					content: [
						{ type: "text", text: `a goal already exists (${existing.id}, phase ${existing.phase}); edit, complete, or block it via update_goal instead` },
					],
					details: {},
					isError: true,
				};
			}
			const maxRounds = Math.min(Math.max(1, Math.floor(params.max_goal_rounds ?? DEFAULT_MAX_ROUNDS)), MAX_ROUNDS_CEILING);
			const goal: GoalState = {
				id: randomUUID().slice(0, 8),
				revision: 1,
				objective: params.objective,
				phase: "active",
				roundsStarted: 0,
				maxRounds,
				updatedAt: Date.now(),
			};
			commit(goal);
			armed = true;
			status(ctx);
			return {
				content: [
					{
						type: "text",
						text: `goal ${goal.id} created (revision 1, max ${maxRounds} rounds) and armed. Rounds start automatically when this turn settles; finish your current reply normally.`,
					},
				],
				details: { goal },
			};
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get goal",
		description:
			"Read the current session goal: id, exact revision (required by update_goal), objective, phase, rounds used, " +
			"round cap, and whether auto-continuation is armed. Call this before update_goal.",
		promptSnippet: "Read the current session goal and its revision",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
				const goal = goalOf(ctx);
			if (!goal) {
				return { content: [{ type: "text", text: "no goal exists in this session" }], details: {}, isError: true };
			}
			cached = goal;
			return {
				content: [{ type: "text", text: JSON.stringify({ ...goal, armed }, null, 2) }],
				details: { goal, armed },
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update goal",
		description:
			"Update the exact current goal revision. Actions: edit | pause | resume | complete | blocked. " +
			"edit, pause, and resume require a direct human request — they are rejected inside an automatic goal round. " +
			"complete and blocked are how a goal round ends the goal. blocked is rejected before " +
			`${BLOCKED_AFTER_ROUNDS} rounds have run; the runtime only proves the round count — judging that the same ` +
			"condition persisted across those rounds is your responsibility, and blocked_reason must state it concretely. " +
			"Difficulty, uncertainty, or useful remaining work is not blocked.",
		promptSnippet: "Edit, pause, resume, complete, or block the session goal",
		parameters: Type.Object({
			goal_id: Type.String({ description: "Exact id returned by get_goal or create_goal" }),
			revision: Type.Number({ description: "Exact current revision returned by get_goal" }),
			action: Type.Union(
				[Type.Literal("edit"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("complete"), Type.Literal("blocked")],
				{ description: "edit | pause | resume | complete | blocked" },
			),
			objective: Type.Optional(Type.String({ description: "Replacement objective; valid only with action edit" })),
			max_goal_rounds: Type.Optional(Type.Number({ description: "Replacement round cap; valid only with action edit" })),
			blocked_reason: Type.Optional(Type.String({ description: "Concrete blocking condition; required with action blocked" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
				const goal = goalOf(ctx);
			if (!goal) {
				return { content: [{ type: "text", text: "no goal exists in this session" }], details: {}, isError: true };
			}
			if (params.goal_id !== goal.id || params.revision !== goal.revision) {
				return {
					content: [
						{
							type: "text",
							text: `stale goal reference (current: id ${goal.id}, revision ${goal.revision}) — call get_goal, then retry`,
						},
					],
					details: {},
					isError: true,
				};
			}
			if (goal.phase === "complete" || goal.phase === "blocked") {
				return {
					content: [{ type: "text", text: `goal ${goal.id} is terminal (${goal.phase}) and cannot be updated` }],
					details: {},
					isError: true,
				};
			}

			const action = params.action;
			if ((action === "edit" || action === "pause" || action === "resume") && roundInFlight) {
				return {
					content: [
						{
							type: "text",
							text: `${action} requires a direct human request and this turn was started by an automatic goal round — continue the round, or complete/blocked the goal`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const next: GoalState = { ...goal, revision: goal.revision + 1, updatedAt: Date.now() };
			let note: string;
			switch (action) {
				case "edit": {
					if (params.objective !== undefined) next.objective = params.objective;
					if (params.max_goal_rounds !== undefined) {
						next.maxRounds = Math.min(Math.max(1, Math.floor(params.max_goal_rounds)), MAX_ROUNDS_CEILING);
					}
					note = `goal ${goal.id} edited (revision ${next.revision})`;
					break;
				}
				case "pause": {
					next.phase = "paused";
					armed = false;
					note = `goal ${goal.id} paused; resume with update_goal resume on a direct user request`;
					break;
				}
				case "resume": {
					next.phase = "active";
					armed = true;
					note = `goal ${goal.id} resumed and armed; rounds continue when this turn settles`;
					break;
				}
				case "complete": {
					next.phase = "complete";
					armed = false;
					note = `goal ${goal.id} marked complete. ${WRAPUP}`;
					break;
				}
				case "blocked": {
					if (goal.roundsStarted < BLOCKED_AFTER_ROUNDS) {
						return {
							content: [
								{
									type: "text",
									text: `blocked is rejected before ${BLOCKED_AFTER_ROUNDS} rounds have run (currently ${goal.roundsStarted}) — keep working toward the objective`,
								},
							],
							details: {},
							isError: true,
						};
					}
					if (typeof params.blocked_reason !== "string" || params.blocked_reason.trim() === "") {
						return {
							content: [{ type: "text", text: "blocked_reason is required with action blocked: state the concrete blocking condition" }],
							details: {},
							isError: true,
						};
					}
					next.phase = "blocked";
					next.blockedReason = params.blocked_reason.trim();
					armed = false;
					note = `goal ${goal.id} marked blocked (${next.blockedReason}). ${WRAPUP}`;
					break;
				}
			}
			commit(next);
			status(ctx);
			return { content: [{ type: "text", text: note }], details: { goal: next } };
		},
	});

	// ----------------------------------------------------------------- command

	pi.registerCommand("goal", {
		description: "Show the session goal; '/goal pause' and '/goal resume' control auto-continuation",
		async handler(args, ctx) {
				const goal = goalOf(ctx);
			if (!goal) {
				ctx.ui.notify("no goal in this session", "info");
				return;
			}
			const arg = args.trim();
			if (arg === "pause") {
				armed = false;
				if (goal.phase === "active") commit({ ...goal, revision: goal.revision + 1, phase: "paused", updatedAt: Date.now() });
				status(ctx);
				ctx.ui.notify(`goal ${goal.id} paused`, "info");
				return;
			}
			if (arg === "resume") {
				if (goal.phase === "complete" || goal.phase === "blocked") {
					ctx.ui.notify(`goal ${goal.id} is terminal (${goal.phase})`, "warning");
					return;
				}
				const resumed: GoalState = { ...goal, revision: goal.revision + 1, phase: "active", updatedAt: Date.now() };
				commit(resumed);
				armed = true;
				status(ctx);
				ctx.ui.notify(`goal ${goal.id} armed`, "info");
				// A settled agent gets no further agent_settled event, so drive now.
				if (ctx.isIdle() && resumed.roundsStarted < resumed.maxRounds) driveRound(ctx, resumed);
				return;
			}
			ctx.ui.notify(
				`goal ${goal.id}: ${goal.phase}${armed ? " (armed)" : " (disarmed)"} — round ${goal.roundsStarted}/${goal.maxRounds}\n${goal.objective}${goal.blockedReason ? `\nblocked: ${goal.blockedReason}` : ""}`,
				"info",
			);
		},
	});
}
