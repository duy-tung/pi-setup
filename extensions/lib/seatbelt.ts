/**
 * Pure helpers for the macOS Seatbelt bash sandbox (see ../sandbox-bash.ts).
 *
 * Ported from DeepSeek Harness (sandbox-local/src/profiles.ts, sandbox/src/roots.ts):
 * allow-default profile with a file-write deny + writable-roots allowlist.
 * Reads, exec, and NETWORK are deliberately unrestricted — file effects only.
 * The read-only subagent profile is the one exception: it has no writable root
 * and denies network, so a child that can read the workspace has no egress path.
 *
 * Kept free of package imports so it can be unit-tested with plain node.
 */

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/** Model-facing markers — one vocabulary for every sandbox outcome. */
export const DENIAL_MARKER = "[sandbox: file access denied under workspace-write mode]";
export const PLAN_DENIAL_MARKER = "[sandbox: file access denied under Plan read-only mode]";
export const READ_ONLY_CHILD_DENIAL_MARKER =
	"[sandbox: denied under read-only subagent mode — no writes and no network are available here]";
export const RUNNER_MARKER =
	"[sandbox: sandbox runner failed — this is a sandbox problem, not a command failure; do not rewrite the command]";

export const SEATBELT_AVAILABLE = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

/** SBPL string literal with backslash/quote escaping. */
export function sbplString(path: string): string {
	return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Single-quote a string for embedding in a shell command line. */
export function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Canonicalize through the NATIVE realpath: the JS implementation collapses
 * `..` lexically before resolving a preceding symlink on some platforms,
 * which a symlinked workspace could exploit (DSH roots.ts:30-41).
 */
export function canonical(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/** Workspace + /tmp + OS tmpdir (+ extras), canonicalized and deduped. */
export function writableRoots(cwd: string, extra: string[] = []): string[] {
	return [...new Set([canonical(cwd), canonical("/tmp"), canonical(tmpdir()), ...extra.map(canonical)])];
}

export type SeatbeltPathRule = { path: string; kind: "literal" | "subpath" };

function filter(rule: SeatbeltPathRule): string {
  return `(${rule.kind} ${sbplString(rule.path)})`;
}

/**
 * Allow-default profile: workspace/temp writes, then explicit sensitive denies.
 * `denyNetwork` is for the read-only subagent profile, whose reads are broad and
 * whose egress must therefore be closed; normal Bash keeps network access.
 */
export function buildProfile(
  roots: string[],
  denyReads: SeatbeltPathRule[] = [],
  denyWrites: SeatbeltPathRule[] = [],
  denyNetwork = false,
): string {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
  ];
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
  }
  if (denyWrites.length > 0) {
    forms.push(`(deny file-write* ${denyWrites.map(filter).join(" ")})`);
  }
  if (denyReads.length > 0) {
    forms.push(`(deny file-read* ${denyReads.map(filter).join(" ")})`);
  }
  if (denyNetwork) {
    forms.push("(deny network*)");
  }
  return forms.join("\n");
}

/** Wrap a bash command so it runs confined under the given profile. */
export function confine(command: string, profile: string): string {
	return `sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`;
}

/**
 * Classify a failed run. Order matters (DSH bash-sandbox/helpers.ts): a runner
 * failure means the command NEVER ran, so it is checked before denial; denial
 * is a heuristic over the command's own output (a genuine EPERM from the OS
 * matches too — the escalation hint is advisory, acceptable).
 */
export function classifyFailure(message: string): "runner" | "denial" | undefined {
	if (/(^|\n)sandbox-exec: /.test(message)) return "runner";
	if (/operation not permitted|read-only file system|permission denied/i.test(message)) return "denial";
	return undefined;
}
