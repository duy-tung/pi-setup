/**
 * sandbox-bash: the single owner of the bash tool override — macOS Seatbelt
 * file sandbox + env scrub + one-shot escalation.
 *
 * Replaces the former env-scrub.ts (its scrub logic lives on unchanged in the
 * spawnHook here); two extensions must not both register "bash".
 *
 * Enforcement model, ported from DeepSeek Harness:
 *   - every model-run bash command is wrapped in `sandbox-exec` with an
 *     allow-default profile that denies file writes outside the workspace,
 *     /tmp, and the OS temp dir (lib/seatbelt.ts has the profile);
 *   - reads and NETWORK are deliberately unrestricted — permission-gate stays
 *     as the intent/UX layer for pipe-to-shell and destructive commands;
 *   - a denied write is reported with a stable "[sandbox: ...]" marker plus an
 *     escalation hint placed AT the point of denial;
 *   - escalation is one-shot: sandbox_permissions ("danger-full-access") +
 *     justification, user approves per call via a confirm dialog, nothing is
 *     persisted — the next call is sandboxed again;
 *   - fail-open is explicit, never silent: on a non-mac platform the tool
 *     registers without sandboxing, drops the escalation params from the
 *     schema, says nothing about sandboxing in its description, and warns once.
 *
 * Layer map (all three remain active):
 *   env scrub (input) -> seatbelt (file effects) -> secret-guard/spill (output)
 *
 * Known limits (accepted): the write/edit tools are in-process and stay under
 * permission-gate, not seatbelt; a settings commandPrefix would run outside
 * the sandbox (unused on this machine); a nested pi inside a sandboxed bash
 * cannot sandbox_apply — classified and reported as a sandbox runner problem;
 * `!` user commands are untouched. Verified against pi v0.84.2 internals.
 */

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
	buildProfile,
	classifyFailure,
	confine,
	DENIAL_MARKER,
	ESCALATION_HINT,
	RUNNER_MARKER,
	writableRoots,
} from "./lib/seatbelt";

// ---------------------------------------------------------------------------
// Env scrub (formerly env-scrub.ts)

const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Exceptions that stay in the child env despite matching SENSITIVE. */
const ALLOWLIST = new Set<string>([
	// e.g. "GITHUB_TOKEN" if you want `gh` to keep working from the agent
]);

/** Pinned last — the caller environment cannot displace these. */
const PINNED: Record<string, string> = {
	NO_COLOR: "1",
	TERM: "dumb",
	PAGER: "cat",
	GIT_PAGER: "cat",
};

function scrub(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (SENSITIVE.test(key) && !ALLOWLIST.has(key)) continue;
		out[key] = value;
	}
	Object.assign(out, PINNED);
	return out;
}

// ---------------------------------------------------------------------------
// Sandbox composition

/** Extra writable roots beyond workspace + /tmp + tmpdir (canonicalized). */
const EXTRA_WRITABLE_ROOTS: string[] = [];

const sandboxActive = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

/** Sub-agent panes have a UI nobody watches — escalation must fail closed there. */
const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

/** Best-effort read of the two bash-tool settings the built-in is created with. */
function bashSettings(): { shellPath?: string; commandPrefix?: string } {
	try {
		const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
		return {
			shellPath: typeof raw.shellPath === "string" ? raw.shellPath : undefined,
			commandPrefix: typeof raw.shellCommandPrefix === "string" ? raw.shellCommandPrefix : undefined,
		};
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	const { shellPath, commandPrefix } = bashSettings();
	const base = createBashToolDefinition(process.cwd(), {
		shellPath,
		commandPrefix,
		spawnHook: (spawn) => ({ ...spawn, env: scrub(spawn.env) }),
	});

	if (!sandboxActive) {
		// Explicit, never silent: env scrub stays, sandbox vocabulary absent.
		pi.registerTool(base);
		pi.on("session_start", (_e, ctx) => {
			ctx.ui?.notify?.(
				"sandbox-bash: OS sandbox unavailable on this platform — bash runs unsandboxed (env scrub still active)",
				"warning",
			);
		});
		return;
	}

	const profile = buildProfile(writableRoots(process.cwd(), EXTRA_WRITABLE_ROOTS));

	pi.registerTool({
		...base,
		description:
			`${base.description} ` +
			"Commands run inside a macOS file sandbox: writes outside the workspace, /tmp, and the OS temp dir are denied; " +
			'reads and network are not restricted. A denied write is reported with a "[sandbox: ...]" marker — ' +
			"a policy denial, not a bug in the command.",
		// Extend the base schema's properties (this typebox build has no Composite).
		parameters: Type.Object({
			...(base.parameters as unknown as { properties: Record<string, unknown> }).properties,
			sandbox_permissions: Type.Optional(
				Type.Literal("danger-full-access", {
					description:
						"The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.",
				}),
			),
			justification: Type.Optional(
				Type.String({
					description:
						"Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.",
				}),
			),
		}) as never,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout, sandbox_permissions, justification } = params as {
				command: string;
				timeout?: number;
				sandbox_permissions?: string;
				justification?: string;
			};

			if (sandbox_permissions !== undefined) {
				// Defense-in-depth: enforce at execution, not just via the schema.
				if (sandbox_permissions !== "danger-full-access") {
					throw new Error(
						`invalid sandbox_permissions "${sandbox_permissions}"; valid values: danger-full-access`,
					);
				}
				if (typeof justification !== "string" || justification.trim() === "") {
					throw new Error(
						"justification is required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access",
					);
				}
				if (!ctx.hasUI || IS_SUBAGENT) {
					throw new Error(
						"[sandbox: escalation unavailable — no interactive user to approve] Report the limitation in your reply instead of retrying.",
					);
				}
				const approved = await ctx.ui.confirm(
					"Sandbox escalation",
					`${justification.trim()}\n\nCommand:\n${command}\n\nRun once WITHOUT the file sandbox?`,
				);
				if (!approved) {
					throw new Error(
						"[sandbox: escalation rejected by user] Do not retry or work around it; explain what you could not do.",
					);
				}
				// One-shot: nothing is persisted; the next call is confined again.
				return base.execute(toolCallId, { command, timeout }, signal, onUpdate, ctx);
			}

			try {
				return await base.execute(
					toolCallId,
					{ command: confine(command, profile), timeout },
					signal,
					onUpdate,
					ctx,
				);
			} catch (err) {
				if (err instanceof Error) {
					const kind = classifyFailure(err.message);
					if (kind === "runner") throw new Error(`${err.message}\n\n${RUNNER_MARKER}`);
					if (kind === "denial") throw new Error(`${err.message}\n\n${DENIAL_MARKER}\n${ESCALATION_HINT}`);
				}
				throw err;
			}
		},
	});
}
