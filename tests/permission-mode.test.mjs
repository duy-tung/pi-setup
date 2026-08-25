import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const nodePrefix = resolve(dirname(process.execPath), "..");
const codingAgentRoot = join(nodePrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const runtimePackages = new Map([
  ["@earendil-works/pi-coding-agent", join(codingAgentRoot, "dist", "index.js")],
  ["@earendil-works/pi-tui", join(codingAgentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")],
]);
for (const path of runtimePackages.values()) assert.equal(existsSync(path), true, `missing pinned Pi runtime module: ${path}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const path = runtimePackages.get(specifier);
    return path ? { url: pathToFileURL(path).href, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { default: permissionModeExtension } = await import("../extensions/permission-mode.ts");
const {
  DEFAULT_PERMISSION_MODE,
  getPermissionMode,
  markWorkSubagentRunning,
  resetPermissionRuntime,
} = await import("../extensions/lib/permission-mode.ts");

function stateEntry(mode, extra = {}) {
  return {
    type: "custom",
    customType: "permission-mode-state",
    data: { version: 1, mode, ...extra },
  };
}

function fixture(initialTools = ["read", "bash", "edit", "write", "custom_read"]) {
  resetPermissionRuntime();
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = [];
  const branch = [];
  const entries = [];
  const notifications = [];
  const statuses = new Map();
  const available = new Set([...initialTools, "read", "bash", "edit", "write", "dynamic_tool"]);
  let active = [...initialTools];
  let idle = true;
  let confirmResult = true;
  let selectorKey = "1";
  let selectorLines = [];

  const pi = {
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(key, options) {
      shortcuts.push({ key, options });
    },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    getActiveTools() {
      return [...active];
    },
    getAllTools() {
      return [...available].map((name) => ({ name }));
    },
    setActiveTools(names) {
      active = [...new Set(names)].filter((name) => available.has(name));
    },
  };
  permissionModeExtension(pi);

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      setStatus(key, value) {
        statuses.set(key, value);
      },
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
      async confirm() {
        return confirmResult;
      },
      async custom(factory) {
        let finish;
        const result = new Promise((resolve) => {
          finish = resolve;
        });
        const component = await factory({ requestRender() {} }, this.theme, {}, finish);
        selectorLines = component.render(100);
        component.handleInput(selectorKey);
        return result;
      },
    },
  };

  async function emit(name, event = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  }

  return {
    active: () => [...active],
    addActive(name) {
      available.add(name);
      if (!active.includes(name)) active.push(name);
    },
    branch,
    commands,
    ctx,
    emit,
    entries,
    notifications,
    setConfirm(value) {
      confirmResult = value;
    },
    setIdle(value) {
      idle = value;
    },
    setSelectorKey(value) {
      selectorKey = value;
    },
    selectorLines: () => [...selectorLines],
    statuses,
  };
}

test("Auto is the default and malformed later state does not erase an earlier valid mode", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  assert.equal(getPermissionMode(), DEFAULT_PERMISSION_MODE);
  assert.equal(f.statuses.get("permission-mode"), "◆ auto");

  f.branch.push(stateEntry("manual"), stateEntry("not-a-mode"), stateEntry("bypass"));
  await f.emit("session_start", { reason: "resume" });
  assert.equal(getPermissionMode(), "manual");
});

test("the TUI selector renders all five modes and supports numeric selection", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  f.setSelectorKey("2");
  await f.commands.get("mode").handler("", f.ctx);
  const rendered = f.selectorLines().join("\n");
  for (const label of ["Auto", "Manual", "Accept edits", "Plan", "Bypass permissions"]) {
    assert.match(rendered, new RegExp(label));
  }
  assert.equal(getPermissionMode(), "manual");
});

test("Plan removes only Bash/edit/write and restores its owned delta without dropping dynamic tools", async () => {
  const f = fixture(["read", "bash", "edit", "custom_read"]); // write began disabled
  await f.emit("session_start", { reason: "startup" });
  await f.commands.get("mode").handler("plan", f.ctx);
  assert.equal(getPermissionMode(), "plan");
  assert.deepEqual(f.active(), ["read", "custom_read"]);

  f.addActive("dynamic_tool");
  await f.commands.get("mode").handler("auto", f.ctx);
  assert.equal(getPermissionMode(), "auto");
  assert.deepEqual(f.active(), ["read", "custom_read", "dynamic_tool", "bash", "edit"]);
  assert.equal(f.active().includes("write"), false);
});

test("Plan projection is restored before extension reload", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  await f.commands.get("mode").handler("plan", f.ctx);
  assert.deepEqual(f.active(), ["read", "custom_read"]);
  await f.emit("session_shutdown", { reason: "reload" });
  assert.deepEqual(f.active(), ["read", "custom_read", "bash", "edit", "write"]);
});

test("durable branch modes restore on navigation while transient Bypass remains runtime-local", async () => {
  const f = fixture();
  f.branch.push(stateEntry("manual"));
  await f.emit("session_start", { reason: "resume" });
  assert.equal(getPermissionMode(), "manual");

  f.branch.length = 0;
  f.branch.push(stateEntry("plan"));
  await f.emit("session_tree", { newLeafId: "plan-leaf" });
  assert.equal(getPermissionMode(), "plan");
  assert.equal(f.active().includes("bash"), false);

  await f.commands.get("mode").handler("bypass", f.ctx);
  assert.equal(getPermissionMode(), "bypass");
  assert.equal(f.entries.at(-1).data.mode, "auto");

  f.branch.length = 0;
  f.branch.push(stateEntry("manual"));
  await f.emit("session_tree", { newLeafId: "other-leaf" });
  assert.equal(getPermissionMode(), "bypass");

  await f.emit("session_start", { reason: "reload" });
  assert.equal(getPermissionMode(), "manual");
});

test("mode changes fail closed while the parent or a work child is active", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });

  f.setIdle(false);
  await f.commands.get("mode").handler("manual", f.ctx);
  assert.equal(getPermissionMode(), "auto");

  f.setIdle(true);
  markWorkSubagentRunning("child-1", true);
  await f.commands.get("mode").handler("plan", f.ctx);
  assert.equal(getPermissionMode(), "auto");
  assert.match(f.notifications.at(-1).message, /work subagent is still running/i);
  assert.deepEqual(await f.emit("session_before_tree", { preparation: {} }), { cancel: true });
  assert.match(f.notifications.at(-1).message, /navigation is blocked/i);
  markWorkSubagentRunning("child-1", false);
});

test("subagent mode command explains fixed child scope without claiming parent-mode inheritance", async () => {
  const previous = process.env.PI_SUBAGENT_DEPTH;
  const f = fixture();
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("mode").handler("plan", f.ctx);
    assert.equal(getPermissionMode(), "auto");
    assert.match(f.notifications.at(-1).message, /child runtime default/);
    assert.match(f.notifications.at(-1).message, /parent mode is not inherited/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previous;
    resetPermissionRuntime();
  }
});

test("Bypass cannot be restored from durable session state", async () => {
  const f = fixture();
  f.branch.push(stateEntry("bypass"));
  await f.emit("session_start", { reason: "resume" });
  assert.equal(getPermissionMode(), "auto");
});
