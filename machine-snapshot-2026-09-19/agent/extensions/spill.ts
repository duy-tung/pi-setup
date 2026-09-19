/**
 * spill: large tool outputs go to a file, not into the context window.
 *
 * Ported from DeepSeek Harness (packages/spill/spill-policy): when a tool
 * result exceeds an inline budget, save the FULL text to a file and replace
 * the inline result with a short notice + head/tail preview + the real file
 * path. The model recovers the rest with the read/grep tools it already has —
 * no new tool, no silent truncation.
 *
 * DSH details kept on purpose:
 *   - skip the `read` tool (spilling a read invites a read → spill → read loop);
 *   - skip results carrying image blocks;
 *   - best-effort: ordinary spill failures never become tool errors; known raw
 *     Bash locators are withheld when a safe full-output copy cannot be made;
 *   - the replacement is smaller than the budget by construction.
 *
 * Pi-specific: when core bash truncation saved the complete output in a raw
 * OS-temp file, copy it only when it can be read, bounded, redacted, and stored
 * privately. Otherwise withhold the raw locator and keep a safe inline preview.
 * This also applies below the inline budget (core may truncate by line count).
 * Short previews stay intact, and result details point only to the safe copy.
 * Bash errors can lose that metadata; recognizable text-only locators are then
 * suppressed without opening or deleting any file named by untrusted output.
 *
 * Security: everything spill writes (and the inline preview it emits) goes
 * through the same redaction list as secret-guard (./lib/redact), so a spill
 * file never holds a credential the transcript would have hidden.
 *
 * GC: new spill dirs carry an ownership marker. On session_start, only marked
 * dirs older than MAX_AGE_DAYS and unreferenced by a session are deleted.
 * Pre-existing/unmarked data is never adopted or removed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./lib/redact.ts";

// 32 KiB: below core's 50 KiB bash cap, but high enough that typical agent/tool
// results stay inline instead of forcing a second read of the spill file.
const MAX_INLINE_BYTES = 32 * 1024;
const HEAD_CHARS = 2 * 1024;
const TAIL_CHARS = 2 * 1024;
/** Raw core output larger than this is withheld rather than exposed or copied. */
const MAX_COPY_BYTES = 8 * 1024 * 1024;
const MAX_AGE_DAYS = 7;
export const SPILL_OWNER_MARKER = ".pi-setup-spill-v1";

const AGENT_ROOT = join(homedir(), ".pi", "agent");
const SPILL_ROOT = join(AGENT_ROOT, "spill");
const SESSION_ROOT = join(AGENT_ROOT, "sessions");

type SpillMarker = { version: 1; createdAt: number };

/** One-directory-per-session HOME-relative GC state. Nothing here is loader-global. */
type SpillGc = { running: Promise<void> | null; cancelled: boolean; afterBatch?: () => void };

/**
 * Read every durable session file once, asynchronously, and report which of the
 * candidates it references. Unreadable, symlinked or unexpected entries fail
 * closed: they count as referencing every candidate. Only a missing session
 * root proves there can be no durable reference.
 */
async function sessionReferences(candidates: string[], gc: SpillGc): Promise<Set<string> | "all"> {
	const referenced = new Set<string>();
	const visit = async (path: string): Promise<boolean> => {
		if (gc.cancelled) return false;
		let stat;
		try {
			stat = await fsp.lstat(path);
		} catch {
			return false;
		}
		if (stat.isSymbolicLink()) return false;
		if (stat.isDirectory()) {
			let names: string[];
			try {
				names = await fsp.readdir(path);
			} catch {
				return false;
			}
			for (const name of names) if (!(await visit(join(path, name)))) return false;
			return true;
		}
		if (!stat.isFile()) return false;
		let text: string;
		try {
			text = await fsp.readFile(path, "utf8");
		} catch {
			return false;
		}
		for (const candidate of candidates) if (text.includes(candidate)) referenced.add(candidate);
		return true;
	};
	let names: string[];
	try {
		names = await fsp.readdir(SESSION_ROOT);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? referenced : "all";
	}
	for (const name of names) if (!(await visit(join(SESSION_ROOT, name)))) return "all";
	return gc.cancelled ? "all" : referenced;
}

/**
 * Best-effort GC for future-owned, expired, unreferenced spill directories only.
 * Fully asynchronous: one batch scan for all expired candidates, then a fresh
 * scan immediately before each deletion narrows (never closes) the race with a
 * session appended concurrently. Cancellation is checked after every await.
 */
export async function gcOldSpillDirs(gc: SpillGc = { running: null, cancelled: false }): Promise<void> {
	try {
		const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		const expired: string[] = [];
		for (const name of await fsp.readdir(SPILL_ROOT)) {
			if (gc.cancelled) return;
			const dir = join(SPILL_ROOT, name);
			try {
				const markerPath = join(dir, SPILL_OWNER_MARKER);
				const markerStat = await fsp.lstat(markerPath);
				if (!markerStat.isFile() || markerStat.isSymbolicLink()) continue;
				const marker = JSON.parse(await fsp.readFile(markerPath, "utf8")) as Partial<SpillMarker>;
				if (marker.version !== 1 || typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) continue;
				if (marker.createdAt < cutoff) expired.push(dir);
			} catch {
				// Unmarked, malformed or unreadable — leave it.
			}
		}
		if (!expired.length || gc.cancelled) return;
		const batch = await sessionReferences(expired, gc);
		if (batch === "all" || gc.cancelled) return;
		gc.afterBatch?.(); // Test seam: a session appended between the two scans.
		for (const dir of expired) {
			if (batch.has(dir) || gc.cancelled) continue;
			const fresh = await sessionReferences([dir], gc);
			if (fresh === "all" || fresh.has(dir) || gc.cancelled) continue;
			try {
				await fsp.rm(dir, { recursive: true, force: true });
			} catch {
				// Failed deletion — leave it.
			}
		}
	} catch {
		// Root missing or unreadable — nothing to collect.
	}
}

function fmtKiB(bytes: number): string {
	return `${Math.round(bytes / 1024)} KiB`;
}

/** First ~n chars, cut back to the last complete line. */
function headOf(text: string, n: number): string {
	if (text.length <= n) return text;
	const slice = text.slice(0, n);
	const nl = slice.lastIndexOf("\n");
	return nl > 0 ? slice.slice(0, nl) : slice;
}

/** Last ~n chars, cut forward to the first complete line. */
function tailOf(text: string, n: number): string {
	if (text.length <= n) return text;
	const slice = text.slice(-n);
	const nl = slice.indexOf("\n");
	return nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
}

/** Remove Pi core's final raw-temp locator before composing any preview. */
export function withoutCoreRawLocator(text: string, rawPath: string): string {
	const suffix = `. Full output: ${rawPath}]`;
	if (!text.endsWith(suffix)) return text;
	const footerStart = text.lastIndexOf("\n\n[");
	return footerStart >= 0 ? text.slice(0, footerStart) : text;
}

/** Error text is not file authority: redact recognizable core footers, never follow them. */
function withoutUntrustedErrorLocators(text: string): string {
	return text.replace(
		/(\n\n\[Showing (?:lines|last) [^\r\n]*?\. )Full output: [^\r\n]*\]/g,
		"$1Full output locator withheld (missing trusted metadata)]",
	);
}

export default function (pi: ExtensionAPI) {
	// One directory per session, created lazily on first spill.
	let spillDir: string | null = null;
	let created = false;
	// Single-flight per extension instance; never blocks session_start.
	let gc: SpillGc = { running: null, cancelled: false };

	pi.on("session_start", () => {
		const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		spillDir = join(SPILL_ROOT, `${stamp}-${randomBytes(4).toString("hex")}`);
		created = false;
		if (!gc.running) {
			gc = { running: null, cancelled: false };
			gc.running = gcOldSpillDirs(gc).finally(() => { gc.running = null; });
		}
	});

	pi.on("session_shutdown", async () => {
		// Cancel future work; an in-flight deletion is awaited, not abandoned.
		gc.cancelled = true;
		await gc.running;
	});

	pi.on("tool_result", (e) => {
		if (e.toolName === "read") return; // anti-loop: never spill a read
		if (e.content.some((c) => c.type !== "text")) return; // images pass through

		const coreFull =
			e.toolName === "bash" &&
			e.details &&
			typeof (e.details as { fullOutputPath?: unknown }).fullOutputPath === "string"
				? (e.details as { fullOutputPath: string }).fullOutputPath
				: undefined;
		const raw = e.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		const safeRaw = !coreFull && e.toolName === "bash" && e.isError ? withoutUntrustedErrorLocators(raw) : raw;
		if (!coreFull && safeRaw === raw && Buffer.byteLength(raw, "utf8") <= MAX_INLINE_BYTES) return;

		try {
			// Scrub before anything is written or previewed, so neither the spill
			// file nor the inline replacement depends on secret-guard's handler
			// ordering.
			// Strip the locator before redaction so even a credential-shaped path cannot survive.
			const text = redact(coreFull ? withoutCoreRawLocator(raw, coreFull) : safeRaw).text;
			const inlineBytes = Buffer.byteLength(text, "utf8");
			if (!coreFull && safeRaw !== raw && inlineBytes <= MAX_INLINE_BYTES) {
				return { content: [{ type: "text", text }] };
			}

			const writeSpill = (content: string): string | null => {
				if (!spillDir) return null;
				try {
					if (!created) {
						mkdirSync(spillDir, { recursive: true, mode: 0o700 });
						writeFileSync(
							join(spillDir, SPILL_OWNER_MARKER),
							JSON.stringify({ version: 1, createdAt: Date.now() } satisfies SpillMarker),
							{ flag: "wx", mode: 0o600 },
						);
						created = true;
					}
					const p = join(spillDir, `${e.toolName}-${randomBytes(4).toString("hex")}.txt`);
					writeFileSync(p, content, { flag: "wx", mode: 0o600 });
					return p;
				} catch {
					return null;
				}
			};

			// Prefer core's complete raw Bash output. Other tools may already have
			// truncated their returned text; only that returned text can be preserved.

			let path: string | null = null;
			let fullBytes = inlineBytes;
			if (coreFull) {
				try {
					fullBytes = statSync(coreFull).size;
					if (fullBytes <= MAX_COPY_BYTES) {
						path = writeSpill(redact(readFileSync(coreFull, "utf8")).text);
						if (path) {
							try {
								unlinkSync(coreFull);
							} catch {
								// The private redacted copy is authoritative; OS temp cleanup remains a fallback.
							}
						}
					}
				} catch {
					// Do not expose a raw locator when stat/read/copy fails.
				}
			} else {
				path = writeSpill(text);
			}

			const notice = path
				? `[spill: output was ${fmtKiB(fullBytes)} — full text saved to ${path}. Preview below; use read or grep on that file for the rest.]`
				: `[spill: output was ${fmtKiB(fullBytes)} — full text withheld because it could not be stored safely. Redacted inline preview below.]`;
			let replacement = `${notice}\n\n${text}`;
			if (Buffer.byteLength(replacement, "utf8") > MAX_INLINE_BYTES) {
				const head = headOf(text, HEAD_CHARS);
				const tail = tailOf(text, TAIL_CHARS);
				const omitted = inlineBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
				replacement = [notice, "", head,
					`[... ${fmtKiB(Math.max(omitted, 0))} omitted from inline preview ...]`, tail].join("\n");
			}

			return {
				content: [{ type: "text", text: replacement }],
				// The raw path must not remain in persisted tool-result metadata either.
				...(coreFull ? { details: { ...(e.details as Record<string, unknown>), fullOutputPath: path ?? undefined } } : {}),
			};
		} catch {
			return; // best-effort: on any failure keep the original result
		}
	});
}
