import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previous = process.env.PI_FAST_MODE;
process.env.PI_FAST_MODE = "1";
const { default: fastMode } = await import(`../extensions/fast-mode.ts?test=${Date.now()}`);
if (previous === undefined) delete process.env.PI_FAST_MODE;
else process.env.PI_FAST_MODE = previous;

function harness() {
  const handlers = new Map();
  const commands = new Map();
  fastMode({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });
  const statuses = [];
  const notices = [];
  const ctx = {
    model: { provider: "anthropic", id: "claude-opus-5" },
    ui: {
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      notify(message, type) {
        notices.push({ message, type });
      },
    },
  };
  return { commands, ctx, handlers, notices, statuses };
}

test("fast mode contributes only its body field and beta", async () => {
  const h = harness();
  h.handlers.get("session_start")({}, h.ctx);
  assert.deepEqual(h.statuses.at(-1), { key: "fast-mode", value: "⚡ fast" });

  const payload = { model: "claude-opus-5", messages: [] };
  const transformed = h.handlers.get("before_provider_request")({ payload }, h.ctx);
  assert.deepEqual(transformed, { ...payload, speed: "fast" });

  const headers = { "anthropic-beta": "interleaved-thinking-2025-05-14" };
  h.handlers.get("before_provider_headers")({ headers }, h.ctx);
  assert.deepEqual(new Set(headers["anthropic-beta"].split(",")), new Set([
    "interleaved-thinking-2025-05-14",
    "fast-mode-2026-02-01",
  ]));

  await h.commands.get("fast").handler("off", h.ctx);
  assert.equal(h.handlers.get("before_provider_request")({ payload }, h.ctx), undefined);
  assert.match(h.notices.at(-1).message, /back to standard speed/);

  const source = readFileSync(new URL("../extensions/fast-mode.ts", import.meta.url), "utf8");
  assert.equal(source.includes("FINE_GRAINED_BETA"), false);
  assert.equal(source.includes("OAUTH_BETAS"), false);
  assert.equal(source.includes("getApiKeyForProvider"), false);
});
