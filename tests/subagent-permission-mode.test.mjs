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

function harness() {
  resetPermissionRuntime();
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  const notices = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
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
      setWidget() {},
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

  return { ctx, emit, entries, notices, tools };
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

test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  resetPermissionRuntime();
});
