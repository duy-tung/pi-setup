/**
 * OpenAI/Codex fast mode via service_tier: "priority" (the Fast mode alias).
 * Opt in with /fast on or PI_FAST_MODE=1; never change reasoning effort/model.
 * Model/account availability and pricing are controlled by the provider. The
 * status indicates a requested tier, not confirmation of the tier served.
 * Other providers, including Anthropic, are left untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function supportsFastMode(model: ExtensionContext["model"]): boolean {
	return !!model && (
		(model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
		(model.provider === "openai" && (model.api === "openai-responses" || model.api === "openai-completions"))
	);
}

export default function (pi: ExtensionAPI) {
	const initiallyEnabled = process.env.PI_FAST_MODE === "1";
	let enabled = initiallyEnabled;

	const showStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("fast-mode", enabled && supportsFastMode(ctx.model) ? "⚡ fast requested" : undefined);
	};

	const describe = (ctx: ExtensionContext) => {
		if (!enabled) return "fast mode off — no service-tier override; provider defaults apply";
		if (!supportsFastMode(ctx.model)) {
			return "fast mode on but inactive — only OpenAI/Codex APIs are supported; current requests are unchanged";
		}
		return "fast mode on — requesting priority service; availability and extra cost/credit usage depend on model and account";
	};

	pi.on("session_start", (_event, ctx) => {
		enabled = initiallyEnabled;
		showStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => showStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("fast-mode", undefined));

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx.model)) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		return { ...payload, service_tier: "priority" };
	});

	pi.registerCommand("fast", {
		description: "OpenAI/Codex fast mode (on|off|status); priority service may cost more",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(arg)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			if (arg !== "status") enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			showStatus(ctx);
			ctx.ui.notify(describe(ctx), enabled && arg !== "status" ? "warning" : "info");
		},
	});
}
