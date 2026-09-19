import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed = ["AGENTS.md", "settings.json", "zentui.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts", "agents"];

function symlinks(path, out = []) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    out.push(path);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const name of readdirSync(path)) symlinks(join(path, name), out);
  return out;
}

test("repository audit rejects machine state and requires portable paths", () => {
  const output = execFileSync(process.execPath, [join(root, "scripts", "audit-repo.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /audit passed/);
  for (const rel of managed) assert.deepEqual(symlinks(join(root, rel)), [], `${rel} contains a symlink`);
});

test("repository audit rejects nested runtime trees, generated output, secrets, and symlinks", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-setup-audit-"));
  const fixture = join(parent, "repo");
  try {
    const gitDir = join(root, ".git");
    cpSync(root, fixture, {
      recursive: true,
      filter: (source) => source !== gitDir && !source.startsWith(`${gitDir}/`),
    });
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", "-A"], { cwd: fixture });

    const audit = () => spawnSync(process.execPath, [join(root, "scripts", "audit-repo.mjs"), fixture], {
      cwd: fixture,
      encoding: "utf8",
    });

    const sessions = join(fixture, "extensions", "evil", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "private.jsonl"), "session data\n");
    let result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime, generated, or nested-repository directory/);
    rmSync(join(fixture, "extensions", "evil"), { recursive: true, force: true });

    const dist = join(fixture, "skills", "evil", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "secret.txt"), "SECRET-SENTINEL\n");
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime, generated, or nested-repository directory/);
    rmSync(join(fixture, "skills", "evil"), { recursive: true, force: true });

    mkdirSync(join(fixture, "prompts", "evil"), { recursive: true });
    writeFileSync(join(fixture, "prompts", "evil", "auth.json"), "private\n");
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private runtime or credential file/);
    rmSync(join(fixture, "prompts", "evil"), { recursive: true, force: true });

    mkdirSync(join(fixture, "extensions", "gitfile"), { recursive: true });
    writeFileSync(join(fixture, "extensions", "gitfile", ".git"), "gitdir: /tmp/private-repo\n");
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private runtime or nested-repository file/);
    rmSync(join(fixture, "extensions", "gitfile"), { recursive: true, force: true });

    mkdirSync(join(fixture, "extensions", "catalog"), { recursive: true });
    writeFileSync(join(fixture, "extensions", "catalog", "models-store.json"), "{}\n");
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private runtime or nested-repository file/);
    rmSync(join(fixture, "extensions", "catalog"), { recursive: true, force: true });

    writeFileSync(join(fixture, "extensions", "foreign-home.ts"), ["", "Users", "alice", "private.ts"].join("/"));
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /machine-specific home path/);
    rmSync(join(fixture, "extensions", "foreign-home.ts"));

    writeFileSync(join(fixture, "extensions", "token.ts"), ["gho", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join(""));
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /credential-like token/);
    rmSync(join(fixture, "extensions", "token.ts"));

    symlinkSync(tmpdir(), join(fixture, "extensions", "escape"));
    result = audit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository symlink is not portable/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("settings pin the runtime package manager, default tools, and every external package", () => {
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  assert.deepEqual(settings.npmCommand, ["mise", "--no-config", "exec", "node@24.15.0", "--", "npm"]);
  assert.deepEqual(settings.packages, [
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
  ]);
  assert.equal(settings.defaultProvider, "openai-codex");
  assert.equal(settings.defaultModel, "gpt-6-astra");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal(settings.theme, "catppuccin-mocha");
  assert.deepEqual(settings.defaultTools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);

  const mise = readFileSync(join(root, "mise.toml"), "utf8");
  assert.match(mise, /node = "24\.15\.0"/);
  assert.match(mise, /PI_CACHE_RETENTION = "long"/);
  assert.match(mise, /PI_ANTHROPIC_OAUTH_REWRITE_MODE = "technical-safe"/);

  const installer = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(installer, /set --global "PI_ANTHROPIC_OAUTH_REWRITE_MODE=\$OAUTH_REWRITE_MODE"/);
  const doctor = readFileSync(join(root, "doctor.sh"), "utf8");
  assert.match(doctor, /sanitizeSystemText\("Pi uses \/tmp\/example\/pi-setup and ~\/\.pi\/agent\."\)/);
});

test("configured npm wrapper ignores project config without changing package cwd", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-npm-cwd-"));
  try {
    writeFileSync(join(fixture, "package.json"), "{}\n");
    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    const [command, ...args] = settings.npmCommand;
    const result = spawnSync(command, [...args, "prefix"], { cwd: fixture, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync.native(result.stdout.trim()), realpathSync.native(fixture));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("tree-rewind is a bundled Pi package rather than an external link", () => {
  const path = join(root, "extensions", "tree-rewind");
  const stat = lstatSync(path);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  assert.equal(pkg.name, "pi-tree-rewind");
  assert.equal(pkg.version, "0.4.1");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
});

test("installer rebuilds transactional package stores from every exact pin", () => {
  const source = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(source, /pi install "\$spec" --no-approve/);
  assert.equal(source.includes("pi update --extensions"), false);
  for (const spec of [
    "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2",
    "npm:pi-web-search@1.4.0",
    "npm:@upstash/context7-pi@0.1.2",
  ]) {
    assert.equal(source.includes(`"${spec}"`), true, `missing installer pin ${spec}`);
  }
});

test("doctor requires exact package-spec lines rather than version prefixes", () => {
  const source = readFileSync(join(root, "doctor.sh"), "utf8");
  assert.match(source, /grep -Fxq "  \$spec"/);
  assert.match(source, /grep -Fxq "  \$context7_spec"/);
  assert.equal(source.includes('$context7_spec (filtered)'), false);
  assert.equal(source.includes('grep -Fq "$spec"'), false);
});

test("portable agent definitions keep the configured reviewer and advisor exclusions", () => {
  assert.deepEqual(readdirSync(join(root, "agents")).sort(), ["Explore.md", "Plan.md", "final-reviewer.md", "general-purpose.md"].sort());
  const reviewer = readFileSync(join(root, "agents/final-reviewer.md"), "utf8");
  assert.match(reviewer, /^model: openai-codex\/gpt-6-astra$/m);
  assert.match(reviewer, /^thinking: max$/m);
  assert.match(reviewer, /^tools: read, grep, find, ls$/m);
  for (const name of ["Explore", "Plan", "general-purpose"]) {
    assert.match(readFileSync(join(root, "agents", name + ".md"), "utf8"), /^exclude_extensions: rpiv-advisor$/m);
  }
});

test("gitignore blocks Pi runtime state and credential-shaped files", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  for (const entry of [
    "/auth.json",
    "/trust.json",
    "/sessions/",
    "/subagents/",
    "/rewind/",
    "/cache/",
    "/npm/",
    "/git/",
    ".env",
    "*.pem",
  ]) {
    assert.ok(ignore.includes(entry), `missing ignore rule: ${entry}`);
  }
});
