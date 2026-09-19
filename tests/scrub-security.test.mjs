import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REDACTIONS, redact } from "../extensions/lib/redact.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scrubber = join(root, "scrub-session-secrets.sh");

function credentialCorpus() {
  return [
    ["ANTHROPIC_OAUTH_ACCESS", ["sk-ant-oat01-", "A".repeat(24)].join("")],
    ["ANTHROPIC_OAUTH_REFRESH", ["sk-ant-ort01-", "R".repeat(24)].join("")],
    ["ANTHROPIC_API_KEY", ["sk-ant-api03-", "K".repeat(24)].join("")],
    ["CONTEXT7_KEY", ["ctx7sk-", "a".repeat(24)].join("")],
    ["GITHUB_TOKEN", ["ghp_", "P".repeat(24)].join("")],
    ["GITHUB_PAT", ["github_pat_", "P".repeat(24)].join("")],
    ["AWS_ACCESS_KEY_ID", ["AKIA", "A".repeat(16)].join("")],
    ["OPENAI_KEY", ["sk-proj-", "P".repeat(24)].join("")],
    ["STRIPE_SECRET_KEY", ["sk_live_", "S".repeat(24)].join("")],
    ["GOOGLE_OAUTH_TOKEN", ["ya29.", "G".repeat(24)].join("")],
    ["OPENAI_LEGACY_KEY", ["sk-", "L".repeat(32)].join("")],
    ["OPENAI_LEGACY_KEY", ["sk-", "L".repeat(39)].join("")],
    ["CODEX_REFRESH", ["rt", ".1.", "R".repeat(40)].join("")],
    ["JWT", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "signature-part"].join(".")],
    ["BEARER_TOKEN", ["Bearer", ["opaque-value-", "B".repeat(24)].join("")].join(" ")],
    ["AWS_STS_KEY_ID", ["ASIA", "A".repeat(16)].join("")],
    ["SLACK_TOKEN", ["xoxb-", "S".repeat(24)].join("")],
    ["GOOGLE_API_KEY", ["AIza", "G".repeat(35)].join("")],
    ["OPENAI_LEGACY_KEY", ["sk-", "L".repeat(48)].join("")],
    ["OPENAI_SERVICE_KEY", ["sk-svcacct-", "V".repeat(24)].join("")],
    ["XAI_KEY", ["xai-", "X".repeat(24)].join("")],
    ["HUGGINGFACE_TOKEN", ["hf_", "H".repeat(24)].join("")],
    ["NPM_TOKEN", ["npm_", "N".repeat(24)].join("")],
    ["GITLAB_TOKEN", ["glpat-", "T".repeat(24)].join("")],
    ["TAVILY_KEY", ["tvly-", "Y".repeat(24)].join("")],
    ["PRIVATE_KEY_BLOCK", [["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" "), "truncated-material"].join("\n")],
  ];
}

function fixture(prefix = "pi-scrub-test-") {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runScrub(home, paths = []) {
  return spawnSync("/bin/bash", [scrubber, ...paths], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("I1/I2/I10/I11 scrub is cumulative, idempotent, boundary-safe, and covers every supported family", () => {
  const f = fixture();
  try {
    const corpus = credentialCorpus();
    // The ambiguous, unlabelled AWS-40 heuristic is deliberately inline-only.
    assert.deepEqual(new Set(corpus.map(([label]) => label)),
      new Set(REDACTIONS.map(({ label }) => label).filter(label => label !== "AWS_SECRET_ACCESS_KEY")));
    for (const [label, value] of corpus) {
      const result = redact(value);
      assert.equal(result.hits.includes(label), true, label);
      assert.equal(result.text.includes(value), false, label);
    }

    const first = join(f.home, "session one.txt");
    writeFileSync(first, corpus.map(([, value]) => value).join("\n"));
    let result = runScrub(f.home, [first]);
    assert.equal(result.status, 0, result.stderr);
    const firstBackup = `${first}.bak`;
    assert.equal(statSync(firstBackup).mode & 0o777, 0o600);
    const listPath = join(f.home, ".pi", "agent", "scrub-backups.txt");
    assert.equal(readFileSync(firstBackup, "utf8"), corpus.map(([, value]) => value).join("\n"));
    for (const [, value] of corpus) assert.equal(readFileSync(first, "utf8").includes(value), false);
    assert.deepEqual(readFileSync(listPath, "utf8").trim().split("\n"), [firstBackup]);

    result = runScrub(f.home, [first]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Clean:/);
    assert.deepEqual(readFileSync(listPath, "utf8").trim().split("\n"), [firstBackup]);

    const secondToken = ["ghp_", "Q".repeat(24)].join("");
    const second = join(f.home, "session two.jsonl");
    writeFileSync(second, secondToken);
    result = runScrub(f.home, [second]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(listPath, "utf8").trim().split("\n"), [firstBackup, `${second}.bak`]);

    writeFileSync(first, ["tvly-", "Z".repeat(24)].join(""));
    result = runScrub(f.home, [first]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readdirSync(f.home).includes("session one.txt.bak.1"), true);
    assert.deepEqual(readFileSync(listPath, "utf8").trim().split("\n"), [
      firstBackup,
      `${second}.bak`,
      `${first}.bak.1`,
    ]);

    const falsePositive = join(f.home, "boundary.txt");
    writeFileSync(falsePositive, ["Xghp_", "P".repeat(24)].join(""));
    result = runScrub(f.home, [falsePositive]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Clean:/);
    assert.equal(readdirSync(f.home).some((name) => name.startsWith("boundary.txt.bak")), false);
  } finally {
    f.cleanup();
  }
});

test("I9/I11 default discovery resolves symlink HOME, prunes excluded trees, and scans rewind blobs", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-scrub-discovery-"));
  const actualHome = join(parent, "actual-home");
  const linkedHome = join(parent, "linked-home");
  try {
    mkdirSync(join(actualHome, ".pi", "agent"), { recursive: true });
    symlinkSync(actualHome, linkedHome);
    const token = ["gho_", "D".repeat(24)].join("");
    const rewindBlob = join(actualHome, "project", ".pi", "rewind", "blob-no-extension");
    const libraryBlob = join(actualHome, "Library", "project", ".pi", "rewind", "ignored");
    const moduleBlob = join(actualHome, "project", "node_modules", "pkg", ".pi", "rewind", "ignored");
    for (const path of [rewindBlob, libraryBlob, moduleBlob]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, token);
    }

    const result = runScrub(linkedHome);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(rewindBlob, "utf8").includes(token), false);
    assert.equal(readFileSync(libraryBlob, "utf8"), token);
    assert.equal(readFileSync(moduleBlob, "utf8"), token);
    const list = readFileSync(join(actualHome, ".pi", "agent", "scrub-backups.txt"), "utf8");
    assert.equal(list.trim(), `${realpathSync.native(rewindBlob)}.bak`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("I3 audit rejects every credential family in the shared synthetic corpus without printing values", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-audit-patterns-"));
  const repo = join(parent, "repo");
  try {
    const gitDir = join(root, ".git");
    cpSync(root, repo, {
      recursive: true,
      filter: (source) => source !== gitDir && !source.startsWith(`${gitDir}/`),
    });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const corpus = credentialCorpus();
    const probe = join(repo, "skills", "audit-pattern-probe.md");
    writeFileSync(probe, corpus.map(([, value]) => value).join("\n"));

    const result = spawnSync(process.execPath, [join(repo, "scripts", "audit-repo.mjs"), repo], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    for (const expected of [
      "Codex refresh token", "JWT", "Bearer token", "AWS access key", "Slack token",
      "Google API key", "Google OAuth token", "Stripe secret key", "legacy OpenAI key", "OpenAI service key", "xAI key",
      "Hugging Face token", "npm token", "GitLab token", "Tavily key", "private-key material",
    ]) assert.equal(result.stderr.includes(expected), true, expected);
    for (const [, value] of corpus) assert.equal(result.stderr.includes(value), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("each credential family is detected in isolation, not only beside another family", () => {
  const f = fixture();
  try {
    const corpus = credentialCorpus();
    corpus.forEach(([, value], index) => writeFileSync(join(f.home, `${index}.txt`), value));
    const result = runScrub(f.home, [f.home]);
    assert.equal(result.status, 0, result.stderr);
    corpus.forEach(([label, value], index) => {
      assert.equal(readFileSync(join(f.home, `${index}.txt`), "utf8").includes(value), false, label);
    });
  } finally { f.cleanup(); }
});

test("default discovery scrubs background .output logs without broadening to JSON credentials", () => {
  const f = fixture();
  try {
    const value = ["sk_live_", "S".repeat(24)].join("");
    const logs = [join(f.home, ".pi", "tasks", "session-test", "job.output"),
      join(f.home, "project", ".pi", "tasks", "session-test", "job.output")];
    const auth = join(f.home, ".pi", "agent", "auth.json");
    writeFileSync(auth, JSON.stringify({ synthetic: value }));
    for (const file of logs) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }
    const result = runScrub(f.home);
    assert.equal(result.status, 0, result.stderr);
    for (const file of logs) {
      assert.equal(readFileSync(file, "utf8").includes(value), false);
      assert.equal(readFileSync(`${file}.bak`, "utf8"), value);
      assert.equal(statSync(`${file}.bak`).mode & 0o777, 0o600);
    }
    assert.equal(JSON.parse(readFileSync(auth, "utf8")).synthetic, value);
    assert.equal(existsSync(`${auth}.bak`), false);
  } finally { f.cleanup(); }
});

test("offline scrub deliberately excludes ambiguous AWS-40 strings and respects prefix boundaries", () => {
  const f = fixture();
  try {
    const ambiguous = "Ab1Z".repeat(10);
    assert.ok(redact(ambiguous).hits.includes("AWS_SECRET_ACCESS_KEY"));
    const boundaries = ["Xya29." + "a".repeat(24), "Xsk_live_" + "a".repeat(24),
      "ya29." + "a".repeat(19), "sk_live_" + "a".repeat(19), "sk-" + "a".repeat(31)];
    assert.equal(redact(boundaries.join("\n")).text, boundaries.join("\n"));
    const file = join(f.home, "ordinary-data.txt");
    const source = [ambiguous, ...boundaries].join("\n");
    writeFileSync(file, source);
    const result = runScrub(f.home, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), source);
    assert.equal(existsSync(`${file}.bak`), false);
  } finally { f.cleanup(); }
});
