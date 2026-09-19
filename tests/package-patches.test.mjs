import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePatches, oauthPackageDir, matchesPatch, applyPackagePatches, verifyPackagePatches, verifyOAuthCheckout } from "../scripts/package-patches.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = process.env.PI_SETUP_PACKAGE_AGENT_DIR ?? join(homedir(), ".pi/agent");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-all-patches-"));
  mkdirSync(dirname(join(dir, oauthPackageDir)), { recursive: true });
  // Local clone copies only public committed package code, never auth/runtime data.
  execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", join(installed, oauthPackageDir), join(dir, oauthPackageDir)]);
  for (const patch of packagePatches) {
    for (const file of Object.keys(patch.targets)) {
      const path = join(dir, patch.packageDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(installed, patch.packageDir, file)));
    }
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function images(dir) {
  return Object.fromEntries(packagePatches.flatMap(patch => Object.keys(patch.targets).map(file => {
    const path = join(dir, patch.packageDir, file);
    return [`${patch.packageDir}/${file}`, digest(readFileSync(path))];
  })));
}

function reverse(dir, patch) {
  execFileSync("patch", ["-p1", "-s", "--batch", "-R", "-d", join(dir, patch.packageDir)], {
    input: readFileSync(join(root, "patches", patch.patch)),
  });
}

test("manifest covers every patch and all changed targets with exact images", () => {
  assert.deepEqual(packagePatches.map(p => p.patch).sort(), readdirSync(join(root, "patches")).filter(p => p.endsWith(".patch")).sort());
  for (const patch of packagePatches) {
    const text = readFileSync(join(root, "patches", patch.patch), "utf8");
    const paths = [...text.matchAll(/^\+\+\+ b\/([^\t\r\n]+)/gm)].map(m => m[1]);
    assert.ok(paths.length);
    assert.deepEqual(paths.sort(), Object.keys(patch.targets).sort());
    for (const hashes of Object.values(patch.targets)) {
      if (hashes.before !== null) assert.match(hashes.before, /^[0-9a-f]{64}$/);
      assert.match(hashes.after, /^[0-9a-f]{64}$/);
    }
  }
});

test("all four patches round-trip exact upstream bytes and reapply idempotently", () => {
  const f = fixture();
  try {
    verifyPackagePatches(f.dir);
    verifyOAuthCheckout(f.dir);
    for (const patch of packagePatches) {
      reverse(f.dir, patch);
      assert.equal(matchesPatch(f.dir, patch, "before"), true, patch.patch);
    }
    applyPackagePatches(f.dir);
    verifyPackagePatches(f.dir);
    verifyOAuthCheckout(f.dir);
    const before = images(f.dir);
    const times = Object.keys(before).map(file => statSync(join(f.dir, file)).mtimeMs);
    applyPackagePatches(f.dir);
    assert.deepEqual(images(f.dir), before);
    assert.deepEqual(Object.keys(before).map(file => statSync(join(f.dir, file)).mtimeMs), times);
  } finally { f.cleanup(); }
});

test("partial OAuth and modified secondary theme targets are rejected without overwrite", () => {
  const f = fixture();
  try {
    const auth = join(f.dir, oauthPackageDir, "src/auth.ts");
    const after = readFileSync(auth);
    writeFileSync(auth, execFileSync("git", ["-C", join(f.dir, oauthPackageDir), "show", "HEAD:src/auth.ts"]));
    let before = images(f.dir);
    assert.throws(() => applyPackagePatches(f.dir), /Partial or foreign/);
    assert.deepEqual(images(f.dir), before);
    writeFileSync(auth, after);
    const secondary = join(f.dir, "npm/node_modules/pi-background-tasks/src/extension.ts");
    writeFileSync(secondary, readFileSync(secondary, "utf8") + "\n// unexpected change\n");
    before = images(f.dir);
    assert.throws(() => verifyPackagePatches(f.dir), /checksum mismatch/);
    assert.throws(() => applyPackagePatches(f.dir), /Partial or foreign/);
    assert.deepEqual(images(f.dir), before);
  } finally { f.cleanup(); }
});

test("OAuth rejects unrelated tracked and untracked changes", () => {
  const f = fixture();
  try {
    const path = join(f.dir, oauthPackageDir, "package.json");
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
    assert.throws(() => verifyOAuthCheckout(f.dir), /outside the pinned patch/);
    writeFileSync(path, original);
    writeFileSync(join(f.dir, oauthPackageDir, "unrelated.txt"), "unrelated user work\n");
    assert.throws(() => applyPackagePatches(f.dir), /outside the pinned patch/);
  } finally { f.cleanup(); }
});

test("patch application never follows a symlink target", () => {
  const f = fixture();
  try {
    const path = join(f.dir, oauthPackageDir, "src/auth.ts");
    const outside = join(f.dir, "unrelated.ts");
    const bytes = readFileSync(path);
    writeFileSync(outside, bytes);
    rmSync(path);
    symlinkSync(outside, path);
    assert.throws(() => applyPackagePatches(f.dir), /Non-regular/);
    assert.deepEqual(readFileSync(outside), bytes);
  } finally { f.cleanup(); }
});

test("known web-search identity and theme-helper fixes remain covered", () => {
  const api = readFileSync(join(installed, "npm/node_modules/pi-web-search/src/api.ts"), "utf8");
  assert.match(api, /\.\.\.\(isOAuth/);
  assert.ok(api.includes("You are Claude Code, Anthropic's official CLI for Claude."));
  assert.ok(api.includes("system:"));
  assert.ok(api.includes("web_search_20260318"));
  const manager = readFileSync(join(installed, "npm/node_modules/pi-background-tasks/src/ui/background-tasks-manager.ts"), "utf8");
  assert.doesNotMatch(manager, /\bblueBorder\b|\blightBlue\b/);
});

test("installer and doctor share complete patch verification", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  const doctor = readFileSync(join(root, "doctor.sh"), "utf8");
  const health = readFileSync(join(root, "scripts/package-health.mjs"), "utf8");
  assert.match(install, /package-patches\.mjs" "\$PATCH_ACTION"/);
  assert.match(install, /PATCH_ACTION="--check"/);
  assert.match(install, /PATCH_ACTION="--apply"/);
  assert.match(doctor, /package-health\.mjs/);
  assert.match(health, /verifyPackagePatches\(agentDir\)/);
  assert.match(health, /verifyOAuthCheckout\(agentDir\)/);
  assert.doesNotMatch(doctor, /checkout has tracked modifications/);
});
