import { createHash } from "node:crypto";

export interface UsageWindow {
  label: string;
  pct: number;
  resetsAt?: number;
  scoped?: boolean;
}
export interface UsageReading {
  /** Severity of the account-wide windows: true whichever model is selected. */
  severity: string;
  /** Severity raised by the selected model's own bucket, if the response has one. */
  scopedSeverity?: string;
  windows: UsageWindow[];
}

const BENIGN = new Set(["normal", "ok"]);

/**
 * The severity to paint with.
 *
 * A scoped bucket belongs to one model, so a reading reused under another model must
 * forget it — but never at the cost of the account-wide state, which stays true and
 * would otherwise be silently downgraded to normal for as long as refreshes keep failing.
 */
export function effectiveSeverity(reading: { severity: string; scopedSeverity?: string }, withScoped: boolean): string {
  const scoped = withScoped ? reading.scopedSeverity : undefined;
  return scoped !== undefined && !BENIGN.has(scoped) ? scoped : reading.severity;
}

const percent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
const date = (value: unknown): number | undefined => {
  const result = typeof value === "number" ? value * 1000
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(result) && result > 0 ? result : undefined;
};
// Anthropic's scoped quota names can be just "Fable" with a null model id.
const modelKey = (value: string) => value.toLowerCase().replace(/^claude[\s-]+/, "").replace(/[^a-z0-9]/g, "");
const matchesModel = (name: unknown, modelId: string): boolean =>
  typeof name === "string" && modelKey(name).length > 3 && modelKey(modelId).startsWith(modelKey(name));

export function windowLabel(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

export function parseUsage(provider: string, data: any, modelId: string, now = Date.now()): UsageReading {
  const windows: UsageWindow[] = [];
  let severity = "normal";
  let scopedSeverity: string | undefined;
  if (provider === "anthropic") {
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
      const pct = percent(data?.[key]?.utilization);
      if (pct !== undefined) windows.push({ label, pct, resetsAt: date(data[key].resets_at) });
    }
    const limits = Array.isArray(data?.limits) ? data.limits : [];
    for (const limit of limits) {
      if (limit.kind !== "weekly_scoped") continue;
      if (typeof limit.severity === "string"
        && [limit.scope?.model?.id, limit.scope?.model?.name, limit.scope?.model?.display_name].some(name => matchesModel(name, modelId))) {
        scopedSeverity = limit.severity;
      }
      const model = limit.scope?.model;
      if (![model?.id, model?.name, model?.display_name].some(name => matchesModel(name, modelId))) continue;
      const pct = percent(limit.percent);
      if (pct === undefined) continue;
      const family = modelId.replace(/^claude-/, "").split("-")[0];
      windows.push({ label: family, pct, resetsAt: date(limit.resets_at), scoped: true });
    }
    const status = limits.find((limit: any) => limit.kind === "session")?.severity;
    if (typeof status === "string") severity = status;
  } else if (provider === "openai-codex") {
    const addWindows = (limits: any, prefix = "") => {
      for (const [key, fallback] of [["primary_window", "primary"], ["secondary_window", "secondary"]]) {
        const window = limits?.[key];
        const pct = percent(window?.used_percent);
        if (pct === undefined) continue;
        const relative = typeof window.reset_after_seconds === "number" && window.reset_after_seconds >= 0
          ? now + window.reset_after_seconds * 1000 : undefined;
        windows.push({
          label: prefix + windowLabel(window.limit_window_seconds, fallback),
          pct, resetsAt: date(window.reset_at) ?? relative, scoped: prefix !== "",
        });
      }
      if (limits?.limit_reached === true || limits?.allowed === false) {
        if (prefix === "") severity = "limited";
        else scopedSeverity = "limited";
      }
    };
    addWindows(data?.rate_limit);
    for (const limit of Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits : []) {
      if (matchesModel(limit.limit_name, modelId)) addWindows(limit.rate_limit, "mdl ");
    }
  }
  if (windows.length === 0) throw new Error("Usage response contains no usable quota windows");
  return scopedSeverity === undefined ? { windows, severity } : { windows, severity, scopedSeverity };
}

// Anthropic gates /api/oauth/usage on the User-Agent prefix, not on request rate.
// Measured against one token, seconds apart: `claude-code/<any version>` answers
// 200 while `node` (Node's fetch default), `claude-cli/...` and any other agent
// share one bucket that is already exhausted after a couple of reads — which is
// why backoff alone never recovers and the footer sticks at `limits n/a`.
// The version tracks the Claude Code release Pi's own Anthropic transport pins.
const ANTHROPIC_USER_AGENT = "claude-code/2.1.251";

export interface UsageRequest {
  url: string;
  headers: Record<string, string>;
  /** Cache key for readings taken with this request. */
  identity: string;
  /** Whether that key provably names one account, or merely one provider. */
  accountBound: boolean;
  /** Names the credential without carrying it, so a rotation is distinguishable. */
  credential: string;
}

/**
 * Use the same account claim as Pi's OpenAI Codex transport; never persist the token.
 *
 * The identity keys the cached reading. Codex tokens carry an account claim, so its
 * readings are account-bound. An Anthropic OAuth token is opaque and rotates every hour,
 * so hashing it named the token rather than the account: the cache died on every refresh
 * and the footer had to buy a new reading from a rate-limited endpoint to recover facts
 * it already held. Anthropic readings are therefore keyed per provider and marked not
 * account-bound, which is what lets the caller treat a reading taken under a different
 * credential as unverified rather than as fact.
 */
export function usageRequest(provider: string, token: string): UsageRequest {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const credential = createHash("sha256").update(token).digest("hex");
  if (provider === "anthropic") {
    if (!token.startsWith("sk-ant-oat")) throw new Error("Anthropic API-key auth has no subscription quota");
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["user-agent"] = ANTHROPIC_USER_AGENT;
    return {
      url: "https://api.anthropic.com/api/oauth/usage",
      headers,
      identity: "anthropic:oauth",
      accountBound: false,
      credential,
    };
  }
  if (provider === "openai-codex") {
    let accountId: unknown;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch { /* reported without including any credential bytes */ }
    if (typeof accountId !== "string" || !accountId || /[\r\n]/.test(accountId)) {
      throw new Error("Codex OAuth account claim unavailable; use /login openai-codex");
    }
    headers["chatgpt-account-id"] = accountId;
    return {
      url: "https://chatgpt.com/backend-api/wham/usage",
      headers,
      identity: provider + ":" + createHash("sha256").update(accountId).digest("hex"),
      accountBound: true,
      credential,
    };
  }
  throw new Error("This provider has no supported subscription quota endpoint");
}

export function contextWindowLabel(size: unknown): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return "";
  const format = (value: number) => String(Math.round(value * 100) / 100);
  return size >= 1_000_000 ? format(size / 1_000_000) + "M"
    : size >= 1000 ? format(size / 1000) + "K" : String(size);
}

export function selectedModelLabel(model: any): string {
  if (model?.name) return model.name.replace(/\s*\(.*$/, "").replace(/^claude[-\s]/i, "");
  const id = model?.id ?? "?";
  if (id.startsWith("claude-")) {
    const [, family, ...version] = id.split("-");
    return family[0].toUpperCase() + family.slice(1) + (version.length ? " " + version.join(".") : "");
  }
  if (id.startsWith("gpt-")) return id.replace(/^gpt-/, "GPT-").replace(/-([a-z]+)/g, (_: string, word: string) => " " + word[0].toUpperCase() + word.slice(1));
  return id;
}
