#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(resolve(process.argv[2] ?? ownRoot));
const currentHome = homedir();
const neverTraverse = new Set([".git", "node_modules", "coverage", "dist"]);
const forbiddenDirs = new Set([
  "node_modules",
  "coverage",
  "dist",
  "sessions",
  "subagents",
  "rewind",
  "spill",
  "cache",
  "npm",
  "git",
  "backups",
]);
const privateFiles = new Set([".git", "auth.json", "trust.json", "models-store.json", "scrub-backups.txt"]);
const forbiddenRoot = new Set([
  "auth.json",
  "trust.json",
  "models-store.json",
  "scrub-backups.txt",
  "sessions",
  "subagents",
  "rewind",
  "spill",
  "cache",
  "npm",
  "git",
  "backups",
]);
const allowedFakeTokens = new Set(["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"]);
const credentialPatterns = [
  { label: "Anthropic OAuth access token", re: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g },
  { label: "Anthropic OAuth refresh token", re: /sk-ant-ort01-[A-Za-z0-9_-]{20,}/g },
  { label: "Anthropic API key", re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g },
  { label: "Codex refresh token", re: /rt\.1\.[A-Za-z0-9_-]{40,}/g },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { label: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { label: "Context7 key", re: /ctx7sk-[0-9a-fA-F-]{20,}/g },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "GitHub PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { label: "OpenAI service key", re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}/g },
  { label: "legacy OpenAI key", re: /\bsk-[A-Za-z0-9_-]{32,}/g },
  { label: "Stripe secret key", re: /\bsk_live_[A-Za-z0-9_-]{20,}/g },
  { label: "Google OAuth token", re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { label: "xAI key", re: /\bxai-[A-Za-z0-9_-]{20,}/g },
  { label: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{20,}/g },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{20,}/g },
  { label: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { label: "Tavily key", re: /\btvly-[A-Za-z0-9_-]{20,}/g },
];
const failures = [];
const files = [];

function fail(message) {
  failures.push(message);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (dir === root && entry === ".git") continue;
    const path = join(dir, entry);
    const rel = relative(root, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      fail(`repository symlink is not portable: ${rel}`);
    } else if (stat.isDirectory()) {
      if (neverTraverse.has(entry) || forbiddenDirs.has(entry)) {
        fail(`runtime, generated, or nested-repository directory is present: ${rel}`);
        continue;
      }
      if (dir === root && forbiddenRoot.has(entry)) {
        fail(`forbidden runtime/private path exists at repository root: ${entry}`);
        continue;
      }
      walk(path);
    } else if (stat.isFile()) {
      if (dir === root && forbiddenRoot.has(entry)) {
        fail(`forbidden runtime/private path exists at repository root: ${entry}`);
        continue;
      }
      files.push({ path, rel });
      const name = basename(path);
      if (privateFiles.has(name)) {
        fail(`private runtime or nested-repository file is present: ${rel}`);
      }
      if (/^\.env(?:\..+)?$/i.test(name) && !/^\.env\.(?:example|sample|template|dist)$/i.test(name)) {
        fail(`credential-shaped file is present: ${rel}`);
      }
      if (/^(?:auth|trust)\.json$/i.test(name) || /^\.(?:npmrc|netrc|pypirc)$/i.test(name)) {
        fail(`private runtime or credential file is present: ${rel}`);
      }
      if (/\.(?:pem|p12|pfx|key)$/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(name)) {
        fail(`key-shaped file is present: ${rel}`);
      }
    }
  }
}

walk(root);

for (const { path, rel } of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const placeholderHomes = new Set(["me", "you", "user", "name", "username"]);
  const homes = [...text.matchAll(/\/(?:Users|home)\/([^/$\s"'`]+)/g)].map((match) => match[1]);
  if (text.includes(`${currentHome}/`) || homes.some((name) => !placeholderHomes.has(name.toLowerCase()))) {
    fail(`machine-specific home path found in ${rel}`);
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text)) {
    fail(`private-key material found in ${rel}`);
  }
  for (const { label, re } of credentialPatterns) {
    const candidates = text.match(re) ?? [];
    for (const candidate of candidates) {
      if (!allowedFakeTokens.has(candidate)) fail(`credential-like token (${label}) found in ${rel}`);
    }
  }
}

try {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const path of tracked) {
    const parts = path.split("/");
    const first = parts[0];
    if (forbiddenRoot.has(first) || parts.some((part) => neverTraverse.has(part) || forbiddenDirs.has(part) || privateFiles.has(part))) {
      fail(`forbidden runtime/private/generated path is tracked: ${path}`);
    }
  }
} catch (error) {
  fail(`unable to inspect tracked files: ${error instanceof Error ? error.message : String(error)}`);
}

const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
const expectedNpm = ["mise", "--no-config", "exec", "node@24.15.0", "--", "npm"];
const expectedPackages = [
  "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2",
  "npm:pi-web-search@1.4.0",
  "npm:@upstash/context7-pi@0.1.2",
  "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  "npm:@juicesharp/rpiv-todo@2.9.0",
  "npm:@tintinweb/pi-subagents@0.19.0",
  "npm:pi-zentui@0.22.3",
  "npm:@juicesharp/rpiv-advisor@2.9.0",
  { source: "npm:pi-background-tasks@2.5.0", extensions: ["extensions/background-tasks.ts"] },
  "npm:@firstpick/pi-themes-bundle@0.1.6",
];
const expectedDefaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
if (JSON.stringify(settings.npmCommand) !== JSON.stringify(expectedNpm)) fail("settings.json npmCommand is not portable and pinned");
if (JSON.stringify(settings.packages) !== JSON.stringify(expectedPackages)) fail("settings.json package list is not exactly pinned");
if (JSON.stringify(settings.defaultTools) !== JSON.stringify(expectedDefaultTools)) fail("settings.json default tool list is not exactly pinned");
const zentui = JSON.parse(readFileSync(join(root, "zentui.json"), "utf8"));
if (zentui.components?.footer?.style !== "native") fail("Zentui must preserve the custom statusline with native footer mode");
const mise = readFileSync(join(root, "mise.toml"), "utf8");
if (
  !/^node = "24\.15\.0"$/m.test(mise)
  || !/^PI_CACHE_RETENTION = "long"$/m.test(mise)
  || !/^PI_ANTHROPIC_OAUTH_REWRITE_MODE = "technical-safe"$/m.test(mise)
) {
  fail("mise.toml does not pin Node, long cache retention, and technical-safe OAuth prompt rewriting");
}

const managed = readFileSync(join(root, "scripts", "managed-paths.txt"), "utf8").trim().split("\n");
const expectedManaged = ["AGENTS.md", "settings.json", "zentui.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts", "agents"];
if (JSON.stringify(managed) !== JSON.stringify(expectedManaged)) fail("managed-path allowlist changed unexpectedly");

const rewind = lstatSync(join(root, "extensions", "tree-rewind"));
if (!rewind.isDirectory() || rewind.isSymbolicLink()) fail("tree-rewind must be a bundled regular directory");
const rewindPackage = JSON.parse(readFileSync(join(root, "extensions", "tree-rewind", "package.json"), "utf8"));
if (rewindPackage.name !== "pi-tree-rewind" || rewindPackage.version !== "0.4.1") fail("unexpected bundled tree-rewind package metadata");

if (failures.length > 0) {
  for (const message of [...new Set(failures)]) console.error(`audit: ${message}`);
  process.exit(1);
}
console.log("Repository portability and secret-path audit passed.");
