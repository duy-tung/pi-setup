import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const promptSource = join(
  homedir(),
  ".pi",
  "agent",
  "git",
  "github.com",
  "duy-tung",
  "pi-anthropic-oauth-plus",
  "src",
  "prompt.ts",
);

test("technical-safe OAuth rewriting preserves technical paths", async () => {
  assert.equal(existsSync(promptSource), true, `installed OAuth prompt source is missing: ${promptSource}`);
  const { sanitizeSystemText } = await import(`${pathToFileURL(promptSource).href}?test=${Date.now()}`);
  const source = "Pi uses /tmp/example/pi-setup and ~/.pi/agent.";
  const rewritten = sanitizeSystemText(source, {
    PI_ANTHROPIC_OAUTH_REWRITE_MODE: "technical-safe",
  });
  assert.equal(rewritten, "Claude Code uses /tmp/example/pi-setup and ~/.pi/agent.");
});
