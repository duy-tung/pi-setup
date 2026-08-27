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

const { default: askUserExtension } = await import(`../extensions/ask-user.ts?scroll-test=${Date.now()}`);
const { getKeybindings } = await import("@earendil-works/pi-tui");
const keybindings = getKeybindings();

const theme = {
  fg(_color, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

function withTerminalRows(rows, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
  return Promise.resolve(operation()).finally(() => {
    if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
    else delete process.stdout.rows;
  });
}

function harness(drivers) {
  const tools = new Map();
  const dialogOptions = [];
  let driverIndex = 0;
  const tui = { requestRender() {} };
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  askUserExtension(pi);

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      async custom(factory, options) {
        dialogOptions.push(options);
        const driver = drivers[driverIndex++];
        assert.ok(driver, `missing custom-dialog driver ${driverIndex}`);
        return new Promise((resolvePromise, rejectPromise) => {
          let component;
          const done = (value) => {
            component?.dispose?.();
            resolvePromise(value);
          };
          Promise.resolve(factory(tui, theme, keybindings, done)).then((created) => {
            component = created;
            try {
              driver(component);
            } catch (error) {
              component.dispose?.();
              rejectPromise(error);
            }
          }, rejectPromise);
        });
      },
      async select() {
        throw new Error("TUI ask_user must use the bounded custom selector");
      },
      async input() {
        throw new Error("TUI ask_user must use the bounded custom input");
      },
    },
  };

  return { ctx, dialogOptions, tool: tools.get("ask_user") };
}

function longQuestion() {
  return [
    ...Array.from({ length: 50 }, (_, index) => `context line ${index + 1}`),
    "FINAL QUESTION?",
  ].join("\n");
}

test("long choice question starts at its tail and keeps choices visible while paging", async () => {
  await withTerminalRows(24, async () => {
    const question = longQuestion();
    const h = harness([
      (component) => {
        const initialLines = component.render(48);
        const initial = initialLines.join("\n");
        assert.ok(initialLines.length <= 24, `dialog exceeded its row budget: ${initialLines.length}`);
        assert.match(initial, /FINAL QUESTION\?/);
        assert.match(initial, /Option A/);
        assert.doesNotMatch(initial, /context line 1(?:\D|$)/);

        component.handleInput("\x1b[5~"); // PageUp scrolls question text, not the choices.
        const earlier = component.render(48).join("\n");
        assert.match(earlier, /context line 3[0-9]/);
        assert.doesNotMatch(earlier, /FINAL QUESTION\?/);
        assert.match(earlier, /Option A/);

        component.handleInput("\r");
      },
    ]);

    const result = await h.tool.execute(
      "ask-long-choice",
      {
        questions: [{
          id: "choice",
          header: "Decision",
          question,
          options: [
            { label: "Option A", description: "first option" },
            { label: "Option B", description: "second option" },
          ],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "choice", selected: ["Option A"] }]);
    assert.equal(h.dialogOptions[0].overlay, true);
    assert.equal(h.dialogOptions[0].overlayOptions.maxHeight, undefined);
  });
});

test("selected option descriptions remain readable when compact rows truncate them", async () => {
  await withTerminalRows(12, async () => {
    const description = "This tradeoff description is deliberately longer than a narrow selector row and ends with END-OF-TRADEOFF.";
    const h = harness([
      (component) => {
        const rendered = component.render(24).join("\n");
        assert.match(rendered, /Choose carefully\?/);
        assert.match(rendered, /END-OF-TRADEOFF/);
        component.handleInput("\r");
      },
    ]);

    const result = await h.tool.execute(
      "ask-option-detail",
      {
        questions: [{
          id: "detail",
          question: "Choose carefully?",
          options: [
            { label: "Option A", description },
            { label: "Option B", description: "short alternative" },
          ],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "detail", selected: ["Option A"] }]);
  });
});

test("tiny terminal keeps the question tail and choices operable", async () => {
  await withTerminalRows(6, async () => {
    const h = harness([
      (component) => {
        const lines = component.render(30);
        const rendered = lines.join("\n");
        assert.ok(lines.length <= 6, `tiny dialog exceeded terminal rows: ${lines.length}`);
        assert.match(rendered, /FINAL QUESTION\?/);
        assert.match(rendered, /Option A/);
        component.handleInput("\r");
      },
    ]);

    const result = await h.tool.execute(
      "ask-tiny",
      {
        questions: [{
          id: "tiny",
          question: longQuestion(),
          options: [{ label: "Option A" }, { label: "Option B" }],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "tiny", selected: ["Option A"] }]);
    assert.equal(h.dialogOptions[0].overlayOptions.maxHeight, undefined);
  });
});

test("open dialog adapts when the terminal shrinks and grows", async () => {
  await withTerminalRows(24, async () => {
    const h = harness([
      (component) => {
        const initial = component.render(48);
        assert.ok(initial.length > 6);
        assert.match(initial.join("\n"), /FINAL QUESTION\?/);

        Object.defineProperty(process.stdout, "rows", { configurable: true, value: 6 });
        const shrunk = component.render(30);
        assert.ok(shrunk.length <= 6, `shrunk dialog exceeded terminal rows: ${shrunk.length}`);
        assert.match(shrunk.join("\n"), /FINAL QUESTION\?/);
        assert.match(shrunk.join("\n"), /Option A/);

        Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
        const grown = component.render(48);
        assert.ok(grown.length > 6);
        assert.match(grown.join("\n"), /PgUp\/PgDn scroll/);
        component.handleInput("\r");
      },
    ]);

    const result = await h.tool.execute(
      "ask-resize",
      {
        questions: [{
          id: "resize",
          question: longQuestion(),
          options: [{ label: "Option A" }, { label: "Option B" }],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "resize", selected: ["Option A"] }]);
  });
});

test("single-select typed answer still overrides listed options", async () => {
  await withTerminalRows(24, async () => {
    const h = harness([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("typed override");
        component.handleInput("\n");
      },
    ]);

    const result = await h.tool.execute(
      "ask-typed-override",
      {
        questions: [{
          id: "typed",
          question: "Choose or type",
          options: [{ label: "Option A" }, { label: "Option B" }],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "typed", selected: [], custom: "typed override" }]);
  });
});

test("multi-select toggle loop preserves selected labels", async () => {
  await withTerminalRows(24, async () => {
    const h = harness([
      (component) => component.handleInput("\r"),
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
    ]);

    const result = await h.tool.execute(
      "ask-multi",
      {
        questions: [{
          id: "multi",
          question: "Pick several",
          multi_select: true,
          options: [
            { label: "Option A", description: "first" },
            { label: "Option B", description: "second" },
          ],
        }],
      },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "multi", selected: ["Option A"] }]);
  });
});

test("long free-text question stays visible above its input", async () => {
  await withTerminalRows(24, async () => {
    const question = longQuestion();
    const h = harness([
      (component) => {
        const initial = component.render(48).join("\n");
        assert.match(initial, /FINAL QUESTION\?/);
        assert.match(initial, /Answer · your answer/);
        component.handleInput("custom answer");
        component.handleInput("\n");
      },
    ]);

    const result = await h.tool.execute(
      "ask-long-text",
      { questions: [{ id: "text", question }] },
      undefined,
      undefined,
      h.ctx,
    );

    assert.deepEqual(result.details.answers, [{ id: "text", selected: [], custom: "custom answer" }]);
  });
});
