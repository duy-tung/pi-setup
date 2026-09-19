import assert from "node:assert/strict";
import test from "node:test";
import { convertPiMessagesToAnthropic } from "../.test-dist/src/convert.js";
import { makeDefaultHeaders, prepareAnthropicRequest, streamAnthropicOAuth } from "../.test-dist/src/stream.js";

const model = (overrides = {}) => ({
  id: "claude-fable-5-1", name: "Claude Fable 5.1", api: "anthropic-messages",
  provider: "anthropic", baseUrl: "https://api.anthropic.com", reasoning: true,
  input: ["text"], contextWindow: 200_000, maxTokens: 65_536,
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
  ...overrides,
});
const user = (text = "Review this synthetic plan.") => ({
  role: "user", content: [{ type: "text", text }], timestamp: 0,
});
const context = { systemPrompt: "Synthetic test", messages: [user()] };
const effortMessage = (effort) => ({ role: "system", content: [], output_config: { effort } });

test("managed Fable medium uses native turn effort, not a thinking budget", async () => {
  const params = await prepareAnthropicRequest(model(), context, { reasoning: "medium" }, true);
  assert.deepEqual(params.thinking, {
    type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  // Pi's managed-effort protocol keeps a stable high baseline and sets the active
  // turn's actual effort in the final system-role output_config message.
  assert.deepEqual(params.output_config, { effort: "high" });
  assert.deepEqual(params.messages.at(-1), effortMessage("medium"));
  assert.equal("budget_tokens" in params.thinking, false);
});

test("managed effort honors supported level mappings and defaults to high", async () => {
  for (const [reasoning, expected] of [["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"], [undefined, "high"]]) {
    const params = await prepareAnthropicRequest(model(), context, { reasoning }, true);
    assert.deepEqual(params.messages.at(-1), effortMessage(expected));
  }
});

test("ordinary adaptive models set native request effort without managed messages", async () => {
  const params = await prepareAnthropicRequest(model({ compat: { forceAdaptiveThinking: true } }), context,
    { reasoning: "medium", thinkingBudgets: { medium: 1 } }, true);
  assert.deepEqual(params.thinking, { type: "adaptive" });
  assert.deepEqual(params.output_config, { effort: "medium" });
  assert.equal(params.messages.some(m => m.role === "system"), false);
});

test("legacy models retain budget-based thinking and no native effort", async () => {
  const params = await prepareAnthropicRequest(model({ compat: {} }), context,
    { reasoning: "medium", maxTokens: 16_384 }, true);
  assert.deepEqual(params.thinking, { type: "enabled", budget_tokens: 10_240 });
  assert.equal(params.output_config, undefined);
  assert.equal(params.messages.some(m => m.role === "system"), false);
  const plain = await prepareAnthropicRequest(model({ reasoning: false, compat: {} }), context, { reasoning: "medium" }, true);
  assert.equal(plain.thinking, undefined);
});

test("managed conversion preserves historical effort and the user cache breakpoint", () => {
  const assistant = {
    role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5-1",
    providerThinkingLevel: "high", content: [{ type: "text", text: "Earlier review" }], stopReason: "stop", timestamp: 1,
  };
  const messages = convertPiMessagesToAnthropic([user(), assistant, user("Review the revision.")], true, model(), "medium");
  assert.deepEqual(messages.map(m => m.role), ["user", "system", "assistant", "user", "system"]);
  assert.deepEqual(messages[1], effortMessage("high"));
  assert.ok(messages.at(-2).content.at(-1).cache_control);
  assert.deepEqual(messages.at(-1), effortMessage("medium"));
  for (const override of [{ provider: "openai-codex" }, { providerThinkingLevel: "invalid" }, { stopReason: "error" }]) {
    const converted = convertPiMessagesToAnthropic([user(), { ...assistant, ...override }, user()], true, model(), "medium");
    assert.deepEqual(converted.filter(m => m.role === "system"), [effortMessage("medium")]);
  }
});

test("managed effort adds required betas without re-enabling fine-grained streaming", () => {
  const ordinary = makeDefaultHeaders(true)["anthropic-beta"];
  const managed = makeDefaultHeaders(true, {
    headers: { "anthropic-beta": "caller-beta,fine-grained-tool-streaming-2025-05-14" },
  }, false, true)["anthropic-beta"].split(",");
  for (const beta of ["mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01"]) {
    assert.ok(managed.includes(beta));
    assert.equal(ordinary.includes(beta), false);
  }
  assert.ok(managed.includes("caller-beta"));
  assert.equal(managed.includes("fine-grained-tool-streaming-2025-05-14"), false);
});

test("managed effort reaches the wire and is recorded for future replay", async () => {
  let body, headers;
  const response = await streamAnthropicOAuth(model(), context, {
    apiKey: "sk-ant-oat-test", reasoning: "medium",
    onPayload(params) {
      assert.deepEqual(params.messages.at(-1), effortMessage("medium"));
      return { ...params, speed: "fast" };
    },
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      body = JSON.parse(await request.clone().text());
      headers = request.headers;
      const events = [
        { type: "message_start", message: { id: "msg_medium", type: "message", role: "assistant", model: "claude-fable-5-1", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic review" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
  }).result();
  assert.equal(response.stopReason, "stop");
  assert.equal(response.providerThinkingLevel, "medium");
  assert.equal(body.speed, "fast");
  assert.deepEqual(body.messages.at(-1), effortMessage("medium"));
  assert.match(headers.get("anthropic-beta"), /mid-conversation-output-config-2026-07-01/);
});
