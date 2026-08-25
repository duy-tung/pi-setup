import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piPackage = resolve(dirname(piCli), "..", "..");
const { loadProjectContextFiles } = await import(pathToFileURL(join(piPackage, "dist", "core", "resource-loader.js")).href);

test("repo-only AGENTS override prevents loading the managed policy twice", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-context-precedence-"));
  try {
    const agentDir = join(fixture, "agent");
    const repo = join(fixture, "repo");
    const nested = join(repo, "src");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "global policy\n");
    writeFileSync(join(repo, "AGENTS.md"), "portable source copy\n");
    writeFileSync(join(repo, "AGENTS.override.md"), "repo override\n");

    const contexts = loadProjectContextFiles({ cwd: nested, agentDir });
    assert.deepEqual(contexts.map((entry) => entry.content), ["global policy\n", "repo override\n"]);
    assert.equal(contexts.some((entry) => entry.path === join(repo, "AGENTS.md")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  const override = readFileSync(join(root, "AGENTS.override.md"), "utf8");
  assert.match(override, /Keep this override repository-local/);
  const managed = readFileSync(join(root, "scripts", "managed-paths.txt"), "utf8").trim().split("\n");
  assert.equal(managed.includes("AGENTS.override.md"), false);
});

test("grilling and code-review prompts remain bounded and avoid copied rubrics", () => {
  const grilling = readFileSync(join(root, "skills", "grilling", "SKILL.md"), "utf8");
  assert.match(grilling, /at most four highest-impact frontier questions/);
  assert.match(grilling, /high-volume or genuinely independent/);
  assert.match(grilling, /no unresolved material decision remains/);
  assert.equal(grilling.includes("every branch of the design tree visited"), false);

  const review = readFileSync(join(root, "skills", "code-review", "SKILL.md"), "utf8");
  assert.match(review, /Ask the user only if those inspectable sources do not identify it/);
  assert.match(review, /skills\/code-review\/STANDARDS-RUBRIC\.md/);
  assert.equal(review.includes("pasted in full"), false);
  const rubric = readFileSync(join(root, "skills", "code-review", "STANDARDS-RUBRIC.md"), "utf8");
  assert.match(rubric, /## Smell baseline/);
  assert.match(rubric, /## Review axes/);
});

test("Context7 keeps explicit tools and prompt while filtering its recurring package skill", () => {
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  const context7 = settings.packages.find((entry) => typeof entry === "object" && entry.source?.includes("context7-pi"));
  assert.deepEqual(context7, { source: "npm:@upstash/context7-pi@0.1.2", skills: [] });
});

test("subagent mode notice distinguishes fixed profile from inherited parent mode", () => {
  const source = readFileSync(join(root, "extensions", "permission-mode.ts"), "utf8");
  assert.match(source, /parent selected this child's tool profile, but parent mode is not inherited/);
  assert.equal(source.includes("Permission mode is fixed by the parent"), false);
});
