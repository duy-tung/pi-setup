import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

// Import the installed loader only after isolating all runtime state.
const home = mkdtempSync(join(tmpdir(), "pi-snapshot-loader-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.PI_OFFLINE = "1";
after(() => rmSync(home, { recursive: true, force: true }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = resolve(dirname(cli), "../..");
const { loadExtensions, loadExtensionsCached } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);

async function harness(load = loadExtensions) {
  // Include the old entrypoint if present: this reproduces the original two-jiti bug.
  const paths = ["context-snapshots.ts", "runtime-context.ts"]
    .map(name => join(root, "extensions", name)).filter(existsSync);
  const result = await load(paths, home);
  assert.deepEqual(result.errors, []);
  let branch = [];
  const ctx = { cwd: home, sessionManager: { getBranch: () => branch } };
  return {
    setBranch(entries) { branch = entries; },
    async emit(name, event = {}) {
      const results = [];
      for (const extension of result.extensions) {
        for (const handler of extension.handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
      }
      return results;
    },
  };
}
const customEntry = content => ({ type: "custom_message", customType: "runtime-context", content });
const projected = async (h, messages = []) => (await h.emit("context", { messages })).find(r => r?.messages)?.messages;

test("actual Pi loader reinserts a runtime snapshot after compaction without duplicating history", async () => {
  const h = await harness();
  await h.emit("session_start");
  const first = (await h.emit("before_agent_start")).find(r => r?.message);
  assert.ok(first?.message.content.includes("Date:"));
  assert.equal((await h.emit("before_agent_start")).some(r => r?.message), false);

  const compacted = [{ role: "compactionSummary", summary: "older history", tokensBefore: 100, timestamp: 0 }];
  const before = structuredClone(compacted);
  const messages = await projected(h, compacted);
  assert.deepEqual(compacted, before, "original history must not be mutated");
  assert.equal(messages.filter(m => m.customType === "runtime-context").length, 1);
  assert.equal(messages.at(-1).content, first.message.content);
  assert.deepEqual(await projected(h, messages), messages, "projection must be idempotent");
});

test("actual cached factories keep instance state separate and recover the selected session branch", async () => {
  const a = await harness(loadExtensionsCached);
  const b = await harness(loadExtensionsCached);
  a.setBranch([customEntry("branch-a")]);
  b.setBranch([customEntry("branch-b")]);
  await a.emit("session_start");
  await b.emit("session_start");
  assert.equal((await projected(a))[0].content, "branch-a");
  assert.equal((await projected(b))[0].content, "branch-b");

  a.setBranch([customEntry("selected-branch")]);
  await a.emit("session_tree");
  assert.equal((await projected(a))[0].content, "selected-branch");
  assert.equal((await projected(b))[0].content, "branch-b");

  a.setBranch([]);
  await a.emit("session_start");
  assert.deepEqual(await projected(a), []);
  assert.deepEqual(await projected(a, [{ role: "custom", customType: "permission-mode-context", content: "retired" }]), []);
});
