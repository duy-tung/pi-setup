/**
 * Shared credential-shaped redaction patterns.
 *
 * Single source of truth for every place that scrubs text before it leaves
 * the tool boundary: secret-guard redacts inline tool results (what reaches
 * the transcript and the provider), spill redacts the full-text files it
 * writes to disk. Keeping one list means a pattern added here closes both
 * exits at once.
 *
 * Anchored enough to avoid eating normal base64/hex blobs.
 */

export const REDACTIONS: { re: RegExp; label: string }[] = [
	{ re: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_OAUTH_ACCESS" },
	{ re: /sk-ant-ort01-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_OAUTH_REFRESH" },
	{ re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_API_KEY" },
	{ re: /rt\.1\.[A-Za-z0-9_-]{40,}/g, label: "CODEX_REFRESH" },
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: "JWT" },
	{ re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, label: "BEARER_TOKEN" },
	{ re: /ctx7sk-[0-9a-fA-F-]{20,}/g, label: "CONTEXT7_KEY" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB_PAT" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY_ID" },
	{ re: /\bASIA[0-9A-Z]{16}\b/g, label: "AWS_STS_KEY_ID" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "SLACK_TOKEN" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE_API_KEY" },
	{ re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, label: "OPENAI_KEY" },
	{ re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}/g, label: "OPENAI_SERVICE_KEY" },
	{ re: /\bsk_live_[A-Za-z0-9_-]{20,}/g, label: "STRIPE_SECRET_KEY" },
	{ re: /\bsk-[A-Za-z0-9_-]{32,}/g, label: "OPENAI_LEGACY_KEY" },
	{ re: /\bya29\.[A-Za-z0-9_-]{20,}/g, label: "GOOGLE_OAUTH_TOKEN" },
	// Inline-only heuristic; offline scrub deliberately omits ambiguous unlabelled AWS-40 data.
	{ re: /\b(?=[A-Za-z0-9/+=]{40}\b)(?![A-Fa-f0-9]{40}\b)(?=[A-Za-z0-9/+=]*[A-Z])(?=[A-Za-z0-9/+=]*[a-z])(?=[A-Za-z0-9/+=]*[0-9])[A-Za-z0-9/+=]{40}\b/g, label: "AWS_SECRET_ACCESS_KEY" },
	{ re: /\bxai-[A-Za-z0-9_-]{20,}/g, label: "XAI_KEY" },
	{ re: /\bhf_[A-Za-z0-9]{20,}/g, label: "HUGGINGFACE_TOKEN" },
	{ re: /\bnpm_[A-Za-z0-9]{20,}/g, label: "NPM_TOKEN" },
	{ re: /\bglpat-[A-Za-z0-9_-]{20,}/g, label: "GITLAB_TOKEN" },
	{ re: /\btvly-[A-Za-z0-9_-]{20,}/g, label: "TAVILY_KEY" },
	{
		re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
		label: "PRIVATE_KEY_BLOCK",
	},
];

export function redact(text: string): { text: string; hits: string[] } {
	const hits: string[] = [];
	let out = text;
	for (const { re, label } of REDACTIONS) {
		out = out.replace(re, () => {
			if (!hits.includes(label)) hits.push(label);
			return `[REDACTED:${label}]`;
		});
	}
	return { text: out, hits };
}
