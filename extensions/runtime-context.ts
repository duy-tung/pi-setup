/**
 * runtime-context: keep mutable branch/date facts out of the system prompt.
 *
 * Ported from DeepSeek Harness (packages/core/agent-loop runtime-context):
 * facts that change during a session should not invalidate the provider's KV
 * cache for the whole conversation. Pi core already owns cwd in its system
 * prompt, so this extension avoids duplicating it and sends branch/date facts
 * as a custom message ("runtime context snapshot") that is emitted ONLY when
 * its content actually changed since the last emitted snapshot.
 *
 * Mechanics:
 *   - before_agent_start: build the snapshot; if identical to the last one
 *     emitted, emit nothing. Otherwise inject a custom message (persisted,
 *     participates in LLM context) whose header tells the model it supersedes
 *     earlier snapshots.
 *   - session_start/session_tree: recover the latest snapshot from the active
 *     branch so resume/fork/navigation does not reuse another branch's state.
 *   - context-snapshots.ts keeps all entries durable but sends only the newest
 *     runtime and permission snapshot to each provider request.
 *
 * The snapshot deliberately excludes anything that changes on every prompt
 * (timestamps with time-of-day, token counts): a diffed channel only pays off
 * when the content is stable most of the time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { RUNTIME_CONTEXT_TYPE, setCurrentContextSnapshot } from "./context-snapshots.ts";

const CUSTOM_TYPE = RUNTIME_CONTEXT_TYPE;
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

export function buildRuntimeSnapshot(cwd: string): string {
	const facts: string[] = [];
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

	const recover = (ctx: ExtensionContext) => {
		lastEmitted = null;
		// Recover from the active branch so resume/tree navigation emits only when
		// the current environment differs from that branch's latest snapshot.
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const en = entries[i];
			if (en.type === "custom_message" && en.customType === CUSTOM_TYPE) {
				lastEmitted = textOf(en.content);
				break;
			}
		}
		setCurrentContextSnapshot(CUSTOM_TYPE, lastEmitted);
	};

	pi.on("session_start", (_e, ctx) => recover(ctx));
	pi.on("session_tree", (_e, ctx) => recover(ctx));

	pi.on("before_agent_start", (_e, ctx) => {
		const snapshot = buildRuntimeSnapshot(ctx.cwd);
		setCurrentContextSnapshot(CUSTOM_TYPE, snapshot);
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
