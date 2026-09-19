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
 * session entries (including historical Present cost), provider/model-specific quota
 * windows from Anthropic or Codex (single-flight, abortable, never fetched in render).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { contextWindowLabel, effectiveSeverity, selectedModelLabel, parseUsage, usageRequest, type UsageWindow, type UsageReading } from "./lib/statusline-usage.ts";

// ---------------------------------------------------------------- config
const POLL_MS = 120_000; // background refresh while idle
const MIN_POLL_MS = 60_000; // throttle for event-driven refresh
export const POLL_TIMEOUT_MS = 10_000;
const TICK_MS = 10_000; // repaint tick: reads local state, renders only on change
// Backoff instead of a failure cap: a dropped wifi connection must not cost the
// statusline for the rest of the session.
const BACKOFF_MS = [30_000, 120_000, 600_000];
// A 429 is not this client polling too fast: Anthropic's usage endpoint buckets by
// agent, so a shared bucket can already be empty on the very first read. Escalating
// to ten minutes would punish the statusline for someone else's traffic, so the wait
// stays fixed and short enough that the first reading still lands during a session.
const RATE_LIMIT_BACKOFF_MS = 180_000;
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
let windows: UsageWindow[] = [];
let severity = "normal";
let readingAt = 0;
let lastReset = "";
let activityDir: string | null = null;
let ctxPct = 0;
let cost = 0;
let dirty = true;
let lastPoll = 0;
let fails = 0;
let nextAttempt = 0;
let lastOAuthToken: string | undefined;
let selection = "";
let readingIdentity = "";
// A displayed reading whose credential we have not seen answer for. Only a provider
// whose identity cannot name an account can produce one, and it lasts until the next
// response either confirms it or takes it away.
let provisional = false;
let pollInFlight: Promise<void> | null = null;
let pollController: AbortController | null = null;
let pollGeneration = 0;
let lastError: string | null = null;
let requestRender: (() => void) | null = null;

const CACHE_FILE = `${process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`}/cache/statusline-usage.json`;
const CACHE_MAX_AGE_MS = 30 * 60_000;
type CachedReading = UsageReading & { at: number; modelId?: string; credential?: string };
const usageCache = new Map<string, CachedReading>();

function validCachedReading(value: any): value is CachedReading {
	return typeof value?.at === "number" && Number.isFinite(value.at)
		&& value.at <= Date.now() && Date.now() - value.at < CACHE_MAX_AGE_MS
		&& typeof value.severity === "string" && Array.isArray(value.windows)
		&& (value.scopedSeverity === undefined || typeof value.scopedSeverity === "string")
		&& value.windows.length > 0 && value.windows.length <= 12
		&& (value.modelId === undefined || (typeof value.modelId === "string" && value.modelId.length <= 64))
		&& (value.credential === undefined || (typeof value.credential === "string" && /^[a-f0-9]{64}$/.test(value.credential)))
		&& value.windows.every((w: any) => typeof w.label === "string" && /^[a-z0-9 .-]{1,24}$/i.test(w.label)
			&& typeof w.pct === "number" && Number.isFinite(w.pct) && w.pct >= 0
			&& (w.resetsAt === undefined || (typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)))
			&& (w.scoped === undefined || typeof w.scoped === "boolean"));
}

/**
 * A cached reading minus what belongs to a different model.
 *
 * The 5h and 7d windows are account-wide facts: the same numbers whichever model is
 * selected. Only a scoped bucket names one model family, so switching models must
 * drop that one window rather than the whole reading — otherwise every switch throws
 * away a valid account reading and buys a fresh request against a rate-limited
 * endpoint to learn what was already known.
 */
function reusableWindows(saved: CachedReading, modelId: string): UsageWindow[] {
	return saved.modelId === modelId ? saved.windows : saved.windows.filter(window => !window.scoped);
}

/**
 * How long an unforced retry must wait after a failed reading.
 *
 * Exported for the regression test: the two paths that used to make a 429 look
 * permanent were escalating its wait to ten minutes and a boot retry that expired
 * before the first wait was over.
 */
export function failureBackoff(status: number | undefined, fails: number): { fails: number; wait: number } {
	if (status === 429) return { fails: 1, wait: RATE_LIMIT_BACKOFF_MS };
	const next = status === 401 || status === 403 ? BACKOFF_MS.length : fails + 1;
	return { fails: next, wait: BACKOFF_MS[Math.min(next, BACKOFF_MS.length) - 1] };
}

/**
 * Record a failed reading so the next unforced poll waits the right amount.
 *
 * A failure also settles an unverified reading the only honest way: the credential that
 * would have vouched for it never answered, so an account switch and an ordinary token
 * refresh are still indistinguishable. Showing nothing beats showing another account's
 * numbers for the next half hour.
 */
function applyBackoff(status?: number) {
	const next = failureBackoff(status, fails);
	fails = next.fails;
	nextAttempt = Date.now() + next.wait;
	if (provisional) clearReading();
}

/** The first moment an unforced poll would actually reach the network again. */
export function bootRetryDelay(now: number, poll: number, attempt: number): number {
	const throttled = poll > 0 ? poll + MIN_POLL_MS : 0; // nothing polled yet imposes no throttle
	return Math.max(BOOT_RETRY_MS, Math.max(attempt, throttled) - now);
}

/**
 * Open the cache without following symlinks and force private permissions on
 * the descriptor before any read or write. A cache created world-readable by an
 * earlier version is repaired here; a non-regular file or a failed chmod fails
 * closed (no read, no write).
 */
function openPrivateCache(write: boolean): number {
	const flags = write
		? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
		: constants.O_RDONLY | constants.O_NOFOLLOW;
	const fd = openSync(CACHE_FILE, flags, 0o600);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("statusline cache is not a regular file");
		if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

try {
	const fd = openPrivateCache(false);
	let cached;
	try { cached = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
	// Version 1 did not distinguish providers/accounts, and version 2 keyed Anthropic
	// readings by a token that rotates hourly; neither may be reused under version 3.
	if (cached?.version === 3 && cached.readings && typeof cached.readings === "object") {
		for (const [identity, value] of Object.entries(cached.readings)) {
			if (validCachedReading(value)) usageCache.set(identity, value);
		}
	}
} catch { /* no cache: wait for the selected provider's first response */ }

function saveUsage() {
	try {
		const readings = Object.fromEntries([...usageCache].filter(([, value]) => validCachedReading(value)).slice(-12));
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		const fd = openPrivateCache(true);
		try { writeSync(fd, JSON.stringify({ version: 3, readings })); } finally { closeSync(fd); }
	} catch { /* cache failure must not break the footer */ }
}

const touch = () => { dirty = true; requestRender?.(); };
const providerTitle = (provider?: string) => provider === "anthropic" ? "Anthropic"
	: provider === "openai-codex" ? "Codex" : provider === "openai" ? "OpenAI API" : provider ?? "Provider";
const selectionOf = (ctx: any) => `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;

function clearReading() {
	windows = [];
	severity = "normal";
	readingAt = 0;
	lastReset = "";
	provisional = false;
}

/** Model changes invalidate in-flight work before starting a new provider request. */
function selectUsage(ctx: any) {
	const next = selectionOf(ctx);
	if (next === selection) return;
	selection = next;
	pollGeneration++;
	pollController?.abort("model changed");
	pollController = null;
	pollInFlight = null;
	readingIdentity = "";
	lastOAuthToken = undefined;
	lastPoll = 0;
	fails = 0;
	nextAttempt = 0;
	lastError = null;
	clearReading();
	touch();
}

function expireReading() {
	if (readingAt > 0 && Date.now() - readingAt >= CACHE_MAX_AGE_MS) {
		clearReading();
		lastError = "Last usage reading expired";
		touch();
	}
}

// ---------------------------------------------------------------- polling
const POLL_TIMEOUT_REASON = "statusline usage poll timed out";
const POLL_DISPOSE_REASON = "statusline usage poll disposed";

async function runPoll(ctx: any, force: boolean, signal: AbortSignal, generation: number): Promise<void> {
	const provider = ctx.model?.provider;
	const modelId = ctx.model?.id ?? "";
	const selected = selectionOf(ctx);
	const isCurrent = () => !signal.aborted && generation === pollGeneration && selected === selection;
	try {
		if (provider !== "anthropic" && provider !== "openai-codex") {
			lastError = provider === "openai" ? "OpenAI API-key billing has no subscription quota"
				: "No subscription quota endpoint for this provider";
			return;
		}
		const key: string | undefined = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!isCurrent()) return;
		if (!key) {
			clearReading();
			readingIdentity = "";
			lastError = "OAuth token not resolved; use /login if this persists";
			touch();
			return;
		}
		let request: ReturnType<typeof usageRequest>;
		try { request = usageRequest(provider, key); }
		catch (error) {
			clearReading();
			readingIdentity = "";
			lastError = (error as Error).message;
			touch();
			return;
		}
		if (lastOAuthToken !== undefined && key !== lastOAuthToken) {
			fails = 0;
			nextAttempt = 0;
			lastPoll = 0;
			// The new credential may belong to a different account; this reading is now
			// a claim awaiting the response below rather than something to keep showing.
			if (!request.accountBound && windows.length > 0) provisional = true;
		}
		lastOAuthToken = key;
		// Whether this call will reach the network decides what may be displayed: a
		// reading this poll cannot settle must not go on screen at all.
		const blocked = !force && (Date.now() < nextAttempt || Date.now() - lastPoll < MIN_POLL_MS);
		const identity = request.identity + ":" + modelId;
		if (identity !== readingIdentity) {
			clearReading();
			readingIdentity = identity;
			touch();
		}
		// A reading can also be missing because a poll under a different credential failed
		// and took it away. Returning to the credential the cache was read under leaves the
		// identity unchanged, so keying this on the reading itself is what lets those windows
		// come back instead of buying a request for facts already held.
		if (windows.length === 0) {
			const saved = usageCache.get(request.identity);
			if (validCachedReading(saved)) {
				const unverified = !request.accountBound && saved.credential !== request.credential;
				const reusable = reusableWindows(saved, modelId);
				if (reusable.length > 0 && !(unverified && blocked)) {
					windows = reusable;
					// A scoped bucket can raise severity without contributing a window, so the
					// model the reading was taken under decides this, not the shape of what
					// survived. An unverified reading may belong to another account: its numbers
					// are marked on screen and its alarm waits for a response to confirm it.
					severity = unverified ? "normal" : effectiveSeverity(saved, saved.modelId === modelId);
					readingAt = saved.at;
					provisional = unverified;
				}
			}
			touch();
		}
		if (blocked) return;

		lastPoll = Date.now();
		const res = await fetch(request.url, { signal, headers: request.headers, redirect: "error" });
		if (!isCurrent()) return;
		if (!res.ok) {
			applyBackoff(res.status);
			lastError = `HTTP ${res.status}`
				+ (res.status === 401 ? " — OAuth expired/rejected; refresh with /login" : "")
				+ (res.status === 429 ? " — usage endpoint rate limited; retrying in 3m" : "");
			if (res.status === 401 || res.status === 403) {
				clearReading();
				usageCache.delete(request.identity);
				saveUsage();
			}
			touch();
			return;
		}
		const data = await res.json();
		if (!isCurrent()) return;
		const reading = parseUsage(provider, data, modelId);
		windows = reading.windows;
		severity = effectiveSeverity(reading, true);
		readingAt = Date.now();
		usageCache.set(request.identity, { ...reading, at: readingAt, modelId, credential: request.credential });
		provisional = false;
		fails = 0;
		nextAttempt = 0;
		lastError = null;
		saveUsage();
		touch();
	} catch {
		if (!isCurrent()) return;
		applyBackoff();
		lastError = "Usage lookup failed (network or invalid response)";
		touch();
	}
}

async function poll(ctx: any, force = false): Promise<void> {
	if (ctx.mode !== "tui") return;
	selectUsage(ctx);
	expireReading();
	if (pollInFlight) return pollInFlight;
	const controller = new AbortController();
	const generation = ++pollGeneration;
	pollController = controller;
	const timeout = setTimeout(() => controller.abort(POLL_TIMEOUT_REASON), POLL_TIMEOUT_MS);
	timeout.unref?.();
	const interrupted = new Promise<void>((resolve) => {
		controller.signal.addEventListener("abort", () => {
			if (controller.signal.reason === POLL_TIMEOUT_REASON && generation === pollGeneration) {
				applyBackoff();
				lastError = POLL_TIMEOUT_REASON;
				touch();
			}
			resolve();
		}, { once: true });
	});
	const execution = runPoll(ctx, force, controller.signal, generation);
	void execution.catch(() => {});
	const current = Promise.race([execution, interrupted]).finally(() => {
		clearTimeout(timeout);
		if (pollController === controller) pollController = null;
		if (pollInFlight === current) pollInFlight = null;
	});
	pollInFlight = current;
	return current;
}

// ---------------------------------------------------------------- helpers
/** Include legacy Present costs when resuming old sessions; no new rewrites run. */
export function sessionUsageFromEntries(entries: unknown[]): { cost: number } {
	let summedCost = 0;
	type U = { cost?: { total?: number } };
	type E = {
		type?: string;
		customType?: string;
		data?: { cost?: unknown };
		usage?: U;
		message?: { usage?: U };
	};
	for (const raw of entries) {
		const entry = raw as E;
		const entryCost = entry.message?.usage?.cost?.total ?? entry.usage?.cost?.total;
		if (typeof entryCost === "number" && Number.isFinite(entryCost) && entryCost >= 0) summedCost += entryCost;
		if (entry.type !== "custom" || entry.customType !== "present") continue;
		if (typeof entry.data?.cost === "number" && Number.isFinite(entry.data.cost) && entry.data.cost >= 0) {
			summedCost += entry.data.cost;
		}
	}
	return { cost: summedCost };
}

/** Walk in full because resume/tree navigation changes the active conversation. */
const totalUsage = (ctx: any): { cost: number } => {
	try {
		return sessionUsageFromEntries(ctx.sessionManager.getEntries() as unknown[]);
	} catch {
		return { cost }; // keep the last good figure instead of flashing zero
	}
};

// "claude-opus-5" -> "Opus 5", "claude-haiku-4-5" -> "Haiku 4.5".
// Claude Code shows the model's display_name with the "(1M context)" suffix cut
// off; pi's model.name is usually that same display name, so prefer it.
const modelLabel = selectedModelLabel;

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
const resetKey = () => windows.map(window => fmtReset(window.resetsAt)).join("\u0001");

export default function (pi: ExtensionAPI) {
	let currentCtx: any;
	pi.on("turn_end", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		ctxPct = readPct(ctx);
		({ cost } = totalUsage(ctx));
		activityDir = null; // the agent stopped: the folder settles back home
		touch();
		void poll(ctx);
	});
	pi.on("tool_execution_start", (e: any, ctx: any) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		const dir = dirFromArgs(e.args, ctx.sessionManager.getCwd());
		if (dir && dir !== activityDir) {
			activityDir = dir;
			touch();
		}
	});
	pi.on("model_select", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		selectUsage(ctx);
		ctxPct = readPct(ctx);
		fails = 0; // a new provider deserves a fresh attempt
		nextAttempt = 0;
		touch();
		void poll(ctx, true);
	});
	pi.on("thinking_level_select", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		touch();
	});

	pi.registerCommand("limits", {
		description: "Refresh quota for the selected Anthropic or Codex model",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Subscription quota polling is available in the terminal session.", "info");
				return;
			}
			currentCtx = ctx;
			fails = 0;
			nextAttempt = 0;
			await poll(ctx, true);
			if (windows.length === 0) {
				ctx.ui.notify(`${providerTitle(ctx.model?.provider)}: ${lastError ?? "quota not available yet"}`, "warning");
				return;
			}
			const part = (label: string, pct: number, at?: number) =>
				`${label} ${pct}%${at ? ` (${fmtReset(at)})` : ""}`;
			ctx.ui.notify(
				`${providerTitle(ctx.model?.provider)} · ${modelLabel(ctx.model)} · used: ` +
					windows.map(w => part(w.label, w.pct, w.resetsAt)).join("   ") +
					(lastError ? ` — last successful reading; refresh failed: ${lastError}` : ""),
				lastError ? "warning" : "info",
			);
		},
	});

	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		selection = "";
		selectUsage(ctx);
		ctxPct = readPct(ctx);
		// A resumed session has already spent money; starting at zero would report the
		// wrong number until the first turn happened to end.
		({ cost } = totalUsage(ctx));

		ctx.ui.setFooter((tui, _theme, footerData) => {
			const activeContext = () => currentCtx ?? ctx;
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
			const timer = ctx.hasUI ? setInterval(() => void poll(activeContext()), POLL_MS) : undefined;
			timer?.unref?.();
			void poll(ctx, true);
			// Retries until the first reading lands, then stops. Unforced on purpose — the
			// backoff still gates real errors — but each retry is scheduled for the moment
			// that backoff and throttle both allow a request. A fixed tick would spend its
			// whole budget inside the first wait and never reach the network at all, which
			// is what left the footer reading `limits n/a` until someone ran /limits.
			let bootTries = 0;
			let bootTimer: ReturnType<typeof setTimeout> | undefined;
			// An unverified reading is not the first reading: the response that settles it can
			// still take it away, and the chain has to outlive that to replace it.
			const settled = () => windows.length > 0 && !provisional;
			const scheduleBoot = () => {
				if (!ctx.hasUI || settled() || bootTries >= BOOT_TRIES) return;
				bootTries++;
				bootTimer = setTimeout(() => {
					// A reading may have landed since this was scheduled — /limits, or the
					// ordinary poller — and the boot chain exists only until the first one.
					if (settled()) return;
					void poll(activeContext()).finally(scheduleBoot);
				}, bootRetryDelay(Date.now(), lastPoll, nextAttempt));
				bootTimer.unref?.();
			};
			scheduleBoot();
			// Context climbs during a turn with no event to hang off; poll it locally and
			// only mark dirty on a real change so an idle session repaints nothing.
			const ticker = ctx.hasUI
				? setInterval(() => {
						expireReading();
						const next = readPct(activeContext());
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
					if (bootTimer) clearTimeout(bootTimer);
					bootTries = BOOT_TRIES;
					if (ticker) clearInterval(ticker);
					pollGeneration++;
					pollController?.abort(POLL_DISPOSE_REASON);
					unsubBranch();
					requestRender = null;
				},
				invalidate() {
					dirty = true;
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					const ctx = activeContext();
					selectUsage(ctx);
					expireReading();
					const statuses = footerData.getExtensionStatuses();
					const usage = totalUsage(ctx);
					if (usage.cost !== cost) {
						cost = usage.cost;
						dirty = true;
					}
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
					const contextSize = contextWindowLabel(ctx.model?.contextWindow);
					if (contextSize) add(`${DIM}${contextSize}${R}`, contextSize.length, 4);
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
					for (const window of windows) {
						// `*`: not confirmed by the credential in hand — either the refresh failed
						// or the reading was taken under a credential this one cannot vouch for.
						const label = window.label + (lastError || provisional ? "*" : "");
						limitSeg(label, window.pct, window.resetsAt, 3);
					}
					if (windows.length === 0 && ctx.model?.provider) {
						const label = "limits " + (lastError ? "n/a" : "…");
						add(`${GREY}${label}${R}`, label.length, 4);
					}

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
						// A status that carries its own colour ends in a reset (the themed
						// background-tasks badge does), which would leave every later status
						// uncoloured. Re-open grey after each one instead of once per line.
						.join(`${R}  ${GREY}`);
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
