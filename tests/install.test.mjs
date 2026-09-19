import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "install.sh");
const pinnedPiVersion = readFileSync(installer, "utf8").match(/^PI_VERSION="([^"]+)"/m)[1];
const managed = ["AGENTS.md", "settings.json", "zentui.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts", "agents"];

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
    assert.equal(readFileSync(join(backup, ".pi-setup-managed-backup-v1"), "utf8"), "pi-setup-managed-config-backup-v1\n");
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

test("JSON formatting and mtimes do not cause false drift or redundant installs", () => {
  const f = fixture();
  try {
    const first = runInstall(f.home);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const settings = join(f.agent, "settings.json");
    const data = JSON.parse(readFileSync(settings, "utf8"));
    writeFileSync(settings, JSON.stringify(Object.fromEntries(Object.entries(data).reverse())));
    const extension = join(f.agent, "extensions/fast-mode.ts");
    utimesSync(extension, new Date(0), new Date(0));
    utimesSync(join(f.agent, "agents"), new Date(0), new Date(0));
    let result = runDoctor(f.home);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    result = runInstall(f.home);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /already matches/);
    data.quietStartup = !data.quietStartup;
    writeFileSync(settings, JSON.stringify(data));
    assert.notEqual(runDoctor(f.home).status, 0, "different JSON values still fail");
    writeFileSync(settings, readFileSync(join(root, "settings.json")));
    writeFileSync(extension, readFileSync(extension, "utf8") + "\n// real drift\n");
    assert.notEqual(runDoctor(f.home).status, 0, "content changes still fail");
  } finally { f.cleanup(); }
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
    write(piMeta, JSON.stringify({ version: pinnedPiVersion }));
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

test("I4 early validation failure removes stage and releases the operation lock", () => {
  const f = fixture();
  try {
    const fakeBin = join(f.home, "fake-bin");
    mkdirSync(fakeBin);
    write(join(fakeBin, "node"), "#!/bin/sh\nexit 77\n", 0o755);
    const result = runInstall(f.home, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(result.status, 77, `${result.stdout}\n${result.stderr}`);
    assert.equal(readdirSync(f.agent).some((name) => name.startsWith(".pi-setup-stage.")), false);
    assert.equal(existsSync(join(f.home, ".local", "state", "pi-setup", "operation.lock")), false);
  } finally {
    f.cleanup();
  }
});

test("I5-I7 source keeps cleanup traps active and makes package patching transactional", () => {
  const source = readFileSync(installer, "utf8");
  const firstTrap = source.indexOf("trap finish EXIT");
  assert.ok(firstTrap > 0 && firstTrap < source.indexOf('STAGE="$AGENT_DIR/.pi-setup-stage.$$"'));
  const finish = source.slice(source.indexOf("finish() {"), source.indexOf("trap finish EXIT"));
  assert.match(finish, /FINISHING=1/);
  assert.match(finish, /SIGNAL_DURING_FINISH/);
  assert.ok(finish.indexOf("restore_packages") < finish.indexOf("trap - EXIT INT TERM HUP"));
  assert.ok(finish.indexOf("release_operation_lock") < finish.indexOf("trap - EXIT INT TERM HUP"));

  assert.match(source, /MISE_GLOBAL_CONFIG_FILE:-/);
  assert.match(source, /MISE_CONFIG_DIR:-/);
  assert.match(source, /MISE_CONFIG="\$\{MISE_CONFIG_DIR%\/\}\/config\.toml"/);
  const selection = source.slice(
    source.indexOf('if [ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]'),
    source.indexOf('MODE="full"'),
  );
  const probeRoot = mkdtempSync(join(tmpdir(), "pi-mise-selection-"));
  try {
    const customDir = join(probeRoot, "custom mise");
    const globalFile = join(probeRoot, "global.toml");
    const evaluate = (env) => spawnSync("/bin/bash", ["-c", `set -u\nHOME_REAL="$HOME"\n${selection}\nprintf '%s' "$MISE_CONFIG"`], {
      env: { ...process.env, HOME: probeRoot, MISE_GLOBAL_CONFIG_FILE: "", MISE_CONFIG_DIR: "", XDG_CONFIG_HOME: join(probeRoot, "xdg"), ...env },
      encoding: "utf8",
    });
    assert.equal(evaluate({ MISE_CONFIG_DIR: customDir }).stdout, join(customDir, "config.toml"));
    assert.equal(evaluate({ MISE_CONFIG_DIR: customDir, MISE_GLOBAL_CONFIG_FILE: globalFile }).stdout, globalFile);
    assert.equal(evaluate({}).stdout, join(probeRoot, "xdg", "mise", "config.toml"));
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  const ready = source.slice(source.indexOf("packages_ready()"), source.indexOf("prepare_package_transaction()"));
  assert.match(ready, /scripts\/package-health\.mjs/);
  const packageFlow = source.slice(source.indexOf("if packages_ready;"), source.indexOf('"$ROOT/doctor.sh"'));
  assert.ok(packageFlow.indexOf("prepare_package_transaction") < packageFlow.indexOf("package-patches.mjs"));
});

test("I8 reconciliation copies the prior npm store before updating managed pins", () => {
  const f = fixture();
  try {
    const source = readFileSync(installer, "utf8");
    const copyExisting = source.slice(source.indexOf("copy_existing() {"), source.indexOf("\nprune_managed_backups() {"));
    const prepare = source.slice(source.indexOf("prepare_package_transaction() {"), source.indexOf('\nif [ "$MODE" = "full" ]; then\n  RUNTIME_BACKUP='));
    const runtimeBackup = join(f.home, "transaction");
    mkdirSync(runtimeBackup);
    const unrelated = join(f.agent, "npm", "node_modules", "unrelated-package");
    write(join(unrelated, "sentinel"), "KEEP\n");
    symlinkSync("sentinel", join(unrelated, "sentinel-link"));
    write(join(f.agent, "npm", "node_modules", "pi-web-search", "sentinel"), "REBUILD\n");
    write(join(f.agent, "npm", "package.json"), JSON.stringify({ dependencies: { "unrelated-package": "1.0.0" } }));

    const result = spawnSync("/bin/bash", ["-c", [
      "set -euo pipefail",
      copyExisting,
      prepare,
      'PACKAGE_ROLLBACK_NEEDED=0',
      'prepare_package_transaction',
    ].join("\n")], {
      env: { ...process.env, AGENT_DIR: f.agent, RUNTIME_BACKUP: runtimeBackup },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.agent, "npm", "node_modules", "unrelated-package", "sentinel"), "utf8"), "KEEP\n");
    assert.equal(lstatSync(join(f.agent, "npm", "node_modules", "unrelated-package", "sentinel-link")).isSymbolicLink(), true);
    assert.equal(existsSync(join(f.agent, "npm", "node_modules", "pi-web-search")), false, "managed package was not staged for reconstruction");
    assert.equal(readFileSync(join(runtimeBackup, "pi-npm", "node_modules", "unrelated-package", "sentinel"), "utf8"), "KEEP\n");
    assert.equal(lstatSync(join(runtimeBackup, "pi-npm", "node_modules", "unrelated-package", "sentinel-link")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(runtimeBackup, "pi-npm", "node_modules", "pi-web-search", "sentinel"), "utf8"), "REBUILD\n");
  } finally {
    f.cleanup();
  }
});

test("I8 failed reconciliation restores the complete original npm store", () => {
  const f = fixture();
  try {
    const source = readFileSync(installer, "utf8");
    const copyExisting = source.slice(source.indexOf("copy_existing() {"), source.indexOf("\nprune_managed_backups() {"));
    const restore = source.slice(source.indexOf("restore_packages() {"), source.indexOf("\npackages_ready() {"));
    const prepare = source.slice(source.indexOf("prepare_package_transaction() {"), source.indexOf('\nif [ "$MODE" = "full" ]; then\n  RUNTIME_BACKUP='));
    const runtimeBackup = join(f.home, "transaction");
    mkdirSync(runtimeBackup);
    const npmStore = join(f.agent, "npm");
    write(join(npmStore, "package.json"), "{\"name\":\"synthetic-store\"}\n", 0o640);
    write(join(npmStore, "node_modules", "unrelated-package", "sentinel"), "ORIGINAL\n");
    symlinkSync("sentinel", join(npmStore, "node_modules", "unrelated-package", "sentinel-link"));

    const result = spawnSync("/bin/bash", ["-c", [
      "set -euo pipefail",
      copyExisting,
      restore,
      prepare,
      "PACKAGE_ROLLBACK_NEEDED=0",
      "prepare_package_transaction",
      'printf "MUTATED\\n" > "$AGENT_DIR/npm/package.json"',
      'rm -f "$AGENT_DIR/npm/node_modules/unrelated-package/sentinel"',
      'printf "NEW\\n" > "$AGENT_DIR/npm/new-entry"',
      "restore_packages",
    ].join("\n")], {
      env: { ...process.env, AGENT_DIR: f.agent, RUNTIME_BACKUP: runtimeBackup },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(npmStore, "package.json"), "utf8"), "{\"name\":\"synthetic-store\"}\n");
    assert.equal(statSync(join(npmStore, "package.json")).mode & 0o777, 0o640);
    assert.equal(readFileSync(join(npmStore, "node_modules", "unrelated-package", "sentinel"), "utf8"), "ORIGINAL\n");
    assert.equal(lstatSync(join(npmStore, "node_modules", "unrelated-package", "sentinel-link")).isSymbolicLink(), true);
    assert.equal(existsSync(join(npmStore, "new-entry")), false);
  } finally {
    f.cleanup();
  }
});

test("I12 retention prunes only future-marked expired managed backups", () => {
  const f = fixture();
  try {
    const source = readFileSync(installer, "utf8");
    const prune = source.slice(source.indexOf("prune_managed_backups() {"), source.indexOf("\nrestore_config() {"));
    assert.match(source, /printf '%s\\n' "\$BACKUP_MARKER_VALUE" > "\$BACKUP\/\$BACKUP_MARKER"/);
    const successTail = source.slice(source.lastIndexOf("PACKAGE_ROLLBACK_NEEDED=0"));
    assert.match(successTail, /prune_managed_backups/);
    const state = join(f.home, ".local", "state", "pi-setup");
    const unmarked = join(state, "backups", "legacy-unmarked");
    const expired = join(state, "backups", "future-expired");
    const fresh = join(state, "backups", "future-fresh");
    for (const dir of [unmarked, expired, fresh]) {
      mkdirSync(dir, { recursive: true });
      write(join(dir, "sentinel"), "KEEP\n");
    }
    const marker = ".pi-setup-managed-backup-v1";
    const markerValue = "pi-setup-managed-config-backup-v1";
    for (const dir of [expired, fresh]) write(join(dir, marker), `${markerValue}\n`);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(expired, marker), old, old);

    const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${prune}\nprune_managed_backups`], {
      env: {
        ...process.env,
        STATE_DIR: state,
        BACKUP_MARKER: marker,
        BACKUP_MARKER_VALUE: markerValue,
        BACKUP_RETENTION_DAYS: "30",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(unmarked), true, "legacy unmarked backup was adopted or deleted");
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(fresh), true);
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
    for (const rel of ["zentui.json", "scrub-session-secrets.sh", "extensions", "skills", "prompts", "agents"]) {
      assert.equal(existsSync(join(f.agent, rel)), false, `${rel} should remain absent after rollback`);
    }
  } finally {
    f.cleanup();
  }
});
