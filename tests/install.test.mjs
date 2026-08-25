import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "install.sh");
const managed = ["AGENTS.md", "settings.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts"];

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-setup-home-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  return { home, agent, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runInstall(home, env = {}) {
  return spawnSync("/bin/bash", [installer, "--config-only"], {
    cwd: root,
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
  });
}

function runDoctor(home) {
  return spawnSync("/bin/bash", [join(root, "doctor.sh"), "--config-only"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function assertManagedMatches(agent) {
  for (const rel of managed) {
    const expected = join(root, rel);
    const actual = join(agent, rel);
    if (statSync(expected).isDirectory()) {
      const result = spawnSync("rsync", ["-ainc", "--delete", `${expected}/`, `${actual}/`], { encoding: "utf8" });
      assert.equal(result.status, 0, `${rel} compare failed:\n${result.stderr}`);
      assert.equal(result.stdout, "", `${rel} differs:\n${result.stdout}`);
    } else {
      assert.equal(readFileSync(actual, "utf8"), readFileSync(expected, "utf8"), `${rel} content differs`);
      assert.equal(statSync(actual).mode & 0o777, statSync(expected).mode & 0o777, `${rel} mode differs`);
    }
  }
}

test("config-only install backs up managed config and preserves all runtime state", () => {
  const f = fixture();
  try {
    write(join(f.agent, "AGENTS.md"), "old agents\n");
    write(join(f.agent, "settings.json"), "{\"old\":true}\n");
    write(join(f.agent, "scrub-session-secrets.sh"), "#!/bin/sh\necho old\n", 0o700);
    write(join(f.agent, "extensions", "old.ts"), "old extension\n");
    write(join(f.agent, "skills", "old", "SKILL.md"), "old skill\n");
    write(join(f.agent, "prompts", "old.md"), "old prompt\n");

    const sentinels = new Map([
      ["auth.json", "AUTH-SENTINEL\n"],
      ["trust.json", "TRUST-SENTINEL\n"],
      [join("sessions", "session.jsonl"), "SESSION-SENTINEL\n"],
      [join("subagents", "child.jsonl"), "CHILD-SENTINEL\n"],
      [join("cache", "cache.bin"), "CACHE-SENTINEL\n"],
      [join("rewind", "store", "blob"), "REWIND-SENTINEL\n"],
    ]);
    for (const [rel, content] of sentinels) write(join(f.agent, rel), content);

    const first = runInstall(f.home);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assertManagedMatches(f.agent);
    assert.equal(existsSync(join(f.agent, "AGENTS.override.md")), false, "repo-only override must not be installed globally");
    for (const [rel, content] of sentinels) assert.equal(readFileSync(join(f.agent, rel), "utf8"), content);

    const backupRoot = join(f.home, ".local", "state", "pi-setup", "backups");
    const backups = readdirSync(backupRoot);
    assert.equal(backups.length, 1);
    const backup = join(backupRoot, backups[0]);
    assert.equal(readFileSync(join(backup, "AGENTS.md"), "utf8"), "old agents\n");
    assert.equal(readFileSync(join(backup, "extensions", "old.ts"), "utf8"), "old extension\n");

    const second = runInstall(f.home);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /already matches/);
    assert.equal(readdirSync(backupRoot).length, 1, "idempotent rerun created another backup");
    for (const [rel, content] of sentinels) assert.equal(readFileSync(join(f.agent, rel), "utf8"), content);
  } finally {
    f.cleanup();
  }
});

test("config-only install repairs nested permission drift", () => {
  const f = fixture();
  try {
    const first = runInstall(f.home);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const liveFile = join(f.agent, "extensions", "fast-mode.ts");
    const expectedMode = statSync(join(root, "extensions", "fast-mode.ts")).mode & 0o777;
    chmodSync(liveFile, 0o600);

    const second = runInstall(f.home);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(statSync(liveFile).mode & 0o777, expectedMode);
    assertManagedMatches(f.agent);
  } finally {
    f.cleanup();
  }
});

test("doctor rejects regular managed-file mode drift", () => {
  const f = fixture();
  try {
    const install = runInstall(f.home);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    chmodSync(join(f.agent, "settings.json"), 0o600);
    const doctor = runDoctor(f.home);
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stderr, /file mode differs/);
  } finally {
    f.cleanup();
  }
});

test("installer fails closed when another setup operation owns the shared lock", () => {
  const f = fixture();
  try {
    const lock = join(f.home, ".local", "state", "pi-setup", "operation.lock");
    mkdirSync(lock, { recursive: true });
    write(join(lock, "owner"), "other-process\n");
    const result = runInstall(f.home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another install\/sync operation owns/);
    assert.equal(readdirSync(f.agent).length, 0);
  } finally {
    f.cleanup();
  }
});

test("full installer rejects relative global mise override before mutation", () => {
  const f = fixture();
  try {
    const result = spawnSync("/bin/bash", [installer], {
      cwd: root,
      env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, ".config"), MISE_GLOBAL_CONFIG_FILE: "relative-mise.toml" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must resolve to an absolute global config path/);
    assert.equal(existsSync(join(root, "relative-mise.toml")), false);
    assert.equal(existsSync(join(f.home, "relative-mise.toml")), false);
  } finally {
    f.cleanup();
  }
});

test("full installer refuses symlinked package-store ancestors", () => {
  const f = fixture();
  try {
    const external = join(f.home, "external-package-store");
    mkdirSync(external);
    write(join(external, "sentinel"), "DO-NOT-MOVE\n");
    symlinkSync(external, join(f.agent, "git"));
    const result = spawnSync("/bin/bash", [installer], {
      cwd: root,
      env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, ".config"), MISE_GLOBAL_CONFIG_FILE: join(f.home, ".config", "mise", "config.toml") },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package-store path must not be a symlink/);
    assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "DO-NOT-MOVE\n");
  } finally {
    f.cleanup();
  }
});

test("installer refuses a symlinked Pi root before touching its target", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-setup-symlink-home-"));
  try {
    const target = join(home, "redirected-private-state");
    mkdirSync(target);
    write(join(target, "auth.json"), "DO-NOT-TOUCH\n");
    symlinkSync(target, join(home, ".pi"));
    const result = runInstall(home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a real directory, not a symlink/);
    assert.equal(readFileSync(join(target, "auth.json"), "utf8"), "DO-NOT-TOUCH\n");
    assert.deepEqual(readdirSync(target), ["auth.json"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer reports incomplete rollback and preserves its persistent backup", () => {
  const f = fixture();
  try {
    write(join(f.agent, "AGENTS.md"), "previous agents\n");
    write(join(f.agent, "settings.json"), "{\"previous\":true}\n");
    const fakeBin = join(f.home, "fake-bin");
    mkdirSync(fakeBin);
    write(join(fakeBin, "mv"), "#!/bin/sh\ncase \"$1\" in */settings.json) exit 73 ;; esac\nexec /bin/mv \"$@\"\n", 0o755);
    write(
      join(fakeBin, "cp"),
      "#!/bin/sh\ncase \"$2\" in */backups/*/AGENTS.md) exit 74 ;; esac\nexec /bin/cp \"$@\"\n",
      0o755,
    );

    const result = runInstall(f.home, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: rollback was incomplete/);
    const match = result.stderr.match(/preserve managed backup (.+) and runtime transaction/);
    assert.ok(match, result.stderr);
    assert.equal(readFileSync(join(match[1], "AGENTS.md"), "utf8"), "previous agents\n");
  } finally {
    f.cleanup();
  }
});

test("full install failure restores prior global mise and Pi package state", () => {
  const f = fixture();
  try {
    write(join(f.agent, "AGENTS.md"), "previous agents\n");
    write(join(f.agent, "settings.json"), "{\"previous\":true}\n");
    const miseConfig = join(f.home, "custom", "global-mise.toml");
    write(miseConfig, "ORIGINAL-MISE-CONFIG\n", 0o600);
    const npmRoot = join(f.home, "fake-global", "lib", "node_modules");
    const piMeta = join(npmRoot, "@earendil-works", "pi-coding-agent", "package.json");
    write(piMeta, JSON.stringify({ version: "0.83.0" }));

    const fakeBin = join(f.home, "fake-bin");
    mkdirSync(fakeBin);
    write(
      join(fakeBin, "mise"),
      `#!/bin/bash\nset -e\n[ "$1" != "-C" ] || shift 2\ncase "$1" in\n  install) exit 0 ;;\n  use) config="${"${MISE_GLOBAL_CONFIG_FILE:-$HOME/.config/mise/config.toml}"}"; mkdir -p "$(dirname "$config")"; printf 'NEW-MISE-CONFIG\\n' > "$config"; exit 0 ;;\n  set) config="${"${MISE_GLOBAL_CONFIG_FILE:-$HOME/.config/mise/config.toml}"}"; printf 'NEW-CACHE-SETTING\\n' >> "$config"; exit 0 ;;\n  exec)\n    shift 2\n    [ "$1" != "--" ] || shift\n    case "$1" in\n      node) shift; exec ${JSON.stringify(process.execPath)} "$@" ;;\n      npm)\n        shift\n        if [ "$1 $2" = "root --global" ]; then printf '%s\\n' ${JSON.stringify(npmRoot)}; exit 0; fi\n        if [ "$1 $2" = "install --global" ]; then\n          spec="$3"; version="${"${spec##*@}"}"\n          mkdir -p ${JSON.stringify(dirname(piMeta))}\n          printf '{"version":"%s"}' "$version" > ${JSON.stringify(piMeta)}\n          exit 0\n        fi\n        if [ "$1 $2" = "uninstall --global" ]; then rm -rf ${JSON.stringify(dirname(piMeta))}; exit 0; fi\n        ;;\n    esac\n    ;;\nesac\nprintf 'unexpected fake mise call: %s\\n' "$*" >&2\nexit 91\n`,
      0o755,
    );
    write(join(fakeBin, "mv"), "#!/bin/sh\ncase \"$1\" in */settings.json) exit 73 ;; esac\nexec /bin/mv \"$@\"\n", 0o755);

    const result = spawnSync("/bin/bash", [installer], {
      cwd: root,
      env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, ".config"), MISE_GLOBAL_CONFIG_FILE: miseConfig, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring previous global mise\/Pi runtime state/);
    assert.doesNotMatch(result.stderr, /CRITICAL/);
    assert.equal(readFileSync(miseConfig, "utf8"), "ORIGINAL-MISE-CONFIG\n");
    assert.equal(JSON.parse(readFileSync(piMeta, "utf8")).version, "0.83.0");
    assert.equal(readFileSync(join(f.agent, "AGENTS.md"), "utf8"), "previous agents\n");
    assert.equal(readFileSync(join(f.agent, "settings.json"), "utf8"), "{\"previous\":true}\n");
  } finally {
    f.cleanup();
  }
});

test("failed package reconciliation restores prior Pi package stores", () => {
  const f = fixture();
  try {
    write(join(f.agent, "AGENTS.md"), "previous agents\n");
    write(join(f.agent, "settings.json"), "{\"previous\":true}\n");
    const miseConfig = join(f.home, "custom", "global-mise.toml");
    write(miseConfig, "ORIGINAL-MISE-CONFIG\n", 0o600);
    const npmRoot = join(f.home, "fake-global", "lib", "node_modules");
    const piMeta = join(npmRoot, "@earendil-works", "pi-coding-agent", "package.json");
    write(piMeta, JSON.stringify({ version: "0.84.3" }));
    write(join(f.agent, "npm", "old-sentinel"), "OLD-NPM\n");
    const oauthStore = join(f.agent, "git", "github.com", "duy-tung", "pi-anthropic-oauth-plus");
    write(join(oauthStore, "old-sentinel"), "OLD-OAUTH\n");

    const fakeBin = join(f.home, "fake-bin");
    mkdirSync(fakeBin);
    write(
      join(fakeBin, "mise"),
      `#!/bin/bash\nset -e\n[ "$1" != "-C" ] || shift 2\ncase "$1" in\n  install) exit 0 ;;\n  use) config="${"${MISE_GLOBAL_CONFIG_FILE:-$HOME/.config/mise/config.toml}"}"; mkdir -p "$(dirname "$config")"; printf 'NEW-MISE-CONFIG\\n' > "$config"; exit 0 ;;\n  set) config="${"${MISE_GLOBAL_CONFIG_FILE:-$HOME/.config/mise/config.toml}"}"; printf 'NEW-CACHE-SETTING\\n' >> "$config"; exit 0 ;;\n  exec)\n    shift 2\n    [ "$1" != "--" ] || shift\n    case "$1" in\n      node) shift; exec ${JSON.stringify(process.execPath)} "$@" ;;\n      npm) shift; if [ "$1 $2" = "root --global" ]; then printf '%s\\n' ${JSON.stringify(npmRoot)}; exit 0; fi ;;\n      pi)\n        mkdir -p "$HOME/.pi/agent/npm" "$HOME/.pi/agent/git/github.com/duy-tung/pi-anthropic-oauth-plus"\n        printf 'NEW-NPM\\n' > "$HOME/.pi/agent/npm/new-sentinel"\n        printf 'NEW-OAUTH\\n' > "$HOME/.pi/agent/git/github.com/duy-tung/pi-anthropic-oauth-plus/new-sentinel"\n        exit 73\n        ;;\n    esac\n    ;;\nesac\nprintf 'unexpected fake mise call: %s\\n' "$*" >&2\nexit 91\n`,
      0o755,
    );

    const result = spawnSync("/bin/bash", [installer], {
      cwd: root,
      env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, ".config"), MISE_GLOBAL_CONFIG_FILE: miseConfig, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring previous Pi package stores/);
    assert.doesNotMatch(result.stderr, /CRITICAL/);
    assert.equal(readFileSync(join(f.agent, "npm", "old-sentinel"), "utf8"), "OLD-NPM\n");
    assert.equal(readFileSync(join(oauthStore, "old-sentinel"), "utf8"), "OLD-OAUTH\n");
    assert.equal(existsSync(join(f.agent, "npm", "new-sentinel")), false);
    assert.equal(existsSync(join(oauthStore, "new-sentinel")), false);
    assert.equal(readFileSync(miseConfig, "utf8"), "ORIGINAL-MISE-CONFIG\n");
    assert.equal(readFileSync(join(f.agent, "settings.json"), "utf8"), "{\"previous\":true}\n");
  } finally {
    f.cleanup();
  }
});

test("failed apply restores existing paths and removes newly introduced paths", () => {
  const f = fixture();
  try {
    write(join(f.agent, "AGENTS.md"), "previous agents\n");
    write(join(f.agent, "settings.json"), "{\"previous\":true}\n");
    write(join(f.agent, "auth.json"), "AUTH-STAYS\n");

    const fakeBin = join(f.home, "fake-bin");
    mkdirSync(fakeBin);
    write(
      join(fakeBin, "mv"),
      "#!/bin/sh\ncase \"$1\" in */settings.json) exit 73 ;; esac\nexec /bin/mv \"$@\"\n",
      0o755,
    );

    const result = runInstall(f.home, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring managed config/);
    assert.equal(readFileSync(join(f.agent, "AGENTS.md"), "utf8"), "previous agents\n");
    assert.equal(readFileSync(join(f.agent, "settings.json"), "utf8"), "{\"previous\":true}\n");
    assert.equal(readFileSync(join(f.agent, "auth.json"), "utf8"), "AUTH-STAYS\n");
    for (const rel of ["scrub-session-secrets.sh", "extensions", "skills", "prompts"]) {
      assert.equal(existsSync(join(f.agent, rel)), false, `${rel} should remain absent after rollback`);
    }
  } finally {
    f.cleanup();
  }
});
