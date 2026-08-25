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
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    fail(`private-key material found in ${rel}`);
  }
  const candidates = text.match(/(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/g) ?? [];
  for (const candidate of candidates) {
    if (!allowedFakeTokens.has(candidate)) fail(`credential-like token found in ${rel}`);
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
const expectedNpm = ["mise", "-C", "/", "exec", "node@24.15.0", "--", "npm"];
const expectedPackages = [
  "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.1",
  "npm:pi-web-search@1.3.1",
  "npm:@upstash/context7-pi@0.1.2",
];
const expectedDefaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
if (JSON.stringify(settings.npmCommand) !== JSON.stringify(expectedNpm)) fail("settings.json npmCommand is not portable and pinned");
if (JSON.stringify(settings.packages) !== JSON.stringify(expectedPackages)) fail("settings.json package list is not exactly pinned");
if (JSON.stringify(settings.defaultTools) !== JSON.stringify(expectedDefaultTools)) fail("settings.json default tool list is not exactly pinned");
const mise = readFileSync(join(root, "mise.toml"), "utf8");
if (!/^node = "24\.15\.0"$/m.test(mise) || !/^PI_CACHE_RETENTION = "long"$/m.test(mise)) {
  fail("mise.toml does not pin Node and long cache retention");
}

const managed = readFileSync(join(root, "scripts", "managed-paths.txt"), "utf8").trim().split("\n");
const expectedManaged = ["AGENTS.md", "settings.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts"];
if (JSON.stringify(managed) !== JSON.stringify(expectedManaged)) fail("managed-path allowlist changed unexpectedly");

const rewind = lstatSync(join(root, "extensions", "tree-rewind"));
if (!rewind.isDirectory() || rewind.isSymbolicLink()) fail("tree-rewind must be a bundled regular directory");
const rewindPackage = JSON.parse(readFileSync(join(root, "extensions", "tree-rewind", "package.json"), "utf8"));
if (rewindPackage.name !== "pi-tree-rewind" || rewindPackage.version !== "0.3.1") fail("unexpected bundled tree-rewind package metadata");

if (failures.length > 0) {
  for (const message of [...new Set(failures)]) console.error(`audit: ${message}`);
  process.exit(1);
}
console.log("Repository portability and secret-path audit passed.");
