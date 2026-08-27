import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchName = "pi-web-search-oauth-system.patch";
const patchFile = join(root, "patches", patchName);
const install = readFileSync(join(root, "install.sh"), "utf8");
const doctor = readFileSync(join(root, "doctor.sh"), "utf8");
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";

// The upstream pi-web-search@1.3.1 request body the patch rewrites. `patch`
// applies with offset tolerance, so this excerpt needs the hunk context only.
const upstreamExcerpt = `    }

    const maxTokens = Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
    const requestBody = {
        model: model.id,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        stream: true,
`;

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "pi-setup-patch-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "api.ts"), upstreamExcerpt);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runPatch(dir, extra = []) {
  return spawnSync("patch", ["-p1", "-s", "--batch", "--forward", ...extra, "-d", dir], {
    input: readFileSync(patchFile, "utf8"),
    encoding: "utf8",
  });
}

function shellConstant(script, name) {
  const match = new RegExp(`^${name}="([^"]*)"$`, "m").exec(script);
  assert.ok(match, `${name} is not pinned`);
  return match[1];
}

test("the package patch adds the Claude Code identity that OAuth web search requires", () => {
  const f = stage();
  try {
    const applied = runPatch(f.dir);
    assert.equal(applied.status, 0, `patch failed:\n${applied.stderr}`);
    const result = readFileSync(join(f.dir, "src", "api.ts"), "utf8");
    assert.match(result, /\.\.\.\(isOAuth/, "the system block must stay OAuth-only");
    assert.ok(result.includes(identity), "patched request body must carry the Claude Code identity");
    assert.ok(result.includes("system:"), "patched request body must set a system field");
  } finally {
    f.cleanup();
  }
});

test("the package patch refuses to apply twice", () => {
  const f = stage();
  try {
    assert.equal(runPatch(f.dir).status, 0);
    assert.notEqual(runPatch(f.dir, ["--dry-run"]).status, 0, "an applied tree must refuse a second forward apply");
  } finally {
    f.cleanup();
  }
});

test("install and doctor pin the same patch, target, and post-image checksum", () => {
  for (const name of ["WEB_SEARCH_PATCH", "WEB_SEARCH_PATCH_TARGET", "WEB_SEARCH_PATCHED_SHA256"]) {
    assert.equal(shellConstant(install, name), shellConstant(doctor, name), `${name} differs between install.sh and doctor.sh`);
  }
  assert.equal(shellConstant(install, "WEB_SEARCH_PATCH"), patchName);
  assert.equal(shellConstant(install, "WEB_SEARCH_PATCH_TARGET"), "src/api.ts");
  assert.match(shellConstant(install, "WEB_SEARCH_PATCHED_SHA256"), /^[0-9a-f]{64}$/, "the post-image pin must be a sha256 digest");
});

test("install applies every patch under patches/ and doctor verifies the result", () => {
  assert.match(install, /apply_package_patch "\$WEB_SEARCH_PATCH"/, "install.sh must apply the patch");
  assert.match(doctor, /shasum -a 256 "\$web_search_target"/, "doctor.sh must checksum the live patched source");
  assert.match(doctor, /"\$WEB_SEARCH_PATCHED_SHA256"/, "doctor.sh must compare the pinned checksum");
  for (const script of [install, doctor]) {
    assert.match(script, /command -v patch/, "both scripts must require patch");
    assert.match(script, /command -v shasum/, "both scripts must require shasum");
  }
});
