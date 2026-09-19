import assert from "node:assert/strict";
import test from "node:test";
import { parseUsage, usageRequest, contextWindowLabel, selectedModelLabel } from "../extensions/lib/statusline-usage.ts";

const codexToken = (account) => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url");
  return `header.${claims}.signature`;
};

test("Codex window duration comes from the response, including weekly-only plans", () => {
  const reading = parseUsage("openai-codex", { rate_limit: {
    primary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 2000000000 },
    secondary_window: null,
  } }, "gpt-6-astra");
  assert.equal(reading.windows.length, 1);
  assert.equal(reading.windows[0].label, "7d");
  assert.equal(reading.windows[0].resetsAt, 2000000000000);
  const unusual = parseUsage("openai-codex", { rate_limit: {
    primary_window: { used_percent: 2, limit_window_seconds: 900, reset_after_seconds: 120 },
    secondary_window: { used_percent: null },
  } }, "gpt-6-astra", 1000);
  assert.deepEqual(unusual.windows, [{ label: "15m", pct: 2, resetsAt: 121000, scoped: false }]);
});

test("missing or malformed percentages are unknown, not a fabricated zero quota", () => {
  for (const provider of ["anthropic", "openai-codex"]) {
    assert.throws(() => parseUsage(provider, {}, "fixture"), /no usable/);
    assert.throws(() => parseUsage(provider, null, "fixture"), /no usable/);
  }
  assert.throws(() => parseUsage("openai-codex", { rate_limit: { primary_window: { used_percent: "42" } } }, "fixture"), /no usable/);
});

test("Anthropic's short Fable quota name matches Fable 5.1 and stays visible even when equal to weekly usage", () => {
  const data = {
    five_hour: { utilization: 2 }, seven_day: { utilization: 22 },
    limits: [{ kind: "weekly_scoped", percent: 4, resets_at: "2026-09-09T05:59:59Z",
      scope: { model: { id: null, display_name: "Fable" }, surface: null } }],
  };
  let result = parseUsage("anthropic", data, "claude-fable-5-1");
  assert.deepEqual(result.windows.at(-1), { label: "fable", pct: 4,
    resetsAt: Date.parse("2026-09-09T05:59:59Z"), scoped: true });
  assert.equal(parseUsage("anthropic", data, "claude-opus-5").windows.length, 2);
  data.limits[0].percent = 22;
  result = parseUsage("anthropic", data, "claude-fable-5-1");
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows.at(-1).pct, 22);
});

test("model-specific Codex buckets do not leak across unrelated models", () => {
  const data = {
    rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 604800 } },
    additional_rate_limits: [
      { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000 } } },
    ],
  };
  assert.equal(parseUsage("openai-codex", data, "gpt-6-astra").windows.length, 1);
  assert.equal(parseUsage("openai-codex", data, "gpt-5.3-codex-spark").windows.length, 2);
});

test("context and model labels retain actual capacities and GPT version order", () => {
  assert.equal(contextWindowLabel(272000), "272K");
  assert.equal(contextWindowLabel(1000000), "1M");
  assert.equal(contextWindowLabel(128000), "128K");
  assert.equal(contextWindowLabel(undefined), "");
  assert.equal(selectedModelLabel({ id: "gpt-6-astra" }), "GPT-6 Astra");
  assert.equal(selectedModelLabel({ id: "claude-fable-5-1" }), "Fable 5.1");
});

test("the Anthropic quota poll carries the client fingerprint that endpoint gates on", () => {
  const request = usageRequest("anthropic", "sk-ant-oat01-fixture");
  assert.equal(request.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(request.headers["anthropic-beta"], "oauth-2025-04-20");
  // Any other agent prefix lands in the exhausted bucket and 429s regardless of backoff.
  assert.match(request.headers["user-agent"], /^claude-code\/\d+\.\d+\.\d+$/);
  // The Codex poll must not borrow it.
  const codex = usageRequest("openai-codex", codexToken("acct-1"));
  assert.equal(codex.headers["user-agent"], undefined);
});

test("only supported subscription credentials can select a quota endpoint", () => {
  assert.throws(() => usageRequest("openai", "api-key"), /no supported/);
  assert.throws(() => usageRequest("anthropic", "api-key"), /API-key/);
  assert.throws(() => usageRequest("openai-codex", "bad-token"), /account claim/);
});
