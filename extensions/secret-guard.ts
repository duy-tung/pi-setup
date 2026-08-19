/**
 * secret-guard: keep credentials out of the model context and the session log.
 *
 * Two layers, because either one alone leaks:
 *
 *   1. tool_call  -> block reads/writes of known credential paths. Deterministic,
 *      but only catches paths the agent names literally.
 *   2. tool_result -> redact credential-shaped strings from every tool's output.
 *      Catches what layer 1 cannot: `cat *.json`, `env`, `gh auth status`,
 *      a token pasted into some unrelated log file.
 *
 * Layer 2 is the one that matters for the session file. pi's afterToolCall hook
 * replaces the tool result *before* it is appended to the transcript and before
 * it is sent to the provider (core/agent-session.js), so a redacted secret was
 * never written to disk and never left the machine.
 *
 * What this does NOT cover:
 *   - `/bash` run by the user directly (user_bash goes through a different hook)
 *   - the model reasoning a secret out loud after seeing it some other way
 *   - auth.json itself, which legitimately holds the tokens in plaintext
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { redact } from "./lib/redact";

const HOME = homedir();

/** Paths the agent has no business reading, writing or editing. */
const DENY_PATH: { re: RegExp; what: string }[] = [
	{ re: /\/\.pi\/agent\/auth\.json$/, what: "pi OAuth store" },
	{ re: /\/\.pi\/agent\/scrub-backups\.txt$/, what: "scrub backup list" },
	{ re: /\.bak$/, what: "scrub backup (may hold un-redacted secrets)" },
	// (\/|$): the bare directory is as readable as anything inside it — `cat ~/.ssh`
	// fails, but `ls ~/.ssh` then targeted reads is a two-step walk around a rule
	// that only matched with a trailing slash.
	{ re: /\/\.ssh(\/|$)/, what: "SSH keys" },
	{ re: /\/\.aws(\/|$)/, what: "AWS credentials" },
	{ re: /\/\.config\/gcloud(\/|$)/, what: "gcloud credentials" },
	{ re: /\/\.kube(\/|$)/, what: "kubeconfig" },
	{ re: /\/\.config\/gh\/hosts\.yml$/, what: "gh token" },
	// Template env files are committed on purpose and hold placeholders, not
	// secrets; blocking them just teaches the agent to work around the guard.
	{ re: /\/\.env(?!\.(example|sample|template|dist)$)(\.[^/]+)?$/, what: "env file" },
	{ re: /\/\.netrc$/, what: ".netrc" },
	{ re: /\/\.npmrc$/, what: ".npmrc (may hold registry tokens)" },
	{ re: /\/\.pgpass$/, what: ".pgpass" },
	{ re: /\/id_(rsa|dsa|ecdsa|ed25519)$/, what: "private key" },
	{ re: /\.(pem|p12|pfx|keystore|jks)$/, what: "key material" },
];

/**
 * Commands that dump credentials no matter what path they touch. Kept short on
 * purpose: broad command blocking is easy to work around and annoying to live
 * with, and layer 2 already neutralises the output.
 */
const DENY_CMD: { re: RegExp; what: string }[] = [
	{ re: /\bgh\s+auth\s+token\b/, what: "gh auth token" },
	{ re: /\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)\b/, what: "macOS keychain dump" },
	{ re: /\bpass\s+show\b/, what: "pass secret store" },
	{ re: /\bop\s+(read|item\s+get)\b/, what: "1Password CLI" },
];

// Credential shapes live in ./lib/redact so spill.ts scrubs its on-disk
// files with the same list that scrubs inline results here.

// Tilde first, then resolve: the old order expanded ~ after resolve() had already
// glued cwd on, which made the expansion dead code.
const abs = (p: string, cwd: string) => {
	const t = p.replace(/^~(?=\/|$)/, HOME);
	return isAbsolute(t) ? t : resolve(cwd, t);
};

function deniedPath(p: string, cwd: string) {
	const full = abs(p, cwd);
	return DENY_PATH.find((d) => d.re.test(full));
}

/**
 * Every literal token in a shell command, resolved and tested as a path.
 *
 * The old version only took tokens that *looked* like paths (`~`, `/`, `./`),
 * which let `cat .env` walk straight past layer 1 — the file most worth blocking
 * is the one most often named bare. Testing every token instead costs nothing:
 * `cat` resolved against cwd matches no deny rule.
 *
 * Two shapes are excluded because they are never the file itself: flags
 * (`--include=*.pem` names a pattern, not a path) and glob tokens (`*.bak` —
 * whatever the shell expands them to comes back through layer 2, which is the
 * layer that owns globs). What remains deliberately blocked: a bare `cert.pem`
 * — the key-material rule cannot tell a public cert from a private key by name,
 * and "ask the user" is the right failure mode for both.
 */
function commandPaths(cmd: string): string[] {
	return cmd
		.split(/[\s'";|&$()<>]+/)
		.filter((t) => t && !t.startsWith("-") && !/[*?]/.test(t));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (e, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();

		if (e.toolName === "bash") {
			const cmd = String((e.input as { command?: string }).command ?? "");
			const bad = DENY_CMD.find((d) => d.re.test(cmd));
			if (bad) {
				return { block: true, reason: `secret-guard: blocked ${bad.what}. Ask the user to run it themselves.` };
			}
			for (const p of commandPaths(cmd)) {
				const hit = deniedPath(p, cwd);
				if (hit) {
					return {
						block: true,
						reason: `secret-guard: '${p}' is ${hit.what}. Blocked. If you need something from it, ask the user.`,
					};
				}
			}
			return;
		}

		if (e.toolName === "read" || e.toolName === "edit" || e.toolName === "write") {
			const p = (e.input as { path?: string }).path;
			if (!p) return;
			const hit = deniedPath(p, cwd);
			if (hit) {
				return { block: true, reason: `secret-guard: '${p}' is ${hit.what}. Blocked.` };
			}
		}
	});

	pi.on("tool_result", (e, ctx) => {
		const hits: string[] = [];
		let changed = false;

		const content = e.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const r = redact(part.text);
			if (r.text === part.text) return part;
			changed = true;
			for (const h of r.hits) if (!hits.includes(h)) hits.push(h);
			return { ...part, text: r.text };
		});

		if (!changed) return;
		ctx.ui?.notify?.(`secret-guard: redacted ${hits.join(", ")} from ${e.toolName} output`, "warning");
		return { content };
	});
}
