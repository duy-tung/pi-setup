import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const nodePrefix = resolve(dirname(process.execPath), "..");
const codingAgentRoot = join(nodePrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const runtimePackages = new Map([
  ["@earendil-works/pi-coding-agent", join(codingAgentRoot, "dist", "index.js")],
  ["@earendil-works/pi-ai", join(codingAgentRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")],
  ["@earendil-works/pi-tui", join(codingAgentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")],
  ["typebox", join(codingAgentRoot, "node_modules", "typebox", "build", "index.mjs")],
]);
for (const path of runtimePackages.values()) assert.equal(existsSync(path), true, `missing pinned Pi runtime module: ${path}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const path = runtimePackages.get(specifier);
    return path ? { url: pathToFileURL(path).href, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const root = mkdtempSync(join(tmpdir(), "pi-subagent-mode-"));
const home = join(root, "home");
const work = join(root, "work");
mkdirSync(home);
mkdirSync(work);
const previousHome = process.env.HOME;
process.env.HOME = home;

const { default: subagentExtension } = await import(`../extensions/subagent.ts?mode-lifecycle=${Date.now()}`);
const {
  hasRunningWorkSubagent,
  permissionSubagentProfile,
  resetPermissionRuntime,
} = await import("../extensions/lib/permission-mode.ts");
const {
  expectedSubagentArtifactDir,
  subagentScratchDir,
} = await import("../extensions/lib/subagent-state.ts");

function within(promise, ms = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** `missingTools` simulates a package that is no longer installed. */
function harness({ missingTools = [] } = {}) {
  resetPermissionRuntime();
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  const notices = [];
  const widgets = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      const installed = [
        "read",
        "grep",
        "find",
        "ls",
        "bash",
        "edit",
        "write",
        "web_search",
        "resolve-library-id",
        "query-docs",
        ...tools.keys(),
      ];
      return installed.filter((name) => !missingTools.includes(name)).map((name) => ({ name }));
    },
    registerCommand() {},
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message) {
      entries.push({ type: "custom_message", ...message });
    },
  };
  subagentExtension(pi);

  const ctx = {
    cwd: work,
    mode: "tui",
    hasUI: true,
    model: { provider: "fake", id: "fake-model" },
    thinkingLevel: "off",
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "parent-session",
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: {
      setWidget(name, content) {
        widgets.push({ name, content });
      },
      notify(message, type = "info") {
        notices.push({ message, type });
      },
    },
  };

  async function emit(name, event = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  }

  return { ctx, emit, entries, notices, tools, widgets };
}

test("real work-child startup, interrupt, abort, and shutdown own the mode lock", async () => {
  const fakeChild = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
  const previousArgv1 = process.argv[1];
  const previousMode = process.env.FAKE_RPC_MODE;
  const previousNoSession = process.env.FAKE_RPC_NO_SESSION;
  process.argv[1] = fakeChild;
  process.env.FAKE_RPC_NO_SESSION = "1";

  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  const workTool = h.tools.get("subagent");
  const interruptTool = h.tools.get("interrupt_agent");
  assert.ok(workTool);
  assert.ok(interruptTool);

  try {
    process.env.FAKE_RPC_MODE = "slow-state";
    const controller = new AbortController();
    const aborted = workTool.execute(
      "startup-abort",
      { description: "abort startup", prompt: "wait", profile: "work", run_in_background: true },
      controller.signal,
      undefined,
      h.ctx,
    );
    assert.equal(hasRunningWorkSubagent(), true, "startup must lock mode changes before its first await");
    controller.abort();
    const abortedResult = await within(aborted);
    assert.equal(abortedResult.isError, true);
    assert.equal(hasRunningWorkSubagent(), false, "startup abort must release the mode lock");

    process.env.FAKE_RPC_MODE = "delayed";
    const started = await within(workTool.execute(
      "live-child",
      { description: "live child", prompt: "wait", profile: "work", run_in_background: true },
      undefined,
      undefined,
      h.ctx,
    ));
    const childId = started.details.id;
    assert.equal(hasRunningWorkSubagent(), true);
    assert.equal(permissionSubagentProfile(childId), "work");

    await within(interruptTool.execute(
      "interrupt-child",
      { agent_id: childId },
      undefined,
      undefined,
      h.ctx,
    ));
    assert.equal(hasRunningWorkSubagent(), false, "interrupt releases only after finalization");

    process.env.FAKE_RPC_MODE = "normal";
    const completed = await within(workTool.execute(
      "completed-child",
      { description: "completed child", prompt: "finish", profile: "explore", run_in_background: false },
      undefined,
      undefined,
      h.ctx,
    ));
    assert.equal(completed.details.status, "ready");
    assert.deepEqual(
      h.widgets.at(-1),
      { name: "subagents", content: undefined },
      "settled children must clear from the status widget while remaining resumable",
    );

    process.env.FAKE_RPC_MODE = "delayed";
    const shutdownChild = await within(workTool.execute(
      "shutdown-child",
      { description: "shutdown child", prompt: "wait", profile: "work", run_in_background: true },
      undefined,
      undefined,
      h.ctx,
    ));
    assert.ok(shutdownChild.details.id);
    assert.equal(hasRunningWorkSubagent(), true);
    await within(h.emit("session_shutdown", { reason: "quit" }));
    assert.equal(hasRunningWorkSubagent(), false, "session shutdown must release every work lock");
  } finally {
    process.argv[1] = previousArgv1;
    if (previousMode === undefined) delete process.env.FAKE_RPC_MODE;
    else process.env.FAKE_RPC_MODE = previousMode;
    if (previousNoSession === undefined) delete process.env.FAKE_RPC_NO_SESSION;
    else process.env.FAKE_RPC_NO_SESSION = previousNoSession;
  }
});

test("a profile whose tools are all uninstalled refuses instead of starting a useless child", async () => {
  const h = harness({ missingTools: ["web_search", "resolve-library-id", "query-docs"] });
  await h.emit("session_start", { reason: "startup" });
  const result = await within(h.tools.get("subagent").execute(
    "no-tools",
    { description: "web research", prompt: "look it up", profile: "web", run_in_background: true },
    undefined,
    undefined,
    h.ctx,
  ));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no installed tool left/);
  assert.equal(h.notices.some((notice) => notice.type === "warning"), false);
});

test("a partly uninstalled profile warns once and still delegates", async () => {
  const h = harness({ missingTools: ["query-docs"] });
  await h.emit("session_start", { reason: "startup" });
  // The gap is reported before any child process is started, so a failed spawn
  // in this harness does not hide the notice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await within(h.tools.get("subagent").execute(
      `partial-${attempt}`,
      { description: "trusted change", prompt: "edit", profile: "work", run_in_background: true },
      undefined,
      undefined,
      h.ctx,
    ));
  }
  const warnings = h.notices.filter((notice) => notice.type === "warning" && notice.message.includes("query-docs"));
  assert.equal(warnings.length, 1, "the same gap must be reported once per session");
  assert.match(warnings[0].message, /work profile is missing query-docs/);
});

test("explore scratch is created for the child and removed when the parent session ends", async () => {
  const fakeChild = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
  const previousArgv1 = process.argv[1];
  const previousMode = process.env.FAKE_RPC_MODE;
  const previousNoSession = process.env.FAKE_RPC_NO_SESSION;
  process.argv[1] = fakeChild;
  process.env.FAKE_RPC_MODE = "normal";
  process.env.FAKE_RPC_NO_SESSION = "1";

  try {
    const h = harness();
    await h.emit("session_start", { reason: "startup" });
    const started = await within(h.tools.get("subagent").execute(
      "scratch-child",
      { description: "inspect logs", prompt: "count", profile: "explore", run_in_background: true },
      undefined,
      undefined,
      h.ctx,
    ));
    const artifactDir = expectedSubagentArtifactDir("parent-session", started.details.id);
    const scratch = subagentScratchDir(artifactDir);
    assert.equal(existsSync(scratch), true, "a read-only child needs its writable directory up front");

    await within(h.emit("session_shutdown", { reason: "quit" }));
    assert.equal(existsSync(scratch), false, "scratch belongs to the session that created it");
    assert.equal(existsSync(join(artifactDir, "sessions")), true, "the transcript beside it must survive");
  } finally {
    process.argv[1] = previousArgv1;
    if (previousMode === undefined) delete process.env.FAKE_RPC_MODE;
    else process.env.FAKE_RPC_MODE = previousMode;
    if (previousNoSession === undefined) delete process.env.FAKE_RPC_NO_SESSION;
    else process.env.FAKE_RPC_NO_SESSION = previousNoSession;
  }
});

test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  resetPermissionRuntime();
});
