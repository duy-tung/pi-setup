import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const fromPi = createRequire(piCli);
const tui = fromPi.resolve("@earendil-works/pi-tui");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      return { url: pathToFileURL(tui).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
const codexToken = account => "header." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url") + ".signature";
const codexModel = { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 272000, reasoning: true };
const codexUsage = percent => ({
  rate_limit: { allowed: true, primary_window: { used_percent: percent, limit_window_seconds: 604800, reset_at: 2000000000 }, secondary_window: null },
});

async function loadStatuslineAt(home) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await import(`../extensions/statusline.ts?test=${Date.now()}-${Math.random()}`);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

async function loadStatusline() {
  const home = mkdtempSync(join(tmpdir(), "pi-statusline-home-"));
  return { module: await loadStatuslineAt(home), home };
}

function harness(extension, { token, entries = [], model, statuses = new Map() } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  let footer;
  let currentToken = token;
  extension({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
  });
  const footerData = {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: model ?? { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, reasoning: true },
    thinkingLevel: "xhigh",
    getContextUsage: () => ({ percent: 9 }),
    modelRegistry: { getApiKeyForProvider: async provider => typeof currentToken === "function" ? currentToken(provider) : currentToken },
    sessionManager: {
      getEntries: () => entries,
      getCwd: () => "/synthetic/repo",
    },
    ui: {
      setFooter(factory) {
        footer = factory({ requestRender() {} }, {}, footerData);
      },
      notify(...args) { notifications.push(args); },
    },
  };
  handlers.get("session_start")({}, ctx);
  return { handlers, commands, notifications, ctx, footer: () => footer, setToken(value) { currentToken = value; } };
}

test("status polls are single-flight, abortable, and carry an AbortSignal", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (_url, options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  try {
    const h = harness(module.default, { token: `sk-ant-oat01-${"a".repeat(24)}` });
    await flush();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].signal instanceof AbortSignal);

    h.handlers.get("turn_end")({}, h.ctx);
    await flush();
    assert.equal(calls.length, 1, "a second event started an overlapping request");

    h.footer().dispose();
    await flush();
    assert.equal(calls[0].signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a late response after footer disposal cannot publish stale usage", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  try {
    const h = harness(module.default, { token: `sk-ant-oat01-${"c".repeat(24)}` });
    await flush();
    h.footer().dispose();
    resolveFetch({
      ok: true,
      status: 200,
      async json() { return { five_hour: { utilization: 99 }, seven_day: { utilization: 99 }, limits: [] }; },
    });
    await flush();
    await flush();
    assert.equal(existsSync(join(home, ".pi", "agent", "cache", "statusline-usage.json")), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a changed OAuth token clears an auth backoff before throttle checks", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 401 };
    return {
      ok: true,
      status: 200,
      async json() { return { five_hour: { utilization: 1 }, seven_day: { utilization: 2 }, limits: [] }; },
    };
  };
  try {
    const h = harness(module.default, { token: `sk-ant-oat01-${"a".repeat(24)}` });
    await flush();
    await flush();
    assert.equal(calls, 1);

    h.setToken(`sk-ant-oat01-${"b".repeat(24)}`);
    h.handlers.get("turn_end")({}, h.ctx);
    await flush();
    await flush();
    assert.equal(calls, 2, "fresh token remained trapped behind the prior 401 backoff");
    h.footer().dispose();
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy Present cost remains included without a presentation token segment", async () => {
  const { module, home } = await loadStatusline();
  try {
    const entries = [
      { type: "message", message: { usage: { cost: { total: 0.1 } } } },
      { type: "custom", customType: "present", data: { cost: 0.023, tokens: 321 } },
      { type: "custom", customType: "unrelated", data: { cost: 99, tokens: 99 } },
    ];
    assert.deepEqual(module.sessionUsageFromEntries(entries), { cost: 0.123 });
    const h = harness(module.default, { entries });
    const line = h.footer().render(240)[0];
    assert.match(line, /\$0\.12/);
    assert.doesNotMatch(line, /p 321 tok/);
    h.footer().dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("switching models cancels old requests and prevents Anthropic data appearing under Codex", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const calls = [];
  const providers = [];
  globalThis.fetch = (url, options) => new Promise(resolve => { calls.push({ url, options, resolve }); });
  let h;
  try {
    h = harness(module.default, { token: provider => {
      providers.push(provider);
      return provider === "anthropic" ? "sk-ant-oat-fixture" : codexToken("fixture-account");
    } });
    await flush();
    const selected = { ...h.ctx, model: codexModel, thinkingLevel: "high", getContextUsage: () => ({ percent: 24 }) };
    h.handlers.get("model_select")({}, selected);
    await flush();
    assert.deepEqual(providers, ["anthropic", "openai-codex"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(calls[1].options.headers["chatgpt-account-id"], "fixture-account");
    assert.equal(calls[1].options.redirect, "error");
    calls[1].resolve({ ok: true, json: async () => codexUsage(55) });
    await flush(); await flush();
    let line = plain(h.footer().render(240)[0]);
    assert.match(line, /GPT-6 Astra/);
    assert.match(line, /272K/);
    assert.match(line, /24%/);
    assert.match(line, /7d 55%/);
    // A reset duration such as 15h is not a displayed 5h quota bucket.
    assert.doesNotMatch(line, /Anthropic|Codex|1M|\b5h\s+\d+%|fable/);
    calls[0].resolve({ ok: true, json: async () => ({ five_hour: { utilization: 99 }, seven_day: { utilization: 99 } }) });
    await flush(); await flush();
    line = plain(h.footer().render(240)[0]);
    assert.doesNotMatch(line, /99%/);

    // RPC child lifecycle events must not replace the parent's quota or model.
    h.handlers.get("model_select")({}, { ...h.ctx, mode: "rpc" });
    h.handlers.get("turn_end")({}, { ...h.ctx, mode: "rpc" });
    assert.match(plain(h.footer().render(240)[0]), /GPT-6 Astra/);

    const api = { ...selected, model: { ...codexModel, provider: "openai" } };
    h.handlers.get("model_select")({}, api);
    await flush();
    assert.equal(calls.length, 2, "API-key provider must not request someone else's subscription limits");
    line = plain(h.footer().render(240)[0]);
    assert.match(line, /limits n\/a/);
    assert.doesNotMatch(line, /OpenAI API|Anthropic|Codex/);
    assert.doesNotMatch(line, /55%|7d/);
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex account changes clear old quotas and the cache contains no token or account ID", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (calls === 2) return { ok: false, status: 401 };
    return { ok: true, json: async () => codexUsage(options.headers["chatgpt-account-id"] === "account-one" ? 75 : 20) };
  };
  let h;
  try {
    h = harness(module.default, { token: codexToken("account-one"), model: codexModel });
    await flush(); await flush();
    assert.match(plain(h.footer().render(240)[0]), /7d 75%/);
    h.setToken(codexToken("account-two"));
    h.handlers.get("turn_end")({}, h.ctx);
    await flush(); await flush();
    assert.equal(calls, 2);
    assert.doesNotMatch(plain(h.footer().render(240)[0]), /75%/);
    await h.commands.get("limits").handler("", h.ctx);
    assert.match(h.notifications.at(-1)[0], /Codex.*used: 7d 20%/);
    assert.doesNotMatch(h.notifications.at(-1)[0], /\b5h\s+\d+%|-1%/);
    const cache = readFileSync(join(home, ".pi/agent/cache/statusline-usage.json"), "utf8");
    assert.doesNotMatch(cache, /account-one|account-two|signature|Bearer/);
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("same-provider model switches select only the matching Anthropic scoped bucket", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({
      five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
      limits: [
        { kind: "weekly_scoped", percent: 91, scope: { model: { id: null, display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 34, scope: { model: { display_name: "Claude Opus 5" } } },
      ],
    }) };
  };
  let h;
  try {
    h = harness(module.default, { token: "sk-ant-oat-fixture" });
    await flush(); await flush();
    assert.match(plain(h.footer().render(240)[0]), /opus 34%/);
    assert.doesNotMatch(plain(h.footer().render(240)[0]), /fable 91%/);
    const fable = { ...h.ctx, model: { ...h.ctx.model, id: "claude-fable-5-1", name: "Claude Fable 5.1" } };
    h.handlers.get("model_select")({}, fable);
    await flush(); await flush();
    assert.equal(calls, 2, "model change should not wait behind the old model's throttle");
    assert.match(plain(h.footer().render(240)[0]), /Fable 5.1.*fable 91%/);
    assert.doesNotMatch(plain(h.footer().render(240)[0]), /Anthropic|Codex/);
    assert.doesNotMatch(plain(h.footer().render(240)[0]), /opus 34%/);
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the status line re-opens grey after a themed status carries its own reset", async () => {
  const { module, home } = await loadStatusline();
  try {
    // The themed background-tasks badge ends in a reset; goal must not inherit it.
    const badge = "\x1b[48;2;30;30;46m\x1b[38;2;205;214;244m bg 1 running \x1b[0m";
    const statuses = new Map([
      ["background-tasks", badge],
      ["goal", "goal 2/10"],
      ["fast-mode", "⚡"],
    ]);
    const h = harness(module.default, { token: undefined, statuses });
    const lines = h.footer().render(120);
    assert.equal(lines.length, 2, "extension statuses render on their own second line");
    const [, second] = lines;
    assert.match(plain(second), /bg 1 running\s+goal 2\/10/);
    assert.doesNotMatch(plain(second), /⚡/, "fast-mode already has a segment on line 1");
    assert.ok(second.includes("\x1b[0m  \x1b[90m"), "each status starts from grey again");
    assert.ok(second.indexOf("\x1b[90mgoal 2/10") > second.indexOf(badge), "grey is re-applied after the badge");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refreshed Anthropic token and a model switch reuse the cached account windows", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-statusline-home-"));
  const originalFetch = globalThis.fetch;
  const fable = { provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", contextWindow: 1_000_000, reasoning: true };
  let first;
  let second;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
      limits: [{ kind: "weekly_scoped", percent: 34, scope: { model: { display_name: "Claude Opus 5" } } }],
    }) });
    first = harness((await loadStatuslineAt(home)).default, { token: `sk-ant-oat01-${"a".repeat(24)}` });
    await flush(); await flush();
    assert.match(plain(first.footer().render(240)[0]), /5h 10%.*7d 20%.*opus 34%/);
    first.footer().dispose();

    // Next session: the hourly refresh replaced the token and another model is selected,
    // so nothing about the request matches the one that filled the cache.
    let started = 0;
    globalThis.fetch = () => { started++; return new Promise(() => {}); };
    second = harness((await loadStatuslineAt(home)).default, { token: `sk-ant-oat01-${"b".repeat(24)}`, model: fable });
    await flush(); await flush();
    assert.equal(started, 1);
    const line = plain(second.footer().render(240)[0]);
    // Marked, because an hourly refresh and a different login look the same from here:
    // the numbers are worth showing while the request that settles them is in flight,
    // but not worth stating as this credential's own.
    assert.match(line, /5h\* 10%/, "account-wide windows must survive a token rotation");
    assert.match(line, /7d\* 20%/);
    assert.doesNotMatch(line, /limits n\/a/);
    assert.doesNotMatch(line, /opus 34%/, "the other model's scoped bucket must not be shown");
  } finally {
    first?.footer().dispose();
    second?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rate-limited reading waits a fixed window that the boot retry outlives", async (t) => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let h;
  try {
    // A 429 says the agent's shared bucket is empty, not that this client polled too
    // fast, so the wait stays fixed instead of climbing to the ten-minute step.
    assert.deepEqual(module.failureBackoff(429, 0), { fails: 1, wait: 180_000 });
    assert.deepEqual(module.failureBackoff(429, 3), { fails: 1, wait: 180_000 });
    assert.deepEqual(module.failureBackoff(500, 0), { fails: 1, wait: 30_000 });
    assert.deepEqual(module.failureBackoff(500, 2), { fails: 3, wait: 600_000 });
    assert.deepEqual(module.failureBackoff(401, 0), { fails: 3, wait: 600_000 });
    // Each retry is scheduled for the moment backoff and throttle both allow a request.
    assert.equal(module.bootRetryDelay(1_000, 0, 0), 3_000, "no attempt yet: keep the fast boot tick");
    assert.equal(module.bootRetryDelay(1_000, 1_000, 181_000), 180_000, "the rate-limit wait is respected");
    assert.equal(module.bootRetryDelay(1_000, 1_000, 0), 60_000, "the unforced throttle is respected");

    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429 };
      return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 4 }, seven_day: { utilization: 5 }, limits: [] }) };
    };
    h = harness(module.default, { token: `sk-ant-oat01-${"d".repeat(24)}` });
    await flush(); await flush();
    assert.equal(calls, 1);
    assert.match(plain(h.footer().render(240)[0]), /limits n\/a/);

    // The ordinary 120s poller must not cut the rate-limit wait short...
    t.mock.timers.tick(120_000);
    await flush(); await flush(); await flush();
    assert.equal(calls, 1, "a poll went out before the rate-limit wait was over");
    assert.match(plain(h.footer().render(240)[0]), /limits n\/a/);

    // ...and once it is over, the boot retry is still alive to take the reading.
    t.mock.timers.tick(60_000);
    await flush(); await flush(); await flush();
    assert.equal(calls, 2, "no retry reached the network after the rate-limit wait");
    const line = plain(h.footer().render(240)[0]);
    assert.match(line, /5h 4%/);
    assert.match(line, /7d 5%/);
  } finally {
    h?.footer().dispose();
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a reading taken under another credential is dropped when the new one cannot vouch for it", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-statusline-home-"));
  const originalFetch = globalThis.fetch;
  let first;
  let second;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      five_hour: { utilization: 71 }, seven_day: { utilization: 72 }, limits: [],
    }) });
    first = harness((await loadStatuslineAt(home)).default, { token: `sk-ant-oat01-${"a".repeat(24)}` });
    await flush(); await flush();
    assert.match(plain(first.footer().render(240)[0]), /5h 71%/);
    first.footer().dispose();

    // A different Anthropic login is indistinguishable from an hourly refresh, so the
    // cached windows may belong to someone else until a response confirms them.
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    second = harness((await loadStatuslineAt(home)).default, { token: `sk-ant-oat01-${"z".repeat(24)}` });
    await flush(); await flush();
    const line = plain(second.footer().render(240)[0]);
    assert.doesNotMatch(line, /71%|72%/, "another account's numbers survived an unverifiable credential");
    assert.match(line, /limits n\/a/);

    await second.commands.get("limits").handler("", second.ctx);
    assert.match(second.notifications.at(-1)[0], /HTTP 429/);
    assert.doesNotMatch(second.notifications.at(-1)[0], /71%|72%/);
  } finally {
    first?.footer().dispose();
    second?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a limited bucket with no usable percentage still does not follow onto another model", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const RED_FILL = "\x1b[38;5;203m";
  let h;
  try {
    // The model bucket is out of quota but reports no percentage, so it raises severity
    // without contributing a window: nothing about the reading's shape says it is scoped.
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      rate_limit: { allowed: true, primary_window: { used_percent: 12, limit_window_seconds: 604800 } },
      additional_rate_limits: [{
        limit_name: "GPT-6-Astra",
        rate_limit: { limit_reached: true, primary_window: { used_percent: null } },
      }],
    }) });
    h = harness(module.default, { token: codexToken("account-shapeless"), model: codexModel });
    await flush(); await flush();
    assert.ok(h.footer().render(240)[0].includes(RED_FILL), "this model is out of quota");

    globalThis.fetch = async () => ({ ok: false, status: 429 });
    h.handlers.get("model_select")({}, { ...h.ctx, model: { ...codexModel, id: "gpt-6-mini", name: "GPT-6 Mini" } });
    await flush(); await flush();
    const line = h.footer().render(240)[0];
    assert.match(plain(line), /7d\*? 12%/, "the account-wide window is still usable");
    assert.ok(!line.includes(RED_FILL), "another model's limit painted this model's bar");
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the credential a reading was taken under can put it back on screen", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const mine = `sk-ant-oat01-${"p".repeat(24)}`;
  let h;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      five_hour: { utilization: 71 }, seven_day: { utilization: 72 }, limits: [],
    }) });
    h = harness(module.default, { token: mine });
    await flush(); await flush();
    assert.match(plain(h.footer().render(240)[0]), /5h 71%/);

    // Another login cannot vouch for those numbers and its own refresh fails, so they go.
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    h.setToken(`sk-ant-oat01-${"q".repeat(24)}`);
    h.handlers.get("turn_end")({}, h.ctx);
    await flush(); await flush();
    assert.match(plain(h.footer().render(240)[0]), /limits n\/a/);

    // Back on the credential the cache was read under: the reading is its own again,
    // so a failing refresh costs the marker, not the quota.
    h.setToken(mine);
    h.handlers.get("turn_end")({}, h.ctx);
    await flush(); await flush();
    const line = plain(h.footer().render(240)[0]);
    assert.match(line, /5h\* 71%/);
    assert.match(line, /7d\* 72%/);
    assert.doesNotMatch(line, /limits n\/a/);
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a scoped bucket's severity does not follow the reading onto another model", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const RED_FILL = "\x1b[38;5;203m";
  let h;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      rate_limit: { allowed: true, primary_window: { used_percent: 12, limit_window_seconds: 604800 } },
      additional_rate_limits: [{
        limit_name: "GPT-6-Astra",
        rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
      }],
    }) });
    h = harness(module.default, { token: codexToken("account-severity"), model: codexModel });
    await flush(); await flush();
    assert.ok(h.footer().render(240)[0].includes(RED_FILL), "a limited model bucket should raise the bar");

    // The account-wide window is at 12%: nothing about the new model is limited.
    globalThis.fetch = () => new Promise(() => {});
    h.handlers.get("model_select")({}, { ...h.ctx, model: { ...codexModel, id: "gpt-6-mini", name: "GPT-6 Mini" } });
    await flush(); await flush();
    const line = h.footer().render(240)[0];
    assert.match(plain(line), /7d 12%/, "the account-wide window is still usable");
    assert.doesNotMatch(plain(line), /mdl/, "the other model's bucket must be dropped");
    assert.ok(!line.includes(RED_FILL), "the other model's limit still painted this model's bar");
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a boot retry scheduled before a reading landed does not fire afterwards", async (t) => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  let h;
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429 };
      return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 6 }, seven_day: { utilization: 7 }, limits: [] }) };
    };
    h = harness(module.default, { token: `sk-ant-oat01-${"e".repeat(24)}` });
    await flush(); await flush();
    assert.equal(calls, 1);

    // The boot chain re-arms itself for the end of the rate-limit wait, at 180s.
    t.mock.timers.tick(3_000);
    await flush(); await flush();
    assert.equal(calls, 1, "a retry ignored the rate-limit wait");

    // /limits then takes the reading the boot chain was still waiting for.
    await h.commands.get("limits").handler("", h.ctx);
    await flush(); await flush();
    assert.equal(calls, 2);
    assert.match(plain(h.footer().render(240)[0]), /5h 6%/);

    t.mock.timers.tick(127_000); // the ordinary 120s refresh, which is expected
    await flush(); await flush();
    assert.equal(calls, 3);

    t.mock.timers.tick(60_000); // past the retry the boot chain had armed for 180s
    await flush(); await flush(); await flush();
    assert.equal(calls, 3, "a stale boot retry spent a request the footer no longer needed");
  } finally {
    h?.footer().dispose();
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a cached reading a blocked poll cannot verify is never put on screen", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-statusline-home-"));
  const originalFetch = globalThis.fetch;
  let first;
  let second;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      five_hour: { utilization: 81 }, seven_day: { utilization: 82 }, limits: [],
    }) });
    first = harness((await loadStatuslineAt(home)).default, { token: `sk-ant-oat01-${"m".repeat(24)}` });
    await flush(); await flush();
    assert.match(plain(first.footer().render(240)[0]), /5h 81%/);
    first.footer().dispose();

    // Another login: verification fails, so the reading it could not vouch for goes.
    const other = `sk-ant-oat01-${"n".repeat(24)}`;
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    second = harness((await loadStatuslineAt(home)).default, { token: other });
    await flush(); await flush();
    assert.doesNotMatch(plain(second.footer().render(240)[0]), /81%|82%/);

    // The token momentarily disappears (a refresh in flight) and comes back. The
    // rate-limit wait is still running, so this poll settles nothing and must not
    // resurrect the other account's numbers meanwhile.
    second.setToken(undefined);
    second.handlers.get("turn_end")({}, second.ctx);
    await flush(); await flush();
    second.setToken(other);
    second.handlers.get("turn_end")({}, second.ctx);
    await flush(); await flush();
    assert.doesNotMatch(plain(second.footer().render(240)[0]), /81%|82%/, "an unverifiable reading came back during backoff");
    assert.match(plain(second.footer().render(240)[0]), /limits n\/a/);
  } finally {
    first?.footer().dispose();
    second?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an account-wide limit survives a model switch whose refresh fails", async () => {
  const { module, home } = await loadStatusline();
  const originalFetch = globalThis.fetch;
  const RED_FILL = "\x1b[38;5;203m";
  let h;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      // The account itself is out of quota, and this model has its own bucket too.
      rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800 } },
      additional_rate_limits: [{
        limit_name: "GPT-6-Astra",
        rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
      }],
    }) });
    h = harness(module.default, { token: codexToken("account-wide-limit"), model: codexModel });
    await flush(); await flush();
    assert.ok(h.footer().render(240)[0].includes(RED_FILL));

    globalThis.fetch = async () => ({ ok: false, status: 429 });
    h.handlers.get("model_select")({}, { ...h.ctx, model: { ...codexModel, id: "gpt-6-mini", name: "GPT-6 Mini" } });
    await flush(); await flush();
    const line = h.footer().render(240)[0];
    assert.match(plain(line), /7d\*? 100%/, "the account-wide window is still known");
    assert.ok(line.includes(RED_FILL), "an account-wide limit was downgraded by dropping a model bucket");
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an existing world-readable cache is made private before use, and a symlinked cache is never read or written", async () => {
  const { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "pi-statusline-home-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => codexUsage(33) });
  let h;
  try {
    const dir = join(home, ".pi/agent/cache"), cache = join(dir, "statusline-usage.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(cache, JSON.stringify({ version: 3, readings: {} }));
    chmodSync(cache, 0o644);
    const module = await loadStatuslineAt(home);
    assert.equal(statSync(cache).mode & 0o777, 0o600, "reading an old cache repairs its permissions");
    h = harness(module.default, { token: codexToken("account-one"), model: codexModel });
    await flush(); await flush();
    assert.match(plain(h.footer().render(240)[0]), /7d 33%/);
    assert.equal(statSync(cache).mode & 0o777, 0o600);
    h.footer().dispose();

    const target = join(home, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ version: 3, readings: { forged: { percent: 99 } } }), { mode: 0o600 });
    rmSync(cache);
    symlinkSync(target, cache);
    const linked = await loadStatuslineAt(home);
    h = harness(linked.default, { token: codexToken("account-one"), model: codexModel });
    await flush(); await flush();
    assert.equal(readFileSync(target, "utf8").includes("forged"), true, "a symlinked cache target is never overwritten");
  } finally {
    h?.footer().dispose();
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});
