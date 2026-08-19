/**
 * runtime-context: keep mutable facts out of the system prompt.
 *
 * Ported from DeepSeek Harness (packages/core/agent-loop runtime-context):
 * facts that change during a session (cwd, git branch, date) must not live in
 * the system prompt — every change there invalidates the provider's KV cache
 * for the whole conversation. Instead they arrive as an append-only custom
 * message ("runtime context snapshot") that is emitted ONLY when its content
 * actually changed since the last emitted snapshot.
 *
 * Mechanics:
 *   - before_agent_start: build the snapshot; if identical to the last one
 *     emitted, emit nothing. Otherwise inject a custom message (persisted,
 *     participates in LLM context) whose header tells the model it supersedes
 *     earlier snapshots.
 *   - session_start: recover the last emitted snapshot from the session branch
 *     so resume/fork does not re-emit an identical message.
 *
 * The snapshot deliberately excludes anything that changes on every prompt
 * (timestamps with time-of-day, token counts): a diffed channel only pays off
 * when the content is stable most of the time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

const CUSTOM_TYPE = "runtime-context";
const HEADER =
	"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";

function gitLine(cwd: string): string | undefined {
	try {
		// One porcelain call yields branch, upstream divergence and dirty count.
		const out = execSync("git status --porcelain=v1 --branch", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
			encoding: "utf8",
		});
		const lines = out.split("\n");
		const head = lines[0] ?? "";
		// "## main...origin/main [ahead 1, behind 2]" | "## HEAD (no branch)"
		const m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
		if (!m) return undefined;
		const dirty = lines.filter((l) => l.trim() !== "" && !l.startsWith("##")).length;
		const parts = [`branch ${m[1]}`];
		if (m[3]) parts.push(m[3]); // "ahead 1, behind 2"
		parts.push(dirty === 0 ? "clean" : `${dirty} dirty file${dirty === 1 ? "" : "s"}`);
		return `Git: ${parts.join(", ")}`;
	} catch {
		return undefined; // not a repo, no git, or timeout — omit the line
	}
}

function buildSnapshot(cwd: string): string {
	const facts: string[] = [`Working directory: ${cwd}`];
	const git = gitLine(cwd);
	if (git) facts.push(git);
	// en-CA gives YYYY-MM-DD in local time; day granularity keeps the diff quiet.
	facts.push(`Date: ${new Date().toLocaleDateString("en-CA")}`);
	return `${HEADER}\n\n${facts.join("\n")}`;
}

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let lastEmitted: string | null = null;

	pi.on("session_start", (_e, ctx) => {
		lastEmitted = null;
		// Recover the latest snapshot on the active branch so a resume with an
		// unchanged environment emits nothing.
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const en = entries[i];
			if (en.type === "custom_message" && en.customType === CUSTOM_TYPE) {
				lastEmitted = textOf(en.content);
				break;
			}
		}
	});

	pi.on("before_agent_start", (_e, ctx) => {
		const snapshot = buildSnapshot(ctx.cwd);
		if (snapshot === lastEmitted) return;
		lastEmitted = snapshot;
		return {
			message: {
				customType: CUSTOM_TYPE,
				content: snapshot,
				// Keep the transcript quiet: the snapshot is for the model.
				display: false,
				details: undefined,
			},
		};
	});
}
