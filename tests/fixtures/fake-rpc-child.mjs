#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_RPC_MODE ?? "normal";
if (process.env.FAKE_SELF_PID) writeFileSync(process.env.FAKE_SELF_PID, String(process.pid));
let buffer = Buffer.alloc(0);
let lastText = null;
let dialogPending = false;

if (mode === "ignore-term" || mode === "descendant") process.on("SIGTERM", () => {});
if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_DESCENDANT_PID, String(child.pid));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assistant(text) {
  lastText = text;
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.001 } },
      stopReason: "stop",
    },
  });
}

function settle(text) {
  assistant(text);
  send({ type: "agent_settled" });
}

function handle(command) {
  if (command.type === "extension_ui_response") {
    if (dialogPending && command.id === "dialog-1" && command.cancelled === true) {
      dialogPending = false;
      settle("dialog denied safely");
    }
    return;
  }

  const response = (data) => send({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });

  switch (command.type) {
    case "get_state":
      if (mode === "slow-state") return;
      response({
        model: { provider: "fake", id: "fake-model" },
        thinkingLevel: "off",
        isStreaming: false,
        sessionFile: "/tmp/fake-subagent-session.jsonl",
        sessionId: "fake-session",
        sessionName: "fake-child",
        pendingMessageCount: 0,
      });
      return;
    case "get_last_assistant_text":
      response({ text: lastText });
      return;
    case "get_session_stats":
      response({ tokens: 12, cost: 0.001 });
      return;
    case "prompt": {
      if (mode === "immediate") {
        process.stdout.write(
          `${JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true })}\n`
          + `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "contains U+2028 inside" }], stopReason: "stop" } })}\n`
          + `${JSON.stringify({ type: "agent_settled" })}\n`,
        );
        lastText = "contains U+2028 inside";
        return;
      }
      response();
      if (mode === "dialog") {
        dialogPending = true;
        send({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Allow?", message: "No" });
      } else if (mode === "exit-before-settle") {
        setImmediate(() => process.exit(7));
      } else if (mode === "malformed") {
        process.stdout.write("{not-json}\n");
      } else if (mode === "oversized") {
        process.stdout.write(`${JSON.stringify({ type: "event", payload: "x".repeat(4096) })}\n`);
      } else if (mode === "stderr") {
        process.stderr.write("E".repeat(2 * 1024 * 1024), () => settle("stderr bounded"));
      } else if (mode === "delayed" || mode === "ignore-term") {
        // The test controls termination.
      } else {
        setImmediate(() => settle(`prompt: ${command.message}`));
      }
      return;
    }
    case "follow_up":
      response();
      setImmediate(() => settle(`follow-up: ${command.message}`));
      return;
    case "steer":
      response();
      setImmediate(() => settle(`steer: ${command.message}`));
      return;
    case "abort":
      response();
      setImmediate(() => send({ type: "agent_settled" }));
      return;
    default:
      send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    let line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (line.length === 0) continue;
    handle(JSON.parse(line.toString("utf8")));
  }
});

process.stdin.on("end", () => process.exit(0));
