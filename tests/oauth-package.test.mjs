// Exercise the captured OAuth compatibility/wire/lifecycle tests from the canonical
// package, in a disposable HOME and build directory. Never use real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { oauthPackageDir } from "../scripts/package-patches.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const installed = join(agentDir, oauthPackageDir);

test("canonical OAuth package passes its captured synthetic regressions", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-oauth-regressions-"));
  try {
    for (const file of ["src", "test", "package.json", "tsconfig.json", "README.md"]) {
      cpSync(join(installed, file), join(dir, file), { recursive: true });
    }
    symlinkSync(join(installed, "node_modules"), join(dir, "node_modules"), "dir");
    const compiler = createRequire(join(installed, "package.json")).resolve("typescript/bin/tsc");
    const env = { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, ".pi/agent"), PI_OFFLINE: "1", NO_COLOR: "1" };
    for (const key of Object.keys(env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key) || ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "FORCE_COLOR", "PI_SESSION_FILE", "PI_SESSION_ID"].includes(key)) delete env[key];
    }
    env.PI_ANTHROPIC_OAUTH_REWRITE_MODE = "technical-safe";
    const run = args => {
      const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    };
    run([compiler, "-p", "tsconfig.json", "--outDir", ".test-dist"]);
    const files = readdirSync(join(dir, "test")).filter(file => file.endsWith(".test.mjs")).map(file => join(dir, "test", file));
    const result = run(["--test", "--test-reporter=spec", ...files]);
    assert.match(result.stdout, /tests 38\b/);
    assert.match(result.stdout, /pass 38\b/);
    assert.match(result.stdout, /skipped 0\b/);
    t.diagnostic("OAuth package: 38/38 synthetic tests passed.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
