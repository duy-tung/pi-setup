/**
 * Anthropic fast mode (`speed: "fast"`) for pi.
 *
 * pi has no built-in support: `pi-ai`'s anthropic-messages provider never sets
 * `speed`, and `samplingParams` is only applied by the OpenAI-family providers.
 * So this extension injects the body param and the beta header by hand:
 *
 *   before_provider_request -> payload.speed = "fast"
 *   before_provider_headers -> anthropic-beta: ...,fast-mode-2026-02-01
 *
 * Cost: fast mode bills at 2x list price (Opus 5 / 4.8) and is drawn from extra
 * usage credits, not from the plan's included usage — hence default off, opt in
 * per session with /fast.
 *
 * Toggling mid-session invalidates the prompt cache (speed is part of the cache
 * key), so the next request re-reads the whole context at uncached input price.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FAST_BETA = "fast-mode-2026-02-01";
// pi's own betas for an OAuth (subscription) session. They are set as client
// default headers, and `optionsHeaders` — which is where this extension writes —
// overwrites the whole header, so the list has to be restated, not appended to.
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
// Added by pi whenever tools are present and the model lacks eager tool input
// streaming, which is the case for every model fast mode supports.
const FINE_GRAINED_BETA = "fine-grained-tool-streaming-2025-05-14";

// Opus 4.7 and earlier lost fast mode on 2026-07-24: sending speed there is a
// hard error, not a downgrade, so the gate is an allowlist.
const SUPPORTED = /^claude-opus-(5|4-8)(-|$)/;

let enabled = process.env.PI_FAST_MODE === "1";
let isOAuth: boolean | null = null;

const supported = (id: string | undefined) => !!id && SUPPORTED.test(id);

export default function (pi: ExtensionAPI) {
	const showStatus = (ctx: any) => {
		ctx.ui?.setStatus?.("fast-mode", enabled ? "⚡ fast" : undefined);
	};

	const resolveAuth = async (ctx: any) => {
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			isOAuth = !!key?.startsWith("sk-ant-oat");
		} catch {
			isOAuth = null;
		}
	};

	pi.on("session_start", async (_e, ctx) => {
		await resolveAuth(ctx);
		showStatus(ctx);
	});
	// Re-resolved on model change too: a /login mid-session can move the provider
	// between API-key and OAuth, and a value cached at session_start would keep
	// sending the wrong beta set until restart. (A /login with no model switch is
	// still stale until the next one — the unknown state defaults to OAuth betas,
	// which is the harmless direction.)
	pi.on("model_select", async (_e, ctx) => {
		await resolveAuth(ctx);
	});

	pi.on("before_provider_request", (e, ctx) => {
		if (!enabled) return;
		const p = e.payload as { model?: string } | undefined;
		if (!p || typeof p !== "object" || !supported(p.model)) return;
		if (ctx.model?.provider !== "anthropic") return;
		return { ...p, speed: "fast" };
	});

	pi.on("before_provider_headers", (e, ctx) => {
		if (!enabled) return;
		if (ctx.model?.provider !== "anthropic" || !supported(ctx.model?.id)) return;
		const betas = new Set<string>();
		// Preserve anything another extension already put there.
		for (const [k, v] of Object.entries(e.headers)) {
			if (k.toLowerCase() === "anthropic-beta" && typeof v === "string") {
				for (const b of v.split(",")) if (b.trim()) betas.add(b.trim());
			}
		}
		if (isOAuth !== false) for (const b of OAUTH_BETAS) betas.add(b);
		betas.add(FINE_GRAINED_BETA);
		betas.add(FAST_BETA);
		e.headers["anthropic-beta"] = Array.from(betas).join(",");
	});

	pi.registerCommand("fast", {
		description: "Toggle Anthropic fast mode (2x price, billed to extra usage credits)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !enabled;
			if (next === enabled) {
				ctx.ui.notify(`fast mode already ${enabled ? "on" : "off"}`, "info");
				return;
			}
			enabled = next;
			showStatus(ctx);
			if (!enabled) {
				ctx.ui.notify("fast mode off — back to standard speed and plan usage", "info");
				return;
			}
			if (!supported(ctx.model?.id)) {
				ctx.ui.notify(
					`fast mode on, but ${ctx.model?.id ?? "no model"} does not support it (Opus 5 / 4.8 only) — requests stay at standard speed`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				"fast mode on — 2x price, drawn from extra usage credits, and this turn re-reads the context uncached",
				"warning",
			);
		},
	});
}
