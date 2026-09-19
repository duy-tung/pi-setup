import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

const piRoot = resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
// compat has an import-only export; mirror Pi's ESM extension loader, not CJS require.resolve.
const compat = pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "@earendil-works/pi-ai/compat"
    ? { url: compat, shortCircuit: true } : next(specifier, context);
} });
const packageDir = process.env.PI_WEB_SEARCH_DIR ?? join(homedir(), ".pi/agent/npm/node_modules/pi-web-search");
// Native Node strips TS outside node_modules; copy the actual installed bytes unchanged.
const fixture = mkdtempSync(join(tmpdir(), "pi-web-search-api-"));
cpSync(packageDir, fixture, { recursive: true });
after(() => rmSync(fixture, { recursive: true, force: true }));
const { callApiStream } = await import(pathToFileURL(join(fixture, "src/api.ts")).href);
const { getModel } = await import(compat);
const prompt = { contents: [{ role: "user", parts: [{ text: "Pi release fixture" }] }] };
const source = { title: "Pi", url: "https://pi.dev/" };
const response = events => new Response(events.map(e => "data: " + JSON.stringify(e) + "\n\n").join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const finish = reason => [{ type: "message_delta", delta: { stop_reason: reason } }, { type: "message_stop" }];
const anthropicModel = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5-1",
  baseUrl: "https://api.anthropic.com", maxTokens: 128000 };
const anthropicCtx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat-fixture" }) } };
const successfulSearch = () => [
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "search", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"Pi release"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "search",
    caller: { type: "code_execution_20260120", tool_id: "code" }, content: [{ type: "web_search_result", ...source, encrypted_content: "opaque-result" }] } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Search fixture" } },
  { type: "content_block_stop", index: 2 },
  ...finish("end_turn"),
];

for (const oauth of [true, false]) {
  test("Anthropic search preserves " + (oauth ? "OAuth identity" : "API-key behavior") + " and parses native results", async () => {
    const originalFetch = globalThis.fetch;
    let request;
    const token = oauth ? "sk-ant-oat-fixture" : "fixture-api-key";
    globalThis.fetch = async (url, options) => {
      request = { url, headers: new Headers(options.headers), body: JSON.parse(options.body) };
      return response([
        { type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search", id: "search", input: { query: "Pi release" } } },
        { type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "search", content: [{ type: "web_search_result", ...source }] } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Search fixture" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]);
    };
    try {
      const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5-1", baseUrl: "https://api.anthropic.com", maxTokens: 128000 };
      const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) } };
      const result = await callApiStream(ctx, model, prompt);
      assert.equal(request.url, "https://api.anthropic.com/v1/messages");
      assert.equal(request.body.model, model.id);
      assert.equal(request.body.tools[0].type, "web_search_20260318");
      assert.equal(request.body.tools[0].response_inclusion, "full");
      assert.equal(request.body.tools[0].allowed_callers, undefined, "dynamic filtering is the default");
      if (oauth) {
        assert.equal(request.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
        assert.equal(request.headers.get("authorization"), "Bearer " + token);
        assert.equal(request.headers.has("x-api-key"), false);
        assert.equal(request.headers.get("user-agent"), "claude-cli/2.1.261");
      } else {
        assert.equal(request.body.system, undefined);
        assert.equal(request.headers.get("x-api-key"), token);
      }
      assert.match(result.text, /Search fixture/);
      assert.equal(result.nativeSearchUsed, true);
      assert.equal(result.sources[0].url, source.url);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("Codex search uses the selected Astra model and account with native search", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  const token = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
    chatgpt_account_id: "fixture-account",
  } })).toString("base64url") + ".signature";
  globalThis.fetch = async (url, options) => {
    request = { url, headers: new Headers(options.headers), body: JSON.parse(options.body) };
    return response([
      { type: "response.output_text.delta", delta: "Search fixture" },
      { type: "response.completed", response: { output: [{
        id: "search", type: "web_search_call", status: "completed",
        action: { type: "search", query: "Pi release", sources: [source] },
      }] } },
    ]);
  };
  try {
    const model = getModel("openai-codex", "gpt-6-astra");
    const ctx = { thinkingLevel: "high", modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) } };
    const result = await callApiStream(ctx, model, prompt);
    assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(request.body.model, "gpt-6-astra");
    assert.equal(request.body.reasoning.effort, "high");
    assert.equal(request.body.tools[0].type, "web_search");
    assert.equal(request.body.tool_choice, "required");
    assert.equal(request.body.store, false);
    assert.equal(request.headers.get("chatgpt-account-id"), "fixture-account");
    assert.match(result.text, /Search fixture/);
    assert.equal(result.nativeSearchUsed, true);
  } finally { globalThis.fetch = originalFetch; }
});

for (const provider of ["openai-codex", "openai"]) {
  test(`${provider} search follows current effort and model capabilities`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const token = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
      chatgpt_account_id: "fixture-account",
    } })).toString("base64url") + ".signature";
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response([{ type: "response.completed", response: { output: [] } }]);
    };
    try {
      const model = getModel(provider, "gpt-6-astra");
      assert.ok(model, "test uses the installed Pi model catalogue");
      const ctx = { thinkingLevel: "high", modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
      } };
      for (const level of ["low", "medium", "high", "xhigh", "max", "off", "minimal"]) {
        ctx.thinkingLevel = level;
        await callApiStream(ctx, model, prompt);
        const expected = ["off", "minimal"].includes(level) ? "low" : level;
        assert.equal(requests.at(-1).reasoning.effort, expected, level);
        assert.equal(requests.at(-1).model, model.id);
      }
      // A model switch must use the new model's map, not cached Astra capabilities.
      ctx.thinkingLevel = "max";
      await callApiStream(ctx, { ...model, thinkingLevelMap: { xhigh: null, max: null } }, prompt);
      assert.equal(requests.at(-1).reasoning.effort, "high");
      ctx.thinkingLevel = "off";
      await callApiStream(ctx, { ...model, thinkingLevelMap: { off: "none" } }, prompt);
      assert.equal(requests.at(-1).reasoning.effort, "none");
      ctx.thinkingLevel = "high";
      await callApiStream(ctx, { ...model, reasoning: false }, prompt);
      assert.equal(requests.at(-1).reasoning, undefined);
      delete ctx.thinkingLevel;
      await callApiStream(ctx, model, prompt);
      assert.equal(requests.at(-1).reasoning, undefined, "missing context leaves the server default intact");
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("dynamic-filtering server errors trigger one disclosed direct fallback on the same tool version", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? response([
      { type: "content_block_start", index: 0, content_block: { type: "code_execution_tool_result", tool_use_id: "code",
        content: { type: "code_execution_tool_result_error", error_code: "too_many_requests" } } },
      ...finish("end_turn"),
    ]) : response(successfulSearch());
  };
  try {
    const result = await callApiStream(anthropicCtx, anthropicModel, prompt);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools[0].allowed_callers, undefined);
    assert.deepEqual(requests[1].tools[0].allowed_callers, ["direct"]);
    assert.equal(requests[1].tools[0].type, "web_search_20260318");
    assert.equal(requests[1].messages.length, 1, "fallback starts a fresh search, not a replay of rejected code");
    assert.match(result.text, /Dynamic filtering unavailable.*too_many_requests/);
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ["Pi release"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("pause_turn replays encrypted results, caller, streamed input and signatures unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const caller = { type: "code_execution_20260120", tool_id: "code" };
  const searchResult = { type: "web_search_tool_result", tool_use_id: "search", caller,
    content: [{ type: "web_search_result", ...source, encrypted_content: "opaque-encrypted-result" }] };
  const citation = { type: "web_search_result_location", ...source, encrypted_index: "opaque-index", cited_text: "Pi" };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? response([
      { type: "message_start", message: { container: { id: "fixture-container" } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "fixture thought" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", name: "code_execution", id: "code", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"code":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"print(1)"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: searchResult },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Pi" } },
      { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation } },
      { type: "content_block_stop", index: 3 },
      ...finish("pause_turn"),
    ]) : response(successfulSearch());
  };
  try {
    const result = await callApiStream(anthropicCtx, anthropicModel, prompt);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].container, "fixture-container");
    assert.deepEqual(requests[1].tools, requests[0].tools);
    assert.deepEqual(requests[1].messages[1], { role: "assistant", content: [
      { type: "thinking", thinking: "fixture thought", signature: "opaque-signature" },
      { type: "server_tool_use", name: "code_execution", id: "code", input: { code: "print(1)" } },
      searchResult,
      { type: "text", text: "Pi", citations: [citation] },
    ] });
    assert.equal(result.nativeSearchUsed, true);
    assert.ok(result.sources.length > 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("pause continuation count is bounded and incomplete responses are not reported as answers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "paused" } }, ...finish("pause_turn")]);
  };
  try {
    await assert.rejects(callApiStream(anthropicCtx, anthropicModel, prompt), /four server requests/);
    assert.equal(calls, 4);
    globalThis.fetch = async () => response([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "cut off" } }]);
    await assert.rejects(callApiStream(anthropicCtx, anthropicModel, prompt), /before message_stop/);
    globalThis.fetch = async () => response(finish("max_tokens"));
    await assert.rejects(callApiStream(anthropicCtx, anthropicModel, prompt), /did not finish: max_tokens/);
  } finally { globalThis.fetch = originalFetch; }
});

test("cancellation between pause rounds prevents another paid request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "code_execution", id: "code", input: {} } }, ...finish("pause_turn")]);
  };
  try {
    await assert.rejects(callApiStream(anthropicCtx, anthropicModel, prompt, () => controller.abort(), controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("search quota errors do not trigger a mode switch, and fallback cannot claim a search that never ran", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([{ type: "content_block_start", index: 0, content_block: {
      type: "web_search_tool_result", tool_use_id: "search",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    } }, ...finish("end_turn")]);
  };
  try {
    await callApiStream(anthropicCtx, anthropicModel, prompt);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response([{ type: "content_block_start", index: 0, content_block: {
        type: "code_execution_tool_result", tool_use_id: "code",
        content: { type: "code_execution_tool_result_error", error_code: "unavailable" },
      } }, ...finish("end_turn")]);
    };
    await assert.rejects(callApiStream(anthropicCtx, anthropicModel, prompt), /Direct web search did not run/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});
