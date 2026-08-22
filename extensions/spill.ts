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
 *   - absolutely best-effort: a failed spill leaves the result untouched and
 *     never turns it into an error;
 *   - the replacement is smaller than the budget by construction.
 *
 * Pi-specific: when core bash truncation saved the complete output in a raw
 * OS-temp file, copy it only when it can be read, bounded, redacted, and stored
 * privately. Otherwise withhold the raw locator and keep a safe inline preview.
 *
 * Security: everything spill writes (and the inline preview it emits) goes
 * through the same redaction list as secret-guard (./lib/redact), so a spill
 * file never holds a credential the transcript would have hidden.
 *
 * GC: on session_start, spill dirs older than MAX_AGE_DAYS are deleted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./lib/redact.ts";

const MAX_INLINE_BYTES = 16 * 1024;
const HEAD_CHARS = 2 * 1024;
const TAIL_CHARS = 2 * 1024;
/** Raw core output larger than this is withheld rather than exposed or copied. */
const MAX_COPY_BYTES = 8 * 1024 * 1024;
const MAX_AGE_DAYS = 7;

const SPILL_ROOT = join(homedir(), ".pi", "agent", "spill");

/** Best-effort: delete spill dirs whose mtime is older than MAX_AGE_DAYS. */
function gcOldSpillDirs(): void {
	try {
		const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		for (const name of readdirSync(SPILL_ROOT)) {
			const dir = join(SPILL_ROOT, name);
			try {
				if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
			} catch {
				// unreadable entry — leave it
			}
		}
	} catch {
		// root missing or unreadable — nothing to collect
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

export default function (pi: ExtensionAPI) {
	// One directory per session, created lazily on first spill.
	let spillDir: string | null = null;
	let created = false;

	pi.on("session_start", () => {
		const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		spillDir = join(SPILL_ROOT, `${stamp}-${randomBytes(4).toString("hex")}`);
		created = false;
		gcOldSpillDirs();
	});

	pi.on("tool_result", (e) => {
		if (e.toolName === "read") return; // anti-loop: never spill a read
		if (e.content.some((c) => c.type !== "text")) return; // images pass through

		const raw = e.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		if (Buffer.byteLength(raw, "utf8") <= MAX_INLINE_BYTES) return;

		try {
			// Scrub before anything is written or previewed, so neither the spill
			// file nor the inline replacement depends on secret-guard's handler
			// ordering.
			const text = redact(raw).text;
			const inlineBytes = Buffer.byteLength(text, "utf8");

			const writeSpill = (content: string): string | null => {
				if (!spillDir) return null;
				try {
					if (!created) {
						mkdirSync(spillDir, { recursive: true, mode: 0o700 });
						created = true;
					}
					const p = join(spillDir, `${e.toolName}-${randomBytes(4).toString("hex")}.txt`);
					writeFileSync(p, content, { flag: "wx", mode: 0o600 });
					return p;
				} catch {
					return null;
				}
			};

			// Full-text source: when core bash truncation saved the complete output,
			// re-spill it as a scrubbed durable copy (core's file is raw and lives in
			// OS temp). For everything else the inline content IS the complete
			// output — core caps at 50 KiB, our budget is below that.
			const coreFull =
				e.toolName === "bash" &&
				e.details &&
				typeof (e.details as { fullOutputPath?: unknown }).fullOutputPath === "string"
					? (e.details as { fullOutputPath: string }).fullOutputPath
					: undefined;

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

			const head = headOf(text, HEAD_CHARS);
			const tail = tailOf(text, TAIL_CHARS);
			const omitted = inlineBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
			const notice = path
				? `[spill: output was ${fmtKiB(fullBytes)} — full text saved to ${path}. Preview below; use read or grep on that file for the rest.]`
				: `[spill: output was ${fmtKiB(fullBytes)} — full text withheld because it could not be stored safely. Redacted inline preview below.]`;
			const replacement = [
				notice,
				"",
				head,
				`[... ${fmtKiB(Math.max(omitted, 0))} omitted from inline preview ...]`,
				tail,
			].join("\n");

			return { content: [{ type: "text", text: replacement }] };
		} catch {
			return; // best-effort: on any failure keep the original result
		}
	});
}
