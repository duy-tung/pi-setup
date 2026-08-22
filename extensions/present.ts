/**
 * present.ts — automatic "GPT presentation" layer for Pi.
 *
 * Port of the claudish-to-english design (https://github.com/gvzdv/claudish-to-english)
 * to Pi's extension API. After each settled agent run, the last long assistant
 * answer is rewritten into plainer language by GPT-5.6 Sol (reasoning off) and
 * shown as a display-only entry under the original. Custom entries never join
 * the LLM context, so the model keeps reasoning over its own original text.
 *
 * Contracts kept from claudish: fail-open (any error, timeout, or short answer
 * -> nothing is shown, the original stays), min-prose gate, fenced code blocks
 * untouched, append display mode. Toggle at runtime with /present [on|off].
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";

const MODEL = "openai-codex/gpt-5.6-sol:off"; // no reasoning: plain rewrite only
const MIN_PROSE_CHARS = 200;
const TIMEOUT_MS = 90_000;

// Spawn the exact pi that is running now (same binary, same version) instead
// of whatever "pi" the PATH happens to resolve — a PATH without mise shims
// would otherwise make every rewrite fail silently. Same pattern as subagent.ts.
const PI_ENTRY = process.argv[1];

const INSTRUCTIONS =
  "Rewrite the attached assistant message into plainer language for its reader. " +
  "Write in the same language as the message. Keep every fact, number, file path, " +
  "command, and caveat exactly; leave fenced code blocks unchanged. Short sentences, " +
  "one idea per sentence, active voice, no ambiguity. Lead with the one-sentence " +
  "version of what matters. Output ONLY the rewritten message - no preamble, no " +
  "labels, no commentary.";

export default function (pi: any) {
  let enabled = true;
  let busy = false;
  let lastHandled: string | undefined;

  pi.registerEntryRenderer("present", (entry: any, _opts: any, theme: any) => {
    const data = (entry.data ?? {}) as { text?: string };
    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("dim", "💬 GPT presentation (display-only; the model sees only the original above):")));
    for (const line of String(data.text ?? "").split("\n")) box.addChild(new Text(line));
    return box;
  });

  pi.registerCommand("present", {
    description: "Toggle the automatic GPT plain-language layer (on|off)",
    handler: async (args: string, ctx: any) => {
      const a = (args ?? "").trim().toLowerCase();
      enabled = a === "on" ? true : a === "off" ? false : !enabled;
      ctx.ui?.notify?.(`present: ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (!enabled || busy) return;
    if (process.env.PI_SUBAGENT_DEPTH) return; // never inside sub-agents
    if (!ctx.ui) return; // interactive TUI only; skip -p runs
    let text: string;
    try {
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      let msg: any;
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e?.type === "message" && e.message?.role === "assistant") { msg = e; break; }
      }
      if (!msg || msg.id === lastHandled) return;
      lastHandled = msg.id;
      text = extractText(msg.message);
      if (proseLen(text) < MIN_PROSE_CHARS) return;
    } catch {
      return; // fail open
    }
    // Fire and forget: pi AWAITS agent_settled handlers before resolving its
    // idle wait (verified in agent-session.js _emitAgentSettled), so the slow
    // GPT call must NOT be awaited here or it would hold the session for up
    // to TIMEOUT_MS. The detached promise appends the entry when it lands.
    busy = true;
    ctx.ui.setStatus?.("present", "present: rewriting…");
    void rewriteWithGpt(text)
      .then((rewrite) => {
        if (rewrite) pi.appendEntry("present", { text: rewrite });
      })
      .catch(() => {
        // fail open: the original answer is already on screen; show nothing.
      })
      .finally(() => {
        busy = false;
        try { ctx.ui?.setStatus?.("present", undefined); } catch {}
      });
  });
}

function extractText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n");
  }
  return "";
}

/** Non-space chars outside fenced code blocks. */
function proseLen(text: string): number {
  let inFence = false;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
    if (!inFence) n += line.replace(/\s/g, "").length;
  }
  return n;
}

function rewriteWithGpt(text: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let dir: string | undefined;
    const done = (v?: string) => {
      if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
      resolve(v);
    };
    try {
      dir = mkdtempSync(join(tmpdir(), "pi-present-"));
      const file = join(dir, "answer.md");
      writeFileSync(file, text, "utf8");
      execFile(
        process.execPath,
        [
          PI_ENTRY,
          "--no-session", "--no-extensions", "--no-skills",
          "--no-prompt-templates", "--no-context-files", "-nt",
          "--model", MODEL, "-p", `@${file}`, INSTRUCTIONS,
        ],
        { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return done(undefined);
          const out = String(stdout ?? "").trim();
          done(out.length > 0 ? out : undefined);
        },
      );
    } catch {
      done(undefined);
    }
  });
}
