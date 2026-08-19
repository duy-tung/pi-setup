/**
 * permission-gate: confirm before destructive commands, Claude Code-style.
 *
 * Three tiers, two of which live elsewhere:
 *
 *   - BLOCK    -> secret-guard.ts owns credential paths/commands. Not here.
 *   - CONFIRM  -> this file: irreversible or blast-radius commands pause for
 *                 an explicit user decision (Allow once / Always / Deny).
 *   - ALLOW    -> everything else runs untouched. No prompt fatigue.
 *
 * Non-interactive runs (print mode, sub-agents: ctx.hasUI === false) cannot
 * ask, so a CONFIRM hit is blocked outright with a reason telling the agent
 * to surface the command to the user. An implementer sub-agent can therefore
 * never rm -rf on its own, which is stricter than Claude Code's default.
 *
 * This is an accident guard, not a malice guard: regex matching on a shell
 * string can be worked around (variables, heredocs, scripts written to disk
 * then executed). The threat model is the screenshot that motivated it — an
 * agent taking the short path because nothing made it stop and ask.
 *
 * "Always allow" decisions persist per rule id in
 * ~/.pi/agent/permission-gate.json and apply globally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

const HOME = homedir();
const STORE = `${HOME}/.pi/agent/permission-gate.json`;

/**
 * Sub-agents (DSH delegated policy): a child pi in a detached tmux pane has
 * hasUI === true, but nobody is watching — a dialog there is a silent hang.
 * Treat children as non-interactive: deterministic block, report back.
 */
const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

/** Bash commands that pause for confirmation. First match wins. Exported for tests. */
export const CONFIRM_CMD: { id: string; re: RegExp; what: string }[] = [
	{ id: "sudo", re: /\bsudo\b/, what: "sudo (root privileges)" },
	{
		id: "rm-recursive-force",
		re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]|\brm\s+.*--(force|recursive)\b/,
		what: "rm with -r/-f (recursive/forced delete)",
	},
	{ id: "find-delete", re: /\bfind\b[^\n|;]*\s-delete\b/, what: "find -delete (bulk delete)" },
	{ id: "xargs-rm", re: /\bxargs\b[^\n|;]*\brm\b/, what: "xargs rm (bulk delete)" },
	{
		id: "git-destructive",
		re: /\bgit\s+(push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b|--delete\b|\s:\S)|reset\s+--hard\b|clean\s+(-[a-zA-Z]*f|--force)|branch\s+(-D\b|--delete\s+--force))/,
		what: "destructive git (force-push, hard reset, clean, branch -D)",
	},
	{
		id: "disk-destroyer",
		re: /\bdd\b[^\n|;]*\bof=|\b(mkfs|diskutil\s+(erase\w*|partitionDisk)|shred)\b/,
		what: "raw disk write / erase",
	},
	{
		id: "recursive-perms",
		re: /\b(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*\b|--recursive\b)/,
		what: "recursive chmod/chown",
	},
	{
		id: "pipe-to-shell",
		re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?\S*(sh|bash|zsh)\b/,
		what: "piping a download into a shell",
	},
	{ id: "power", re: /\b(shutdown|reboot|halt)\b/, what: "shutdown/reboot" },
	{ id: "publish", re: /\b(npm|pnpm|yarn)\s+publish\b/, what: "package publish (public, irreversible)" },
];

/**
 * write/edit outside the project pause too. /tmp and the OS tempdir stay
 * free: scratch files are the normal, boring case.
 */
const WRITE_RULE = { id: "write-outside-project", what: "writing outside the project directory" };

const abs = (p: string, cwd: string) => {
	const t = p.replace(/^~(?=\/|$)/, HOME);
	return isAbsolute(t) ? t : resolve(cwd, t);
};

const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

function alwaysAllowed(): Set<string> {
	try {
		const j = JSON.parse(readFileSync(STORE, "utf8"));
		return new Set(Array.isArray(j.allowAlways) ? j.allowAlways : []);
	} catch {
		return new Set();
	}
}

function rememberAllow(id: string) {
	const set = alwaysAllowed();
	set.add(id);
	writeFileSync(STORE, JSON.stringify({ allowAlways: [...set].sort() }, null, "\t") + "\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (e, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();

		let hit: { id: string; what: string } | undefined;
		let detail = "";

		if (e.toolName === "bash") {
			const cmd = String((e.input as { command?: string }).command ?? "");
			hit = CONFIRM_CMD.find((r) => r.re.test(cmd));
			detail = cmd;
		} else if (e.toolName === "write" || e.toolName === "edit") {
			const p = (e.input as { path?: string }).path;
			if (p) {
				const full = abs(p, cwd);
				if (!under(full, resolve(cwd)) && !under(full, "/tmp") && !under(full, tmpdir())) {
					hit = WRITE_RULE;
					detail = full;
				}
			}
		}

		if (!hit) return;
		if (alwaysAllowed().has(hit.id)) return;

		if (!ctx.hasUI || IS_SUBAGENT) {
			return {
				block: true,
				reason:
					`permission-gate: ${hit.what} requires user approval, and this run is non-interactive. ` +
					`Do not retry or work around it. Report the exact command back so the user can run or approve it.`,
			};
		}

		const shown = detail.length > 600 ? detail.slice(0, 600) + " …" : detail;
		const choice = await ctx.ui.select(`permission-gate: ${hit.what}`, [
			"Allow once",
			`Always allow (${hit.id})`,
			"Deny",
		], );

		if (choice === "Allow once") return;
		if (choice?.startsWith("Always allow")) {
			rememberAllow(hit.id);
			return;
		}
		return {
			block: true,
			reason:
				`permission-gate: user denied ${hit.what}. Do not retry or work around it. ` +
				`Ask the user how to proceed. Command was:\n${shown}`,
		};
	});
}
