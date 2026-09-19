// A patched package must not introduce a type error of its own.
//
// The blueBorder regression was exactly this class: the theme patch deleted a
// helper and left one call behind, which only a render test could catch after
// the fact. TypeScript sees it immediately, so every patch under patches/ is
// compiled against the installed Pi types and compared with the same tree with
// the patch reversed. Upstream's own type errors are therefore tolerated and
// only errors the patch adds fail this test.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePatches, oauthPackageDir } from "../scripts/package-patches.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const store = join(agentDir, "npm/node_modules");
const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const host = resolve(dirname(cli), "../..");
const hostModules = join(host, "node_modules/@earendil-works");

// No npm dependency of our own: use any TypeScript already on this machine.
function findCompiler() {
  const candidates = [process.env.PI_SETUP_TSC, join(host, "node_modules/typescript/bin/tsc")].filter(Boolean);
  for (const dir of [root, agentDir, join(agentDir, oauthPackageDir), join(agentDir, "local-packages/pi-anthropic-oauth-plus")]) {
    try { candidates.push(createRequire(join(dir, "noop.js")).resolve("typescript/bin/tsc")); } catch { /* not here */ }
  }
  for (const candidate of candidates) {
    if (spawnSync(process.execPath, [candidate, "--version"], { encoding: "utf8" }).status === 0) return resolve(candidate);
  }
  return null;
}

function typecheck(compiler, sources, workspace) {
  const nodeTypes = dirname(createRequire(compiler).resolve("@types/node/package.json"));
  const config = join(workspace, "tsconfig.json");
  writeFileSync(join(workspace, "shims.d.ts"), 'declare module "turndown" { const value: unknown; export default value; }\n');
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext",
      noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
      types: ["node"], typeRoots: [dirname(nodeTypes)], paths: {
        "@earendil-works/pi-coding-agent": [join(host, "dist/index.d.ts")],
        "@earendil-works/pi-tui": [join(hostModules, "pi-tui/dist/index.d.ts")],
        "@earendil-works/pi-tui/*": [join(hostModules, "pi-tui/dist/*.d.ts")],
        "@earendil-works/pi-ai": [join(hostModules, "pi-ai/dist/index.d.ts")],
        "@earendil-works/pi-ai/*": [join(hostModules, "pi-ai/dist/*.d.ts")],
        "@earendil-works/pi-agent-core": [join(hostModules, "pi-agent-core/dist/index.d.ts")],
        turndown: [join(workspace, "shims.d.ts")],
      },
    },
    include: [`${sources}/**/*.ts`, join(workspace, "shims.d.ts")],
  }));
  const result = spawnSync(process.execPath, [compiler, "-p", config], { cwd: sources, encoding: "utf8", timeout: 300_000 });
  assert.equal(result.error, undefined, `compiler did not finish: ${result.error?.message}`);
  assert.notEqual(result.status, null, "compiler terminated by signal");
  const diagnostics = (result.stdout + result.stderr).split("\n")
    .map(line => line.replace(/\(\d+,\d+\): /, ": ").trim()).filter(line => /error TS\d+/.test(line));
  assert.ok(result.status === 0 || diagnostics.length > 0, `compiler failed without diagnostics: ${result.stdout}${result.stderr}`);
  // Preserve relative file names and multiplicity: shifted line numbers are
  // harmless, but another instance of an existing error is still a regression.
  const counts = new Map();
  for (const diagnostic of diagnostics) counts.set(diagnostic, (counts.get(diagnostic) ?? 0) + 1);
  return counts;
}

const compiler = findCompiler();

for (const { patch, packageDir, targets } of packagePatches) {
  test(`${patch} adds no type error to ${packageDir}`, t => {
    if (!compiler) {
      // Never silently green: doctor prints the same warning next to this skip.
      t.skip("no TypeScript compiler found; set PI_SETUP_TSC to enforce this gate");
      return;
    }
    // macOS /var -> /private/var otherwise produces variant-specific diagnostic paths.
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-patch-typecheck-")));
    try {
      symlinkSync(store, join(workspace, "node_modules"), "dir");
      for (const variant of ["live", "upstream"]) {
        mkdirSync(join(workspace, variant), { recursive: true });
        const nested = join(agentDir, packageDir, "node_modules");
        if (existsSync(nested)) symlinkSync(nested, join(workspace, variant, "node_modules"), "dir");
        cpSync(join(agentDir, packageDir, "src"), join(workspace, variant, "src"), { recursive: true });
        cpSync(join(agentDir, packageDir, "package.json"), join(workspace, variant, "package.json"));
        // OAuth's captured patch includes its regression tests/documentation too.
        for (const file of Object.keys(targets).filter(file => !file.startsWith("src/"))) {
          if (!existsSync(join(agentDir, packageDir, file))) continue;
          mkdirSync(dirname(join(workspace, variant, file)), { recursive: true });
          cpSync(join(agentDir, packageDir, file), join(workspace, variant, file));
        }
      }
      const reversed = spawnSync("patch", ["-p1", "-s", "--batch", "-R", "-d", join(workspace, "upstream")], {
        input: readFileSync(join(root, "patches", patch), "utf8"), encoding: "utf8",
      });
      assert.equal(reversed.status, 0, `the installed ${packageDir} does not carry ${patch}: ${reversed.stdout}${reversed.stderr}`);
      const upstream = typecheck(compiler, join(workspace, "upstream"), workspace);
      const introduced = [...typecheck(compiler, join(workspace, "live"), workspace)]
        .filter(([error, count]) => count > (upstream.get(error) ?? 0));
      assert.deepEqual(introduced, [], `${patch} introduces type errors upstream does not have`);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
}
