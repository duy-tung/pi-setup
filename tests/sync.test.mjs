import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managed = ["AGENTS.md", "settings.json", "zentui.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts", "agents"];

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "pi-setup-sync-test-"));
  const repo = join(parent, "repo");
  const home = join(parent, "home");
  const gitDir = join(sourceRoot, ".git");
  cpSync(sourceRoot, repo, {
    recursive: true,
    filter: (source) => source !== gitDir && !source.startsWith(`${gitDir}/`),
  });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });

  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  for (const rel of managed) cpSync(join(repo, rel), join(agent, rel), { recursive: true, preserveTimestamps: true });
  mkdirSync(join(agent, "extensions", "evil"), { recursive: true });
  writeFileSync(join(agent, "extensions", "evil", "auth.json"), "must not enter git\n");
  return { parent, repo, home, agent };
}

function run(f, env = {}) {
  return spawnSync("/bin/bash", [join(f.repo, "sync-from-live.sh")], {
    cwd: f.repo,
    env: { ...process.env, HOME: f.home, ...env },
    encoding: "utf8",
  });
}

for (const [rel, staged] of [["zentui.json", false], ["zentui.json", true], ["agents/new-agent.md", false]]) {
  test(`sync preserves dirty ${rel}, staged=${staged}`, () => {
    const f = fixture();
    try {
      rmSync(join(f.agent, "extensions/evil"), { recursive: true });
      const path = join(f.repo, rel);
      const changed = rel.endsWith(".json") ? readFileSync(path, "utf8") + "\n" : "# Untracked user agent\n";
      writeFileSync(path, changed);
      if (staged) execFileSync("git", ["add", rel], { cwd: f.repo });
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" });
      const result = run(f);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /repository-managed paths are already dirty/);
      assert.equal(readFileSync(path, "utf8"), changed);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), status);
      assert.equal(existsSync(join(f.home, ".local/state/pi-setup/sync-transactions")), false);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  });
}

test("sync shares the fail-closed setup operation lock", () => {
  const f = fixture();
  try {
    const lock = join(f.home, ".local", "state", "pi-setup", "operation.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "other-process\n");
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another install\/sync operation owns/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("I4 early capture failure removes transaction and releases the operation lock", () => {
  const f = fixture();
  try {
    const fakeBin = join(f.parent, "fake-bin");
    mkdirSync(fakeBin);
    const wrapper = join(fakeBin, "rsync");
    writeFileSync(wrapper, "#!/bin/sh\nexit 77\n");
    chmodSync(wrapper, 0o755);

    const result = run(f, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(result.status, 77, `${result.stdout}\n${result.stderr}`);
    const transactions = join(f.home, ".local", "state", "pi-setup", "sync-transactions");
    assert.deepEqual(existsSync(transactions) ? readdirSync(transactions) : [], []);
    assert.equal(existsSync(join(f.home, ".local", "state", "pi-setup", "operation.lock")), false);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("sync installs its guarded cleanup trap before transaction creation", () => {
  const source = readFileSync(join(sourceRoot, "sync-from-live.sh"), "utf8");
  assert.ok(source.indexOf("trap finish EXIT") < source.indexOf('TMP="$(mktemp -d'));
  const finish = source.slice(source.indexOf("finish() {"), source.indexOf("trap finish EXIT"));
  assert.match(finish, /FINISHING=1/);
  assert.match(finish, /SIGNAL_DURING_FINISH/);
  assert.ok(finish.indexOf("restore_repo") < finish.indexOf("trap - EXIT INT TERM HUP"));
  assert.ok(finish.indexOf("release_operation_lock") < finish.indexOf("trap - EXIT INT TERM HUP"));
});

test("sync audit failure restores the clean repository", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.repo, "AGENTS.md"), "utf8");
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring repository-managed paths/);
    assert.doesNotMatch(result.stderr, /CRITICAL/);
    assert.equal(readFileSync(join(f.repo, "AGENTS.md"), "utf8"), before);
    assert.equal(existsSync(join(f.repo, "extensions", "evil")), false);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("sync preserves its before-image when rollback itself fails", () => {
  const f = fixture();
  let preserved;
  try {
    const fakeBin = join(f.parent, "fake-bin");
    const realRsync = execFileSync("sh", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
    mkdirSync(fakeBin);
    const wrapper = join(fakeBin, "rsync");
    writeFileSync(wrapper, `#!/bin/sh\ncase "$2" in */before/*) exit 74 ;; esac\nexec ${JSON.stringify(realRsync)} "$@"\n`);
    chmodSync(wrapper, 0o755);

    const result = run(f, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: rollback was incomplete/, `status=${result.status} error=${result.error?.message ?? ""}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const match = result.stderr.match(/before-image preserved at (.+)\/before/);
    assert.ok(match, result.stderr);
    preserved = match[1];
    assert.equal(existsSync(join(preserved, "before", "AGENTS.md")), true);
    assert.equal(readFileSync(join(preserved, "before", "AGENTS.md"), "utf8"), readFileSync(join(sourceRoot, "AGENTS.md"), "utf8"));
  } finally {
    if (preserved) rmSync(preserved, { recursive: true, force: true });
    rmSync(f.parent, { recursive: true, force: true });
  }
});
