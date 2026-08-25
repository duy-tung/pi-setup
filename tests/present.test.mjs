import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const tui = createRequire(piCli).resolve("@earendil-works/pi-tui");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      return { url: pathToFileURL(tui).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  PRESENT_MAX_RESULT_BYTES,
  PRESENT_MAX_SOURCE_BYTES,
  PRESENT_MODEL,
  PRESENT_SYSTEM_PROMPT,
  buildPresentCliArgs,
  preservesFencedBlocks,
  preservesProtectedLiterals,
  proseLength,
  protectedLiterals,
  registerPresent,
  scanFencedBlocks,
} = await import("../extensions/present.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const longText = (suffix = "") => `${"A clear sentence with useful facts and paths. ".repeat(8)}${suffix}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeRpcChild {
  listeners = new Set();
  promptMessage = undefined;
  lastText = null;
  disposed = false;
  state;
  resolveSettlement;
  rejectSettlement;
  settlement;
  promptGate;
  disposeError;

  constructor(state = {}) {
    this.state = {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "off",
      isStreaming: false,
      sessionId: "ephemeral-present",
      pendingMessageCount: 0,
      ...state,
    };
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message) {
    this.promptMessage = message;
    if (this.promptGate) await this.promptGate;
  }

  nextSettlement(_timeoutMs, signal) {
    this.settlement = new Promise((resolve, reject) => {
      this.resolveSettlement = resolve;
      this.rejectSettlement = reject;
    });
    const abort = () => this.rejectSettlement?.(new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return this.settlement;
  }

  async getState() {
    return this.state;
  }

  async getLastAssistantText() {
    return this.lastText;
  }

  complete(text, overrides = {}) {
    this.lastText = text;
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: {
          totalTokens: 321,
          cost: { total: 0.123 },
        },
        ...overrides,
      },
    };
    for (const listener of this.listeners) listener(event);
    this.resolveSettlement?.();
  }

  async dispose() {
    if (this.disposed) {
      if (this.disposeError) throw this.disposeError;
      return;
    }
    this.disposed = true;
    this.rejectSettlement?.(new Error("disposed"));
    if (this.disposeError) throw this.disposeError;
  }
}

function sourceEntry(id = "assistant-1", text = longText()) {
  return {
    type: "message",
    id,
    parentId: "user-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

function harness({ mode = "tui", source = sourceEntry(), childState, configureChild } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();
  const entries = [];
  const notices = [];
  const statuses = [];
  const starts = [];
  const children = [];
  const removedDirs = [];
  let sessionId = "parent-1";
  let branch = [source];
  let leafId = source.id;
  let tempSerial = 0;
  let sendMessages = 0;

  const ctx = {
    mode,
    hasUI: mode === "tui",
    ui: {
      setStatus(name, value) { statuses.push({ name, value }); },
      notify(message, level) { notices.push({ message, level }); },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => branch,
    },
  };

  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerEntryRenderer(name, renderer) { renderers.set(name, renderer); },
    appendEntry(customType, data) {
      entries.push({ customType, data });
      leafId = `present-${entries.length}`;
    },
    sendMessage() { sendMessages += 1; },
  };

  const controller = registerPresent(pi, {
    async startRpc(options) {
      starts.push(options);
      const child = new FakeRpcChild(childState);
      configureChild?.(child);
      children.push(child);
      return child;
    },
    resolveInvocation: () => ({ command: "node", args: ["/pi/cli.js"] }),
    makeTempDir: () => `/private/tmp/pi-present-test-${++tempSerial}`,
    removeTempDir: (path) => removedDirs.push(path),
  });

  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  return {
    ctx,
    controller,
    commands,
    renderers,
    entries,
    notices,
    statuses,
    starts,
    children,
    removedDirs,
    emit,
    setMode(value) { ctx.mode = value; ctx.hasUI = value === "tui"; },
    setSource(entry) { source = entry; branch = [entry]; leafId = entry.id; },
    setLeaf(value) { leafId = value; },
    setSession(value) { sessionId = value; },
    sendMessageCount: () => sendMessages,
  };
}

async function enable(h) {
  await h.emit("session_start", { reason: "startup" });
  await h.commands.get("present").handler("on", h.ctx);
  assert.equal(h.controller.isEnabled(), true);
}

async function waitForPrompt(h, index = 0) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (h.children[index]?.promptMessage !== undefined) return h.children[index];
    await flush();
  }
  throw new Error(`present child ${index} did not receive a prompt`);
}

test("present CLI is an ephemeral fixed-model no-resource RPC child", () => {
  const args = buildPresentCliArgs({ command: "node", args: ["/pi/cli.js"] });
  assert.deepEqual(args.slice(0, 1), ["/pi/cli.js"]);
  for (const flag of [
    "--mode", "--no-session", "--no-approve", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-tools",
    "--model", "--system-prompt",
  ]) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.equal(args[args.indexOf("--mode") + 1], "rpc");
  assert.equal(args[args.indexOf("--model") + 1], PRESENT_MODEL);
  assert.equal(args[args.indexOf("--system-prompt") + 1], PRESENT_SYSTEM_PROMPT);
});

test("fenced-code validation is exact and incomplete fences are ineligible", () => {
  const source = `${longText()}\n\`\`\`ts\nconst x = 1;\n\`\`\`\nDone.`;
  assert.ok(proseLength(source) >= 200);
  assert.equal(scanFencedBlocks(source).complete, true);
  assert.equal(preservesFencedBlocks(source, source.replace("Done.", "Finished.")), true);
  assert.equal(preservesFencedBlocks(source, source.replace("const x = 1", "const x = 2")), false);
  assert.equal(proseLength(`${longText()}\n\`\`\`ts\nunclosed`), 0);
});

test("literal validation preserves inline code, URLs, paths, and numbers", () => {
  const source = [
    "Use `pi --version` with v0.84.3.",
    "Read /tmp/example/pi-setup/config.json and src/index.ts.",
    "See https://example.com/docs/v2 and keep 42%.",
  ].join("\n");
  const rewrite = [
    "Keep 42% and use `pi --version` with v0.84.3.",
    "Read src/index.ts and /tmp/example/pi-setup/config.json.",
    "Documentation: https://example.com/docs/v2.",
  ].join("\n");
  assert.deepEqual(protectedLiterals(source), protectedLiterals(rewrite));
  assert.equal(preservesProtectedLiterals(source, rewrite), true);
  for (const changed of [
    rewrite.replace("`pi --version`", "`pi -V`"),
    rewrite.replace("v0.84.3", "v0.84.4"),
    rewrite.replace("/tmp/example/pi-setup/config.json", "/tmp/example/config.json"),
    rewrite.replace("https://example.com/docs/v2", "https://example.com/docs/v3"),
    rewrite.replace("42%", "43%"),
  ]) {
    assert.equal(preservesProtectedLiterals(source, changed), false);
  }
});

test("present is off by default and non-TUI or delegated modes never start a child", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.emit("agent_settled");
  assert.equal(h.starts.length, 0);

  await h.commands.get("present").handler("on", h.ctx);
  h.setMode("print");
  await h.emit("agent_settled");
  assert.equal(h.starts.length, 0);

  h.setMode("tui");
  const previous = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    await h.emit("agent_settled");
    assert.equal(h.starts.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previous;
  }
});

test("only exact /present on enables OpenAI egress", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.commands.get("present").handler("", h.ctx);
  await h.commands.get("present").handler("onn", h.ctx);
  assert.equal(h.controller.isEnabled(), false);
  await h.emit("agent_settled");
  assert.equal(h.starts.length, 0);
  assert.match(h.notices.at(-1).message, /Usage: \/present on\|off/);

  await h.commands.get("present").handler("on", h.ctx);
  assert.equal(h.controller.isEnabled(), true);
});

test("successful rewrite appends one display-only entry with usage metadata", async () => {
  const source = sourceEntry("assistant-success", `${longText()}\n\`\`\`sh\necho ok\n\`\`\``);
  const h = harness({ source });
  await enable(h);
  await h.emit("agent_settled");
  const child = await waitForPrompt(h);
  assert.equal(child.promptMessage, source.message.content[0].text);
  assert.equal(h.starts[0].cwd, "/private/tmp/pi-present-test-1");
  assert.equal(h.starts[0].env.PI_SUBAGENT_DEPTH, "1");
  child.complete(source.message.content[0].text.replace("A clear", "A simple"));
  await h.controller.waitForIdle();

  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, "present");
  assert.equal(h.entries[0].data.version, 1);
  assert.equal(h.entries[0].data.sourceMessageId, "assistant-success");
  assert.equal(h.entries[0].data.model, PRESENT_MODEL);
  assert.equal(h.entries[0].data.tokens, 321);
  assert.equal(h.entries[0].data.cost, 0.123);
  assert.equal(h.sendMessageCount(), 0);
  assert.equal(child.disposed, true);
  assert.deepEqual(h.removedDirs, ["/private/tmp/pi-present-test-1"]);
});

test("renderer preserves body line spacing and legacy text-only entries", () => {
  const h = harness();
  const renderer = h.renderers.get("present");
  const theme = {
    bg(_name, text) { return text; },
    fg(_name, text) { return text; },
  };
  const component = renderer({ data: { text: "line one\n\nline three" } }, {}, theme);
  const lines = component.render(120);
  const first = lines.findIndex((line) => line.includes("line one"));
  const third = lines.findIndex((line) => line.includes("line three"));
  assert.ok(first >= 0 && third >= 0);
  assert.equal(third - first, 2);
  assert.match(lines.join("\n"), /sent to OpenAI/);
});

test("source eligibility rejects partial, short, code-only, and oversized answers", async (t) => {
  const cases = [
    sourceEntry("error", longText()),
    sourceEntry("short", "too short"),
    sourceEntry("code", "```txt\n" + "x".repeat(300) + "\n```"),
    sourceEntry("large", "x".repeat(PRESENT_MAX_SOURCE_BYTES + 1)),
  ];
  cases[0].message.stopReason = "error";
  for (const entry of cases) {
    await t.test(entry.id, async () => {
      const h = harness({ source: entry });
      await enable(h);
      await h.emit("agent_settled");
      await flush();
      assert.equal(h.starts.length, 0);
    });
  }
});

test("wrong child model and mutated protected content fail open", async (t) => {
  await t.test("wrong model", async () => {
    const h = harness({ childState: { model: { provider: "openai-codex", id: "wrong" } } });
    await enable(h);
    await h.emit("agent_settled");
    for (let attempt = 0; attempt < 10 && h.children.length === 0; attempt++) await flush();
    await h.controller.waitForIdle();
    assert.equal(h.entries.length, 0);
    assert.equal(h.children[0].disposed, true);
  });

  await t.test("mutated fence", async () => {
    const source = sourceEntry("fenced", `${longText()}\n\`\`\`js\nconst n = 1;\n\`\`\``);
    const h = harness({ source });
    await enable(h);
    await h.emit("agent_settled");
    const child = await waitForPrompt(h);
    child.complete(source.message.content[0].text.replace("const n = 1", "const n = 2"));
    await h.controller.waitForIdle();
    assert.equal(h.entries.length, 0);
  });

  await t.test("mutated literal", async () => {
    const source = sourceEntry("literal", `${longText()} Use \`pi --version\` at /tmp/pi-setup with v0.84.3.`);
    const h = harness({ source });
    await enable(h);
    await h.emit("agent_settled");
    const child = await waitForPrompt(h);
    child.complete(source.message.content[0].text.replace("v0.84.3", "v0.84.4"));
    await h.controller.waitForIdle();
    assert.equal(h.entries.length, 0);
  });
});

test("child errors and oversized rewrites fail open and clean up", async (t) => {
  await t.test("child error", async () => {
    const h = harness();
    await enable(h);
    await h.emit("agent_settled");
    const child = await waitForPrompt(h);
    child.complete(longText(" partial"), { stopReason: "error", errorMessage: "provider failed" });
    await h.controller.waitForIdle();
    assert.equal(h.entries.length, 0);
    assert.equal(child.disposed, true);
    assert.deepEqual(h.removedDirs, ["/private/tmp/pi-present-test-1"]);
  });

  await t.test("oversized result", async () => {
    const h = harness();
    await enable(h);
    await h.emit("agent_settled");
    const child = await waitForPrompt(h);
    child.complete("x".repeat(PRESENT_MAX_RESULT_BYTES + 1));
    await h.controller.waitForIdle();
    assert.equal(h.entries.length, 0);
    assert.equal(child.disposed, true);
  });
});

test("leaf or session movement drops a completed rewrite", async (t) => {
  for (const movement of ["leaf", "session"]) {
    await t.test(movement, async () => {
      const h = harness();
      await enable(h);
      await h.emit("agent_settled");
      const child = await waitForPrompt(h);
      if (movement === "leaf") h.setLeaf("another-branch-leaf");
      else h.setSession("parent-2");
      child.complete(longText(" rewritten"));
      await h.controller.waitForIdle();
      assert.equal(h.entries.length, 0);
    });
  }
});

test("new parent run, tree navigation, and toggle-off cancel active work", async (t) => {
  for (const action of ["before_agent_start", "session_before_tree", "toggle-off"]) {
    await t.test(action, async () => {
      const h = harness();
      await enable(h);
      await h.emit("agent_settled");
      const child = await waitForPrompt(h);
      if (action === "toggle-off") await h.commands.get("present").handler("off", h.ctx);
      else await h.emit(action);
      await h.controller.waitForIdle();
      assert.equal(child.disposed, true);
      assert.equal(h.entries.length, 0);
      assert.deepEqual(h.removedDirs, ["/private/tmp/pi-present-test-1"]);
    });
  }
});

test("cancellation during delayed prompt acceptance owns all rejections", async () => {
  const gate = deferred();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = harness({
      configureChild(child) {
        child.promptGate = gate.promise;
        child.disposeError = new Error("dispose failed for test");
      },
    });
    await enable(h);
    await h.emit("agent_settled");
    const child = await waitForPrompt(h);
    const cancelling = h.emit("before_agent_start");
    await flush();
    gate.resolve();
    await cancelling;
    await h.controller.waitForIdle();
    await flush();
    assert.equal(child.disposed, true);
    assert.equal(h.entries.length, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("latest eligible answer cancels stale work and only the latest may append", async () => {
  const h = harness();
  await enable(h);
  await h.emit("agent_settled");
  const first = await waitForPrompt(h, 0);

  const secondSource = sourceEntry("assistant-2", longText(" newest"));
  h.setSource(secondSource);
  await h.emit("agent_settled");
  const second = await waitForPrompt(h, 1);
  assert.equal(first.disposed, true);
  first.complete(longText(" stale late result"));
  second.complete(secondSource.message.content[0].text.replace("A clear", "A concise"));
  await h.controller.waitForIdle();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.sourceMessageId, "assistant-2");
});

test("session shutdown resets opt-in and tears down the private child", async () => {
  const h = harness();
  await enable(h);
  await h.emit("agent_settled");
  const child = await waitForPrompt(h);
  await h.emit("session_shutdown");
  await h.controller.waitForIdle();
  assert.equal(child.disposed, true);
  assert.equal(h.controller.isEnabled(), false);
  assert.equal(h.entries.length, 0);
});
