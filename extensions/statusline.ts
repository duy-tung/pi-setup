/**
 * Pi statusline — a 1:1 port of ~/.claude/statusline.sh (Claude Code status line).
 *
 * Layout:
 *   tung │ main │ Opus 5 │ 1M │ high │ [████░░░░] 9% │ $3.24 │ 5h 15% │ 7d 41%
 *
 * Same 256-color palette, same bar glyphs (█ fill / ░ track in a dark same-hue
 * colour), same thresholds (50/80), same drop-priority fitting, same truncation
 * lengths. What the bash script reads from the Claude Code JSON payload, this
 * reads from pi: context percent from ctx.getContextUsage(), cost summed from
 * session entries, 5h/7d from the Anthropic OAuth usage endpoint (polled out of
 * band, never in render).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------- config
const POLL_MS = 120_000; // background refresh while idle
const MIN_POLL_MS = 60_000; // throttle for event-driven refresh
const TICK_MS = 10_000; // repaint tick: reads local state, renders only on change
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Backoff instead of a failure cap: a dropped wifi connection must not cost the
// statusline for the rest of the session.
const BACKOFF_MS = [30_000, 120_000, 600_000];
// The OAuth token resolves asynchronously, so the very first poll can run before
// there is anything to authenticate with; retry fast until the first reading lands.
const BOOT_RETRY_MS = 3_000;
const BOOT_TRIES = 10;

// ---------------------------------------------------------------- colors (exact copies from the bash script)
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREY = "\x1b[90m";
const C_DIR = "\x1b[38;5;75m";
const C_GIT = "\x1b[38;5;176m";
const C_SEP = `${GREY}│${R}`;
// bar palette: bright fill / dark same-hue track / bracket, per threshold
const tier = (pct: number) =>
	pct >= 80
		? { on: "\x1b[38;5;203m", off: "\x1b[38;5;52m", br: "\x1b[38;5;131m", pc: "\x1b[38;5;203m" }
		: pct >= 50
			? { on: "\x1b[38;5;221m", off: "\x1b[38;5;58m", br: "\x1b[38;5;136m", pc: "\x1b[38;5;221m" }
			: { on: "\x1b[38;5;77m", off: "\x1b[38;5;22m", br: "\x1b[38;5;71m", pc: "\x1b[38;5;77m" };

// ---------------------------------------------------------------- state
let r5 = -1; // five-hour used %, -1 = unknown
let r7 = -1; // seven-day used %, -1 = unknown
/** When each window resets (epoch ms), shown as a countdown inside its segment. */
let reset5: number | undefined;
let reset7: number | undefined;
/** Per-model weekly cap ("fable"): a separate bucket that can run out before 7d does. */
let scoped: { pct: number; label: string; resetsAt?: number } | null = null;
let severity = "normal";
/** Last rendered countdown text, so the tick can tell a real change from a repaint. */
let lastReset = "";
/**
 * Where pi is currently working, as opposed to where the session started. Set from
 * tool calls (the file being read/edited, the cwd of a bash run), cleared when the
 * turn ends — so the folder segment follows the agent around the tree the way
 * Claude Code's current_dir does, and settles back home when the agent stops.
 */
let activityDir: string | null = null;
let ctxPct = 0;
let cost = 0;
let dirty = true;
let lastPoll = 0;
let fails = 0;
let nextAttempt = 0;
/** Why the gauge is missing, reported by /limits. Silent failure hides real bugs. */
let lastError: string | null = null;
let requestRender: (() => void) | null = null;

// ---------------------------------------------------------------- reload persistence
// /reload tears down the whole extension runtime and re-imports this module, so
// every reading above resets and the usage segments go blank until the next
// successful poll. The last good reading is a few bytes; write it on every poll
// and rehydrate at import, and a reload costs nothing visible. The reset times
// are absolute epochs, so the countdowns stay correct even from a stale save.
const CACHE_FILE = `${homedir()}/.pi/agent/cache/statusline-usage.json`;
// Older than this and a blank segment is more honest than a stale percentage.
const CACHE_MAX_AGE_MS = 30 * 60_000;

function saveUsage() {
	try {
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), r5, r7, reset5, reset7, scoped, severity }));
	} catch {
		// A cache that cannot be written must not cost the poll that fed it.
	}
}

(function loadUsage() {
	try {
		const s = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		if (typeof s?.at !== "number" || Date.now() - s.at > CACHE_MAX_AGE_MS) return;
		r5 = s.r5 ?? -1;
		r7 = s.r7 ?? -1;
		reset5 = s.reset5;
		reset7 = s.reset7;
		scoped = s.scoped ?? null;
		severity = s.severity ?? "normal";
	} catch {
		// No cache, unreadable cache: the poll fills it in, same as before.
	}
})();

const touch = () => {
	dirty = true;
	requestRender?.();
};

// ---------------------------------------------------------------- polling
async function poll(ctx: any, force = false) {
	if (!ctx.hasUI) return; // sub-agents run in print mode: no footer, no request
	if (!force && Date.now() < nextAttempt) return;
	if (!force && Date.now() - lastPoll < MIN_POLL_MS) return;
	try {
		const key: string | undefined = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (!key?.startsWith("sk-ant-oat")) {
			lastError = key ? "provider is not on OAuth (API-key auth)" : "OAuth token not resolved yet";
			return; // not a failure: neither the throttle nor the backoff should move
		}
		lastPoll = Date.now();
		const res = await fetch(USAGE_URL, {
			headers: { authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" },
		});
		if (!res.ok) {
			// 401/403 means this token will never work; anything else may.
			fails = res.status === 401 || res.status === 403 ? BACKOFF_MS.length : fails + 1;
			nextAttempt = Date.now() + BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1];
			lastError = `HTTP ${res.status}`;
			return;
		}
		const d: any = await res.json();
		r5 = Math.floor(d.five_hour?.utilization ?? -1);
		r7 = Math.floor(d.seven_day?.utilization ?? -1);
		reset5 = d.five_hour?.resets_at ? Date.parse(d.five_hour.resets_at) : undefined;
		reset7 = d.seven_day?.resets_at ? Date.parse(d.seven_day.resets_at) : undefined;
		const sc = d.limits?.find((l: any) => l.kind === "weekly_scoped");
		scoped = sc
			? {
					pct: Math.floor(sc.percent ?? 0),
					label: scopeLabel(sc.scope?.model?.display_name),
					resetsAt: sc.resets_at ? Date.parse(sc.resets_at) : undefined,
				}
			: null;
		severity = d.limits?.find((l: any) => l.kind === "session")?.severity ?? "normal";
		fails = 0;
		nextAttempt = 0;
		lastError = null;
		saveUsage();
		touch();
	} catch (e: any) {
		fails++;
		nextAttempt = Date.now() + BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1];
		lastError = String(e?.message ?? e);
	}
}

// ---------------------------------------------------------------- helpers
/**
 * Session spend, summed over every entry that carries usage. Usage hangs off the
 * *message*, not the entry; the entry-level read stays as a fallback in case the
 * shape moves back. Walked in full rather than accumulated: resume and tree
 * navigation both change which entries are in the conversation.
 */
const totalCost = (ctx: any): number => {
	try {
		let sum = 0;
		type U = { cost?: { total?: number } };
		type E = { usage?: U; message?: { usage?: U } };
		for (const e of ctx.sessionManager.getEntries() as E[]) {
			sum += e.message?.usage?.cost?.total ?? e.usage?.cost?.total ?? 0;
		}
		return sum;
	} catch {
		return cost; // keep the last good figure rather than flashing $0.00
	}
};

// "claude-opus-5" -> "Opus 5", "claude-haiku-4-5" -> "Haiku 4.5".
// Claude Code shows the model's display_name with the "(1M context)" suffix cut
// off; pi's model.name is usually that same display name, so prefer it.
const modelLabel = (m: any): string => {
	let name: string = m?.name || m?.id || "?";
	name = name.replace(/\s*\(.*$/, "").replace(/^claude[-\s]/i, "");
	if (name.includes("-")) {
		const parts = name.split("-");
		const alpha = parts.filter((p) => /[a-z]/i.test(p)).map((p) => p[0].toUpperCase() + p.slice(1));
		const num = parts.filter((p) => /^\d+$/.test(p)).join(".");
		name = [...alpha, num].filter(Boolean).join(" ");
	}
	return name;
};

const readPct = (ctx: any) => Math.max(0, Math.floor(ctx.getContextUsage()?.percent ?? 0));

/**
 * The directory a tool call is touching, or null when it has none.
 *
 * Args are scanned by key, not by tool name: extensions register tools this file
 * has never heard of, and "the first arg that names a path" is the convention they
 * all share. A file path contributes its parent; a directory contributes itself —
 * one stat call decides which it is, and a path that does not exist yet (a write
 * about to create it) falls back to its parent.
 */
const dirFromArgs = (args: any, cwd: string): string | null => {
	if (!args || typeof args !== "object") return null;
	for (const k of ["path", "file_path", "filePath", "cwd", "dir", "directory"]) {
		const v = args[k];
		if (typeof v !== "string" || v === "") continue;
		const p = isAbsolute(v) ? v : resolve(cwd, v.startsWith("~/") ? v.replace("~", process.env.HOME ?? "~") : v);
		try {
			return statSync(p).isDirectory() ? p : dirname(p);
		} catch {
			return dirname(p);
		}
	}
	return null;
};

/**
 * Branch name: walk up for .git and read HEAD directly, exactly like the bash
 * script — no git subprocess. Handles worktrees (.git as a file pointing at the
 * real gitdir) and detached HEAD (first 7 hex chars). Only called on dirty
 * renders, and those are rare; the reads are a handful of stats.
 */
let branchCache = { dir: "", value: "", at: 0 };
const gitBranch = (dir: string): string => {
	// Dirty renders cluster (turn end, countdown ticks); the branch cannot move
	// between two renders in the same breath, so a short TTL removes the repeated
	// stat-walk without ever showing a stale branch for longer than a tick.
	if (branchCache.dir === dir && Date.now() - branchCache.at < 5_000) return branchCache.value;
	const head = (p: string): string | null => {
		try {
			return readFileSync(p, "utf8").split("\n", 1)[0];
		} catch {
			return null;
		}
	};
	let d = dir.replace(/\/+$/, "");
	while (d && d !== "/") {
		let h = head(`${d}/.git/HEAD`);
		if (h === null) {
			// worktree: .git is a file pointing at the real gitdir
			const f = head(`${d}/.git`);
			const gitdir = f?.match(/^gitdir: (.*)$/)?.[1];
			if (gitdir) h = head(gitdir.startsWith("/") ? `${gitdir}/HEAD` : `${d}/${gitdir}/HEAD`);
		}
		if (h !== null) {
			const v = h.startsWith("ref:") ? h.split("/").pop()! : h.slice(0, 7);
			branchCache = { dir, value: v, at: Date.now() };
			return v;
		}
		d = d.slice(0, d.lastIndexOf("/")) || "/";
	}
	branchCache = { dir, value: "", at: Date.now() };
	return "";
};

// "Claude Fable 5" -> "fable": the scoped bucket is named after a model, and the
// family word is the only part that distinguishes it from the all-models 7d figure.
const scopeLabel = (name?: string) => {
	const word = (name ?? "")
		.replace(/claude/gi, "")
		.split(/[\s\-_.]+/)
		.filter((w) => w && !/^\d+(\.\d+)?$/.test(w))[0];
	return (word ?? "mdl").slice(0, 5).toLowerCase();
};

// "57m" / "2h13m" / "2d21h". Each countdown rides inside its own segment: the
// percent and the time-to-reset are one fact, and putting the time anywhere else
// makes the reader guess which window it counts down to. Precision shrinks as the
// horizon grows — minutes matter inside an hour, not three days out.
const fmtReset = (at?: number) => {
	if (!at) return "";
	const m = Math.max(0, Math.round((at - Date.now()) / 60_000));
	if (m < 60) return `${m}m`;
	if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
};

/** Every visible countdown in one string, so the tick can compare text, not time. */
const resetKey = () => `${fmtReset(reset5)}\u0001${fmtReset(reset7)}\u0001${fmtReset(scoped?.resetsAt)}`;

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", (_e, ctx) => {
		ctxPct = readPct(ctx);
		cost = totalCost(ctx);
		activityDir = null; // the agent stopped: the folder settles back home
		touch();
		void poll(ctx);
	});
	pi.on("tool_execution_start", (e: any, ctx: any) => {
		const dir = dirFromArgs(e.args, ctx.sessionManager.getCwd());
		if (dir && dir !== activityDir) {
			activityDir = dir;
			touch();
		}
	});
	pi.on("model_select", (_e, ctx) => {
		fails = 0; // a new provider deserves a fresh attempt
		nextAttempt = 0;
		touch();
		void poll(ctx);
	});
	pi.on("thinking_level_select", () => touch());

	pi.registerCommand("limits", {
		description: "Refresh and show Anthropic plan usage limits",
		handler: async (_args, ctx) => {
			fails = 0;
			nextAttempt = 0;
			await poll(ctx, true);
			if (r5 < 0 && r7 < 0) {
				ctx.ui.notify(`No plan limits available: ${lastError ?? "unknown reason"}`, "warning");
				return;
			}
			const part = (label: string, pct: number, at?: number) =>
				`${label} ${pct}%${at ? ` (${fmtReset(at)})` : ""}`;
			ctx.ui.notify(
				part("5h", r5, reset5) +
					`   ${part("7d", r7, reset7)}` +
					(scoped ? `   ${part(scoped.label, scoped.pct, scoped.resetsAt)}` : ""),
				"info",
			);
		},
	});

	pi.on("session_start", (_e, ctx) => {
		ctxPct = readPct(ctx);
		// A resumed session has already spent money; starting at zero would report the
		// wrong number until the first turn happened to end.
		cost = totalCost(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();

			let cache: string[] = [];
			let cachedWidth = -1;
			// setStatus() only calls requestRender(), never invalidate(): without the
			// statuses in the cache key, line 2 freezes until something else re-dirties.
			let cachedStatuses = "\u0000";

			const unsubBranch = footerData.onBranchChange(() => {
				branchCache.at = 0; // pi saw the branch move; the memo must not outlive that
				touch();
			});
			const timer = ctx.hasUI ? setInterval(() => void poll(ctx), POLL_MS) : undefined;
			timer?.unref?.();
			void poll(ctx, true);
			// Ticks until the first reading lands, then stops. Unforced on purpose: the
			// backoff still gates real errors, so this only actually retries in the one
			// case it exists for — no key yet, which sets neither lastPoll nor nextAttempt.
			let bootTries = 0;
			const bootTimer: ReturnType<typeof setInterval> | undefined = ctx.hasUI
				? setInterval(() => {
						if (r5 >= 0 || ++bootTries > BOOT_TRIES) {
							clearInterval(bootTimer!);
							return;
						}
						void poll(ctx);
					}, BOOT_RETRY_MS)
				: undefined;
			bootTimer?.unref?.();
			// Context climbs during a turn with no event to hang off; poll it locally and
			// only mark dirty on a real change so an idle session repaints nothing.
			const ticker = ctx.hasUI
				? setInterval(() => {
						const next = readPct(ctx);
						// The countdown moves with no event behind it. Comparing the rendered
						// text, not the milliseconds, keeps an idle session at one repaint a
						// minute instead of one every tick.
						const nextReset = resetKey();
						if (next !== ctxPct || nextReset !== lastReset) {
							ctxPct = next;
							lastReset = nextReset;
							touch();
						}
					}, TICK_MS)
				: undefined;
			ticker?.unref?.();

			return {
				dispose() {
					if (timer) clearInterval(timer);
					if (bootTimer) clearInterval(bootTimer);
					if (ticker) clearInterval(ticker);
					unsubBranch();
					requestRender = null;
				},
				invalidate() {
					dirty = true;
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const statuses = footerData.getExtensionStatuses();
					let statusKey = "";
					if (statuses.size > 0) {
						statusKey = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => `${k}\u0001${v}`)
							.join("\u0002");
					}
					if (!dirty && width === cachedWidth && statusKey === cachedStatuses) return cache;

					// ---- segments: text / display width / drop-priority (higher = dropped first)
					const txt: string[] = [];
					const wid: number[] = [];
					const pri: number[] = [];
					const add = (t: string, w: number, p: number) => {
						txt.push(t);
						wid.push(w);
						pri.push(p);
					};

					const cwd: string = activityDir ?? ctx.sessionManager.getCwd();
					let dir = cwd.replace(/\/+$/, "").split("/").pop() || "/";
					if (dir.length > 22) dir = dir.slice(0, 21) + "…";
					let branch = footerData.getGitBranch() || gitBranch(cwd);
					if (branch.length > 20) branch = branch.slice(0, 19) + "…";
					const model = modelLabel(ctx.model);
					const effort = ctx.model?.reasoning ? (ctx.thinkingLevel ?? "") : "";
					const fast = statuses.get("fast-mode") !== undefined;
					const pctStr = String(ctxPct);

					add(`${C_DIR}${dir}${R}`, dir.length, 1);
					if (branch) add(`${C_GIT}${branch}${R}`, branch.length, 2);
					add(`${DIM}${model}${R}`, model.length, 1);
					if ((ctx.model?.contextWindow ?? 0) > 200_000) add(`${DIM}1M${R}`, 2, 4);
					if (effort) add(`${DIM}${effort}${R}`, effort.length, 3);
					if (fast) add(`${DIM}⚡${R}`, 2, 5);
					const BAR_IDX = txt.length;
					add("", 0, 0); // bar placeholder, never dropped
					const cents = Math.round(cost * 100);
					const money = `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
					add(money, money.length, 2);
					lastReset = resetKey();
					// `5h 15% (57m)` — each limit segment carries its own countdown, dim against
					// the segment's grey so the percent stays the loudest part.
					const limitSeg = (label: string, pct: number, at: number | undefined, p: number) => {
						const reset = fmtReset(at);
						add(
							`${GREY}${label} ${pct}%${R}${reset ? ` ${DIM}(${reset})${R}` : ""}`,
							label.length + String(pct).length + 2 + (reset ? reset.length + 3 : 0),
							p,
						);
					};
					if (r5 >= 0) limitSeg("5h", r5, reset5, 3);
					if (r7 >= 0) limitSeg("7d", r7, reset7, 3);
					// The per-model bucket only earns a segment when it differs from 7d: two
					// weekly numbers that track each other say nothing twice.
					if (scoped && r7 >= 0 && scoped.pct !== r7)
						limitSeg(scoped.label, scoped.pct, scoped.resetsAt, 4);

					// ---- fit to terminal: shrink the bar, then drop segments by priority
					let drop = 6; // nothing dropped yet
					let room = 0;
					for (;;) {
						let used = 0;
						let n = 0;
						for (let i = 0; i < txt.length; i++) {
							if (pri[i] >= drop) continue;
							used += wid[i];
							n++;
						}
						used += 3 * (n - 1); // " │ " between segments
						room = width - used - 4 - pctStr.length; // "[]" + " " + "NN" + "%"
						if (room >= 6 || drop <= 2) break;
						drop--;
					}
					let cells = room > 24 ? 24 : room;
					if (cells < 4) cells = 4;

					let filled = Math.floor((ctxPct * cells) / 100);
					if (ctxPct > 0 && filled === 0) filled = 1; // always show a sliver
					if (filled > cells) filled = cells;
					// The plan window running hot outranks the context tier: past "normal"
					// the whole bar family goes red the way Claude Code's severity does not,
					// but ctxPct drives the tier exactly like the script otherwise.
					const c = tier(severity !== "normal" && severity !== "ok" ? 100 : ctxPct);
					txt[BAR_IDX] =
						`${c.br}[${c.on}${"█".repeat(filled)}${c.off}${"░".repeat(cells - filled)}${c.br}]${R} ` +
						`${c.pc}${BOLD}${ctxPct}%${R}`;

					let out = "";
					for (let i = 0; i < txt.length; i++) {
						if (pri[i] >= drop) continue;
						if (out) out += ` ${C_SEP} `;
						out += txt[i];
					}

					const lines = [truncateToWidth(out, width, `${GREY}…${R}`)];

					// keep other extensions' statuses visible (setFooter replaces the built-in
					// footer). fast-mode is already a segment on line 1; repeating it here
					// would say the same thing twice.
					const rest = Array.from(statuses.entries())
						.filter(([k]) => k !== "fast-mode")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, v]) => v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
						.join("  ");
					if (rest) lines.push(truncateToWidth(`${GREY}${rest}${R}`, width, `${GREY}…${R}`));

					cache = lines;
					cachedWidth = width;
					cachedStatuses = statusKey;
					dirty = false;
					return cache;
				},
			};
		});
	});
}
