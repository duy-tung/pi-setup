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
	{ re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: "JWT" },
	{ re: /ctx7sk-[0-9a-fA-F-]{20,}/g, label: "CONTEXT7_KEY" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB_PAT" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY_ID" },
	{ re: /\bASIA[0-9A-Z]{16}\b/g, label: "AWS_STS_KEY_ID" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "SLACK_TOKEN" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE_API_KEY" },
	{ re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, label: "OPENAI_KEY" },
	{
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
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
