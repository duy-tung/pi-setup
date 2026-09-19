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
 *   - context: project the current snapshot through the pure lib/context-snapshots.ts
 *     helper, retaining history and dropping retired permission snapshots. Both hooks
 *     share this extension instance's closure, not state imported by another entrypoint.
 *
 * The snapshot deliberately excludes anything that changes on every prompt
 * (timestamps with time-of-day, token counts): a diffed channel only pays off
 * when the content is stable most of the time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { RUNTIME_CONTEXT_TYPE, projectCurrentContextSnapshots } from "./lib/context-snapshots.ts";

const CUSTOM_TYPE = RUNTIME_CONTEXT_TYPE;
const HEADER =
	"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";

export const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_CACHE_MS = 5_000;

type GitStatusRunner = (cwd: string, timeoutMs: number) => Promise<string>;
type GitCacheEntry = { line: string | undefined; at: number; pending?: Promise<string | undefined> };

function runGitStatus(cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["status", "--porcelain=v1", "--branch"],
			{ cwd, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1024 * 1024 },
			(error, stdout) => error ? reject(error) : resolve(stdout),
		);
	});
}

function parseGitLine(out: string): string | undefined {
	const lines = out.split("\n");
	const head = lines[0] ?? "";
	// "## main...origin/main [ahead 1, behind 2]" | "## HEAD (no branch)"
	const m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
	if (!m) return undefined;
	const dirty = lines.filter((line) => line.trim() !== "" && !line.startsWith("##")).length;
	const parts = [`branch ${m[1]}`];
	if (m[3]) parts.push(m[3]);
	parts.push(dirty === 0 ? "clean" : `${dirty} dirty file${dirty === 1 ? "" : "s"}`);
	return `Git: ${parts.join(", ")}`;
}

export function createRuntimeSnapshotter(
	run: GitStatusRunner = runGitStatus,
	now: () => number = Date.now,
	cacheMs = GIT_CACHE_MS,
) {
	const cache = new Map<string, GitCacheEntry>();

	const seed = (cwd: string, snapshot: string | null): void => {
		const line = snapshot?.split("\n").find((value) => value.startsWith("Git: "));
		if (line) cache.set(cwd, { line, at: Number.NEGATIVE_INFINITY });
	};

	const gitLine = async (cwd: string): Promise<string | undefined> => {
		const previous = cache.get(cwd);
		if (previous && now() - previous.at < cacheMs) return previous.line;
		if (previous?.pending) return previous.pending;
		const pending = run(cwd, GIT_STATUS_TIMEOUT_MS)
			.then((out) => {
				const line = parseGitLine(out);
				cache.set(cwd, { line, at: now() });
				return line;
			})
			.catch(() => {
				// Timeout/failure reuses the last good line. This prevents a transient
				// omission from creating a false runtime-context change.
				cache.set(cwd, { line: previous?.line, at: now() });
				return previous?.line;
			});
		cache.set(cwd, { line: previous?.line, at: previous?.at ?? 0, pending });
		return pending;
	};

	return {
		seed,
		async build(cwd: string): Promise<string> {
			const facts: string[] = [];
			const git = await gitLine(cwd);
			if (git) facts.push(git);
			// en-CA gives YYYY-MM-DD in local time; day granularity keeps the diff quiet.
			facts.push(`Date: ${new Date(now()).toLocaleDateString("en-CA")}`);
			return `${HEADER}\n\n${facts.join("\n")}`;
		},
	};
}

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Pi caches factories but uses separate jiti instances for separate entrypoints.
	// Keep all mutable state inside this factory invocation.
	let runtimeSnapshotter = createRuntimeSnapshotter();
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
		runtimeSnapshotter.seed(ctx.cwd, lastEmitted);
	};

	pi.on("session_start", (_e, ctx) => {
		runtimeSnapshotter = createRuntimeSnapshotter();
		recover(ctx);
	});
	pi.on("session_tree", (_e, ctx) => recover(ctx));
	pi.on("context", (event) => ({
		messages: projectCurrentContextSnapshots(event.messages, lastEmitted),
	}));

	pi.on("before_agent_start", async (_e, ctx) => {
		const snapshot = await runtimeSnapshotter.build(ctx.cwd);
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
