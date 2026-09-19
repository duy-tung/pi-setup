import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import fastMode from "../extensions/fast-mode.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const responses = { provider: "openai", api: "openai-responses", id: "gpt-6-astra" };
const completions = { provider: "openai", api: "openai-completions", id: "gpt-4o" };
const anthropic = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5-1" };

function harness(model = codex, envValue) {
  const handlers = new Map();
  const commands = new Map();
  const previous = process.env.PI_FAST_MODE;
  try {
    if (envValue === undefined) delete process.env.PI_FAST_MODE;
    else process.env.PI_FAST_MODE = envValue;
    fastMode({
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, command) { commands.set(name, command); },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FAST_MODE;
    else process.env.PI_FAST_MODE = previous;
  }
  const statuses = [];
  const notices = [];
  const ctx = {
    model,
    ui: {
      setStatus(key, value) { statuses.push({ key, value }); },
      notify(message, type) { notices.push({ message, type }); },
    },
  };
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const command = args => commands.get("fast").handler(args, ctx);
  emit("session_start");
  return { command, ctx, emit, handlers, notices, statuses };
}

for (const model of [codex, responses, completions]) {
  test(`${model.provider}/${model.api}: /fast on adds priority without changing model or thinking`, async () => {
    const h = harness(model);
    const payload = Object.freeze({ model: model.id, input: [], reasoning: { effort: "high" }, service_tier: "flex" });
    assert.equal(h.emit("before_provider_request", { payload }), undefined);
    await h.command("on");
    assert.deepEqual(h.emit("before_provider_request", { payload }), { ...payload, service_tier: "priority" });
    assert.equal(payload.service_tier, "flex", "Do not mutate the upstream payload");
    assert.deepEqual(h.statuses.at(-1), { key: "fast-mode", value: "⚡ fast requested" });
    assert.match(h.notices.at(-1).message, /extra cost\/credit usage/);
    assert.equal(h.handlers.has("before_provider_headers"), false, "No Anthropic beta/header injection");
    await h.command("off");
    assert.equal(h.emit("before_provider_request", { payload }), undefined);
    assert.equal(h.statuses.at(-1).value, undefined);
    assert.match(h.notices.at(-1).message, /provider defaults apply/);
  });
}

test("fast is inactive on Anthropic, proxies, unknown APIs, and no model", async () => {
  for (const model of [
    anthropic,
    { ...anthropic, id: "claude-opus-5" },
    { ...responses, provider: "openrouter" },
    { ...responses, provider: "azure-openai-responses" },
    { ...codex, api: "anthropic-messages" },
    { ...responses, api: "unknown" },
    undefined,
  ]) {
    const h = harness();
    h.ctx.model = model;
    await h.command("on");
    const payload = Object.freeze({ model: model?.id, messages: [] });
    assert.equal(h.emit("before_provider_request", { payload }), undefined);
    assert.equal(h.statuses.at(-1).value, undefined, "Unsupported providers must not display the fast badge");
    assert.match(h.notices.at(-1).message, /inactive/);
  }
});

test("switching providers refreshes status and leaves unsupported payloads unchanged", async () => {
  const h = harness();
  await h.command("on");
  h.ctx.model = anthropic;
  h.emit("model_select", { model: anthropic });
  assert.equal(h.statuses.at(-1).value, undefined);
  assert.equal(h.emit("before_provider_request", { payload: { model: anthropic.id } }), undefined);
  await h.command("status");
  assert.match(h.notices.at(-1).message, /inactive/);
  h.ctx.model = codex;
  h.emit("model_select", { model: codex });
  assert.equal(h.statuses.at(-1).value, "⚡ fast requested");
  assert.equal(h.emit("before_provider_request", { payload: { model: codex.id } }).service_tier, "priority");
});

test("status and invalid arguments do not toggle; empty argument toggles", async () => {
  const h = harness();
  await h.command("status");
  assert.match(h.notices.at(-1).message, /fast mode off/);
  await h.command("oops");
  assert.match(h.notices.at(-1).message, /Usage:/);
  assert.equal(h.emit("before_provider_request", { payload: {} }), undefined);
  await h.command("");
  await h.command("status");
  assert.equal(h.emit("before_provider_request", { payload: {} }).service_tier, "priority");
  await h.command("oops");
  assert.equal(h.emit("before_provider_request", { payload: {} }).service_tier, "priority");
  await h.command(" ON ");
  assert.equal(h.emit("before_provider_request", { payload: {} }).service_tier, "priority");
  await h.command("");
  assert.equal(h.emit("before_provider_request", { payload: {} }), undefined);
});

test("per-instance state resets at session start; explicit env opt-in is respected", async () => {
  const a = harness();
  await a.command("on");
  const b = harness();
  assert.equal(b.emit("before_provider_request", { payload: {} }), undefined);
  a.emit("session_shutdown");
  assert.equal(a.statuses.at(-1).value, undefined);
  a.emit("session_start", { reason: "reload" });
  assert.equal(a.emit("before_provider_request", { payload: {} }), undefined);
  const optedIn = harness(codex, "1");
  assert.equal(optedIn.emit("before_provider_request", { payload: {} }).service_tier, "priority");
  assert.equal(harness(codex, "0").emit("before_provider_request", { payload: {} }), undefined);
});

// Exercise the installed serializers with injected fetch: no credentials/network/model calls.
for (const provider of ["openai", "openai-codex"]) {
  test(`${provider}: actual serialized requests carry priority only while enabled`, async () => {
    const piRoot = resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
    const ai = join(piRoot, "node_modules/@earendil-works/pi-ai/dist");
    const { getModel } = await import(pathToFileURL(join(ai, "compat.js")).href);
    const model = getModel(provider, "gpt-6-astra");
    assert.ok(model, "Installed Pi catalogue must contain the target model");
    const { stream } = await import(pathToFileURL(join(ai, "api", model.api + ".js")).href);
    const h = harness(model);
    const requests = [];
    const fixtureKey = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
      chatgpt_account_id: "fixture-account",
    } })).toString("base64url") + ".signature";
    for (const enabled of [true, false]) {
      await h.command(enabled ? "on" : "off");
      const result = await stream(model, {
        systemPrompt: "Fixture",
        messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
      }, {
        apiKey: fixtureKey, transport: "sse", maxRetries: 0, reasoningEffort: "high",
        onPayload: payload => h.emit("before_provider_request", { payload }),
        fetch: async (_url, options) => {
          const headers = new Headers(options.headers);
          const body = headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(options.body).toString() : options.body;
          requests.push(JSON.parse(body));
          assert.equal(headers.has("anthropic-beta"), false);
          return new Response('data: ' + JSON.stringify({ type: "response.completed", response: {
            id: "resp_fixture", status: "completed", service_tier: enabled ? "priority" : "default",
            output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
        },
      }).result();
      assert.notEqual(result.stopReason, "error", result.errorMessage);
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].service_tier, "priority");
    assert.equal(requests[1].service_tier, undefined);
    for (const payload of requests) {
      assert.equal(payload.model, model.id);
      assert.equal(payload.reasoning.effort, "high");
      assert.equal(payload.speed, undefined);
    }
  });
}

test("malformed payloads are left untouched", () => {
  const h = harness(codex, "1");
  for (const payload of [undefined, null, false, "payload", [], 1]) {
    assert.equal(h.emit("before_provider_request", { payload }), undefined);
  }
});
