/**
 * Claude Code's permission model, ported to this setup.
 *
 * Rules are `Tool(specifier)` strings — `Bash(git push *)`, `Edit(/repo/**)` —
 * sorted into three tiers whose precedence is deny > ask > allow. A tool call
 * matching nothing is *unmatched*, and an unmatched call in Auto asks once and
 * offers to remember the answer, which is the whole point: the old gate asked
 * the same question forever because a yes/no confirm has nowhere to put "yes,
 * and stop asking".
 *
 * Static defaults live here, versioned with the rest of the setup. Remembered
 * answers live in STATE_DIR, deliberately outside the parity-checked managed
 * config so that learning a rule never shows up as install drift.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

export type Tier = "deny" | "ask" | "allow";
export type RuleSet = Record<Tier, string[]>;

export type Rule = { tool: string; specifier?: string };

export type Decision =
  | { tier: "deny"; rule: string }
  | { tier: "ask"; rule: string }
  | { tier: "allow"; rule: string }
  | { tier: "unmatched" };

const STATE_FILE = join(homedir(), ".local", "state", "pi-setup", "permission-rules.json");

/**
 * Commands whose first word alone is meaningless as a permission unit; the
 * subcommand carries the authority. Mirrors how Claude Code suggests
 * `Bash(git push:*)` rather than `Bash(git:*)`.
 */
const SUBCOMMAND_TOOLS = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "bun", "deno", "docker", "podman", "kubectl",
  "helm", "terraform", "pulumi", "cargo", "go", "mise", "brew", "pip", "pip3",
  "uv", "poetry", "gcloud", "aws", "az", "flyctl", "fly", "wrangler", "vercel",
  "railway", "serverless", "argocd", "systemctl", "launchctl", "defaults",
]);

/**
 * Hard stops. Nothing in Auto, Bypass, or a remembered rule can reach these:
 * credential exfiltration and writes that destroy a device rather than a file.
 */
export const DEFAULT_DENY: string[] = [
  "Bash(gh auth token *)",
  "Bash(security find-generic-password *)",
  "Bash(security find-internet-password *)",
  "Bash(security dump-keychain *)",
  "Bash(pass show *)",
  "Bash(op read *)",
  "Bash(op item get *)",
  "Bash(mkfs*)",
  "Bash(shred *)",
  "Bash(diskutil erase*)",
  "Bash(diskutil partitionDisk *)",
];

/**
 * Commands that stop for an answer. Most are rememberable — the prompt offers
 * "Always allow", which files a learned rule that cancels the default — because
 * they recur constantly in ordinary work and re-asking teaches nothing.
 *
 * Unlike Claude Code, an *unmatched* command is not on this list. Claude Code
 * must ask about every unfamiliar command because nothing else confines it;
 * here sandbox-bash.ts gives every command a Seatbelt profile that already
 * limits writes to the workspace and temp and makes credentials unreadable,
 * and tree-rewind checkpoints the workspace. Asking anyway would have cost 725
 * first-time prompts across this machine's history, against 143 today.
 */
export const DEFAULT_ASK: string[] = [
  "Bash(rm *)",
  "Bash(rmdir *)",
  "Bash(git commit *)",
  "Bash(chmod -R *)",
  "Bash(chmod -Rf *)",
  "Bash(chown -R *)",
  "Bash(dd *)",
  "Bash(find * -delete*)",
  "Bash(find * -exec rm *)",
  "Bash(find * -execdir rm *)",
  "Bash(xargs rm *)",
  "Bash(xargs -* rm *)",
  // The tail of a pipe-to-shell: a shell invoked with no script, or one told to
  // read the script from stdin. `bash -n script.sh` and `zsh -ic ...` are
  // ordinary syntax checks and are deliberately not listed.
  "Bash(sh)",
  "Bash(bash)",
  "Bash(zsh)",
  "Bash(sh -s*)",
  "Bash(bash -s*)",
  "Bash(zsh -s*)",
  "Bash(sh -)",
  "Bash(bash -)",
  "Bash(zsh -)",
  "Bash(sudo *)",
  "Bash(git push *)",
  "Bash(gh pr merge *)",
  "Bash(gh release *)",
  "Bash(gh repo delete *)",
  "Bash(npm publish *)",
  "Bash(pnpm publish *)",
  "Bash(yarn publish *)",
  "Bash(docker push *)",
  "Bash(terraform apply *)",
  "Bash(terraform destroy *)",
  "Bash(kubectl apply *)",
  "Bash(kubectl delete *)",
  "Bash(helm install *)",
  "Bash(helm upgrade *)",
  "Bash(helm uninstall *)",
  "Bash(argocd app delete *)",
  "Bash(gcloud * delete *)",
  "Bash(vercel *)",
  "Bash(fly deploy *)",
  "Bash(flyctl deploy *)",
  "Bash(railway up *)",
  "Bash(wrangler deploy *)",
  "Bash(wrangler publish *)",
  "Bash(serverless deploy *)",
  "Bash(shutdown *)",
  "Bash(reboot *)",
  "Bash(halt *)",
];

/**
 * The subset that never offers "Always allow". Publishing, deploying, pushing,
 * and acting as root reach outside this machine or cannot be undone from here,
 * so they stay a conscious act however often they come up. Everything else in
 * DEFAULT_ASK is local, sandbox-confined, and checkpointed.
 */
export const NEVER_REMEMBER: string[] = [
  "Bash(sudo *)",
  "Bash(git push *)",
  "Bash(gh pr merge *)",
  "Bash(gh release *)",
  "Bash(gh repo delete *)",
  "Bash(npm publish *)",
  "Bash(pnpm publish *)",
  "Bash(yarn publish *)",
  "Bash(docker push *)",
  "Bash(terraform apply *)",
  "Bash(terraform destroy *)",
  "Bash(kubectl apply *)",
  "Bash(kubectl delete *)",
  "Bash(helm install *)",
  "Bash(helm upgrade *)",
  "Bash(helm uninstall *)",
  "Bash(argocd app delete *)",
  "Bash(gcloud * delete *)",
  "Bash(vercel *)",
  "Bash(fly deploy *)",
  "Bash(flyctl deploy *)",
  "Bash(railway up *)",
  "Bash(wrangler deploy *)",
  "Bash(wrangler publish *)",
  "Bash(serverless deploy *)",
  "Bash(shutdown *)",
  "Bash(reboot *)",
  "Bash(halt *)",
];

/** Whether a prompt for this rule may offer to stop asking. */
export function isRememberable(rule: string): boolean {
  return !NEVER_REMEMBER.includes(rule);
}

/** Read-only work that never needs a gate. */
export const DEFAULT_ALLOW: string[] = [
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git remote -v)",
  "Bash(gh pr view *)",
  "Bash(gh pr diff *)",
  "Bash(gh run view *)",
];

export function defaultRules(): RuleSet {
  return { deny: [...DEFAULT_DENY], ask: [...DEFAULT_ASK], allow: [...DEFAULT_ALLOW] };
}

export function parseRule(raw: string): Rule | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/s.exec(raw.trim());
  if (!match) return undefined;
  return { tool: match[1], specifier: match[2]?.trim() || undefined };
}

/** Glob with `*` as "any run of characters"; the whole specifier must match. */
function globMatches(specifier: string, subject: string): boolean {
  const source = specifier
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(subject);
}

/**
 * Strip heredoc bodies and quoted literals so a rule matches the command being
 * run rather than text that merely travels through it. Writing a test file whose
 * body mentions `git commit` used to trigger the commit prompt.
 */
export function skeleton(command: string): string {
  let text = command;
  text = text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, " <<HEREDOC ");
  text = text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*/g, " <<HEREDOC ");
  return text.replace(/'[^']*'/g, " '' ").replace(/"[^"]*"/g, ' "" ');
}

/** Split a command skeleton into the individual commands a shell would run. */
export function segments(commandSkeleton: string): string[] {
  return commandSkeleton
    .split(/(?:\|\||&&|[;\n|&])+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The permission unit for a command: the executable plus the subcommand or the
 * leading flag cluster. `rm -rf build` yields `rm -rf`, `git commit -m x`
 * yields `git commit`. This is what a remembered answer is scoped to, so it
 * must be narrower than the bare executable.
 */
export function commandPrefix(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const head = tokens[0].split("/").pop() ?? tokens[0];
  const rest = tokens.slice(1);
  if (SUBCOMMAND_TOOLS.has(head)) {
    // Skip flags and the values they take (`git -C /repo push` is a push), so a
    // remembered rule is scoped to the authority, not to whatever path came first.
    const sub = rest.find(
      (token) => !token.startsWith("-") && !token.includes("/") && !token.includes("="),
    );
    return sub ? `${head} ${sub}` : head;
  }
  const flags: string[] = [];
  for (const token of rest) {
    if (!token.startsWith("-")) break;
    flags.push(token);
  }
  return [head, ...flags].join(" ");
}

function matchesBash(specifier: string, segment: string): boolean {
  const body = specifier.endsWith(" *") ? specifier.slice(0, -2) : undefined;
  // A trailing " *" is a prefix rule, but only when the rest is literal. With an
  // interior star the whole specifier is a glob, otherwise `gcloud * delete *`
  // would look for a command literally starting with "gcloud * delete".
  if (body !== undefined && !body.includes("*")) {
    return segment === body || segment.startsWith(`${body} `);
  }
  if (specifier.includes("*")) {
    // Let a trailing " *" match no arguments at all, so `gcloud sql delete`
    // is caught by the same rule as `gcloud sql delete foo`.
    return globMatches(specifier, segment) || (body !== undefined && globMatches(body, segment));
  }
  return segment === specifier;
}

/**
 * Test a segment as written and, for tools whose authority lives in the
 * subcommand, as normalized. `git -C /repo push` and `git -c k=v commit` do not
 * start with `git push`/`git commit`, so a prefix rule would miss them and the
 * always-ask guarantee on push would silently not hold.
 */
function bashForms(segment: string): string[] {
  const normalized = commandPrefix(segment);
  return normalized && !segment.startsWith(normalized) ? [segment, normalized] : [segment];
}

function matchesPath(specifier: string, path: string): boolean {
  const expanded = specifier.replace(/^~(?=\/|$)/, homedir());
  if (expanded.endsWith("/**")) {
    const root = normalize(expanded.slice(0, -3));
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  }
  return globMatches(expanded, path);
}

function tierOf(
  rules: RuleSet,
  test: (specifier: string | undefined) => boolean,
  tool: string,
): Decision {
  for (const tier of ["deny", "ask", "allow"] as const) {
    for (const raw of rules[tier]) {
      const rule = parseRule(raw);
      if (!rule || rule.tool.toLowerCase() !== tool.toLowerCase()) continue;
      if (rule.specifier === undefined || test(rule.specifier)) return { tier, rule: raw };
    }
  }
  return { tier: "unmatched" };
}

/**
 * Decide a bash command. Every segment is judged and the most severe decision
 * wins, so `mkdir build && rm -rf /` cannot be smuggled past a prefix rule.
 */
export function decideBash(rules: RuleSet, command: string): Decision {
  const parts = segments(skeleton(command));
  if (parts.length === 0) return { tier: "unmatched" };
  let worst: Decision = { tier: "allow", rule: "" };
  let sawUnmatched = false;
  for (const segment of parts) {
    const forms = bashForms(segment);
    const decision = tierOf(
      rules,
      (specifier) => forms.some((form) => matchesBash(specifier!, form)),
      "Bash",
    );
    if (decision.tier === "deny") return decision;
    if (decision.tier === "ask") worst = decision;
    else if (decision.tier === "unmatched") sawUnmatched = true;
  }
  if (worst.tier === "ask") return worst;
  return sawUnmatched ? { tier: "unmatched" } : worst;
}

export function decidePath(rules: RuleSet, tool: string, path: string): Decision {
  return tierOf(rules, (specifier) => matchesPath(specifier!, path), tool);
}

/** The rule a "don't ask again" answer would add, in Claude Code's syntax. */
export function suggestBashRule(command: string): string {
  const parts = segments(skeleton(command));
  const prefix = commandPrefix(parts[0] ?? "");
  return prefix ? `Bash(${prefix} *)` : "";
}

export function suggestPathRule(tool: string, root: string): string {
  return `${tool}(${normalize(root)}/**)`;
}

function emptyRules(): RuleSet {
  return { deny: [], ask: [], allow: [] };
}

function sanitize(value: unknown): RuleSet {
  const out = emptyRules();
  if (!value || typeof value !== "object") return out;
  for (const tier of ["deny", "ask", "allow"] as const) {
    const list = (value as Record<string, unknown>)[tier];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && parseRule(entry)) out[tier].push(entry);
    }
  }
  return out;
}

export function loadRememberedRules(file: string = STATE_FILE): RuleSet {
  try {
    return sanitize(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyRules();
  }
}

/**
 * Re-read before writing so two live sessions each learning a rule do not
 * discard one another's answer, and rename into place so a crash mid-write
 * cannot leave a truncated rule file that silently loses every remembered
 * answer.
 */
export function rememberRule(tier: Tier, rule: string, file: string = STATE_FILE): RuleSet {
  const current = loadRememberedRules(file);
  if (!current[tier].includes(rule)) current[tier].push(rule);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(temporary, file);
  return current;
}

/** Static defaults plus remembered answers; deny always outranks a learned allow. */
export function effectiveRules(file: string = STATE_FILE): RuleSet {
  const base = defaultRules();
  const learned = loadRememberedRules(file);
  // "Always allow" on a prompt has to be able to cancel the default rule that
  // raised it. Without this the learned allow would sit below the default ask
  // in the precedence order and the same question would come back forever —
  // the exact failure this rewrite exists to remove. Deny is never cancellable.
  const cancelled = new Set(learned.allow);
  return {
    deny: [...base.deny, ...learned.deny],
    ask: [...base.ask.filter((rule) => !cancelled.has(rule)), ...learned.ask],
    allow: [...base.allow, ...learned.allow],
  };
}

export function rememberedRulesFile(): string {
  return STATE_FILE;
}
