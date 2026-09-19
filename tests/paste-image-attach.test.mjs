import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piPackage = resolve(dirname(piCli), "../..");
const codingAgent = join(piPackage, "dist", "index.js");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(codingAgent).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { retireConsumedClipboardTags } = await import("../extensions/paste-image-attach.ts");

test("consumed clipboard tags retire without clearing reusable or concurrent mappings", () => {
  const clipboard = join(tmpdir(), "pi-clipboard-old.png");
  const reusable = join(tmpdir(), "dragged-image.png");
  const concurrent = join(tmpdir(), "pi-clipboard-new.png");
  const pending = new Map([[1, clipboard], [2, reusable], [3, concurrent]]);

  retireConsumedClipboardTags(pending, [
    { path: clipboard, isTag: true, tagNumber: 1 },
    { path: reusable, isTag: true, tagNumber: 2 },
    // A session replacement can reuse a number while an old resize finishes.
    { path: clipboard, isTag: true, tagNumber: 3 },
  ]);

  assert.equal(pending.has(1), false);
  assert.equal(pending.get(2), reusable, "non-clipboard files remain reusable");
  assert.equal(pending.get(3), concurrent, "a newer mapping with the same tag number survives");
});

test("session_start always installs the editor component: Pi resets it before /new, /resume, /fork and /reload", async () => {
  const { default: install } = await import("../extensions/paste-image-attach.ts");
  const handlers = new Map();
  install({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool() {}, events: { on() { return () => {}; } } });
  let installed = 0, current;
  const ctx = { mode: "tui", ui: { setEditorComponent: factory => { installed++; current = factory; }, getEditorComponent: () => current, notify() {} } };
  handlers.get("session_start")({}, ctx);
  // Stock Pi calls setCustomEditorComponent(undefined) in resetExtensionUI before the next session_start.
  current = undefined;
  handlers.get("session_start")({}, ctx);
  assert.equal(installed, 2);
  handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
  assert.equal(installed, 2, "non-TUI modes never install an editor");
});
