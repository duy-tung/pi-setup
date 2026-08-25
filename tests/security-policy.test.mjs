import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import permissionGate from "../extensions/permission-gate.ts";
import {
  isUnder,
  protectedWrite,
  protectedWriteRules,
  resolvePolicyPath,
  sensitivePath,
  sensitiveReadRules,
} from "../extensions/lib/path-policy.ts";
import {
  getPermissionMode,
  rememberPermissionSubagent,
  resetPermissionRuntime,
} from "../extensions/lib/permission-mode.ts";
import { buildProfile, confine, writableRoots } from "../extensions/lib/seatbelt.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-test-"));
  const work = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  return {
    root,
    work: realpathSync.native(work),
    outside: realpathSync.native(outside),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function captureHandler(mode = "auto") {
  resetPermissionRuntime(mode);
  let handler;
  permissionGate({
    on(name, fn) {
      if (name === "tool_call") handler = fn;
    },
  });
  assert.equal(typeof handler, "function");
  return handler;
}

function context(cwd, approved = true) {
  const calls = [];
  return {
    calls,
    value: {
      cwd,
      hasUI: true,
      ui: {
        async confirm(title, message) {
          calls.push({ title, message });
          return approved;
        },
      },
    },
  };
}

test("canonical path resolves symlink targets and missing suffixes", () => {
  const f = fixture();
  try {
    const secret = join(f.outside, ".env");
    writeFileSync(secret, "FAKE=1");
    symlinkSync(secret, join(f.work, "alias"));
    assert.equal(resolvePolicyPath("alias", f.work).canonical, secret);
    assert.equal(sensitivePath(resolvePolicyPath("alias", f.work).canonical)?.id, "sensitive-path");

    symlinkSync(f.outside, join(f.work, "outlink"));
    const missing = resolvePolicyPath("outlink/new/file.txt", f.work).canonical;
    assert.equal(missing, join(f.outside, "new", "file.txt"));
    assert.equal(isUnder(missing, f.work), false);
    assert.equal(isUnder(join(f.work, "file"), f.work), true);
    assert.equal(isUnder(`${f.work}2/file`, f.work), false);
  } finally {
    f.cleanup();
  }
});

test("case aliases are denied when the fixture filesystem is case-insensitive", (t) => {
  const f = fixture();
  try {
    const lower = join(f.work, ".env");
    writeFileSync(lower, "FAKE=1");
    const upper = join(f.work, ".ENV");
    try {
      if (resolvePolicyPath(upper, f.work).canonical !== lower) {
        t.skip("fixture filesystem is case-sensitive");
        return;
      }
    } catch {
      t.skip("fixture filesystem is case-sensitive");
      return;
    }
    assert.equal(sensitivePath(resolvePolicyPath(upper, f.work).canonical)?.id, "sensitive-path");
  } finally {
    f.cleanup();
  }
});

test("protected project configuration and scrub backups are classified", () => {
  const f = fixture();
  try {
    assert.equal(protectedWrite(join(f.work, ".pi", "settings.json"), f.work)?.id, "protected-write");
    assert.equal(sensitivePath(join(f.work, ".pi", "agents", "run", "out.md.bak"))?.id, "sensitive-path");
    assert.equal(protectedWrite(join(f.work, "src", "index.ts"), f.work), undefined);
    assert.equal(sensitivePath(join(f.work, "notes.bak")), undefined);
  } finally {
    f.cleanup();
  }
});

test("permission gate hard-denies direct and aliased credential paths", async () => {
  const f = fixture();
  try {
    const secret = join(f.outside, ".env");
    writeFileSync(secret, "FAKE=1");
    symlinkSync(secret, join(f.work, "alias"));
    const handler = captureHandler();
    const ctx = context(f.work);

    const direct = await handler({ toolName: "read", input: { path: secret } }, ctx.value);
    assert.equal(direct.block, true);
    const alias = await handler({ toolName: "read", input: { path: "alias" } }, ctx.value);
    assert.equal(alias.block, true);
    const grep = await handler({ toolName: "grep", input: { path: "alias", pattern: "x" } }, ctx.value);
    assert.equal(grep.block, true);
  } finally {
    f.cleanup();
  }
});

test("permission gate canonicalizes normal reads and asks exactly once for outside writes", async () => {
  const f = fixture();
  const external = mkdtempSync(join(homedir(), ".pi-policy-test-out-"));
  try {
    const handler = captureHandler();
    const ctx = context(f.work, true);
    const readInput = { path: "." };
    assert.equal(await handler({ toolName: "read", input: readInput }, ctx.value), undefined);
    assert.equal(readInput.path, f.work);

    const target = join(realpathSync.native(external), "new.txt");
    const writeInput = { path: target, content: "x" };
    assert.equal(await handler({ toolName: "write", input: writeInput }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0].message, /Operation:/);
    assert.ok(ctx.calls[0].message.includes(target));
  } finally {
    f.cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});

test("permission modes enforce the edit and Bash decision matrix", async () => {
  const f = fixture();
  try {
    const workspaceFile = join(f.work, "src.ts");

    let handler = captureHandler("auto");
    let ctx = context(f.work, true);
    assert.equal(await handler({ toolName: "write", input: { path: workspaceFile, content: "x" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 0);
    assert.equal(await handler({ toolName: "bash", input: { command: "printf test" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 0);

    handler = captureHandler("manual");
    ctx = context(f.work, true);
    assert.equal(await handler({ toolName: "write", input: { path: workspaceFile, content: "x" } }, ctx.value), undefined);
    assert.equal(await handler({ toolName: "bash", input: { command: "pwd" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 2);

    handler = captureHandler("accept-edits");
    ctx = context(f.work, true);
    assert.equal(await handler({ toolName: "edit", input: { path: workspaceFile, oldText: "a", newText: "b" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 0);
    assert.equal(await handler({ toolName: "bash", input: { command: "git status" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 1);

    handler = captureHandler("plan");
    ctx = context(f.work, true);
    assert.equal((await handler({ toolName: "write", input: { path: workspaceFile, content: "x" } }, ctx.value)).block, true);
    assert.equal((await handler({ toolName: "bash", input: { command: "pwd" } }, ctx.value)).block, true);
    assert.equal((await handler({ toolName: "mystery", input: {} }, ctx.value)).block, true);
    assert.equal(ctx.calls.length, 0);
  } finally {
    f.cleanup();
    resetPermissionRuntime();
  }
});

test("Auto asks once for common commit, push, delete, and deploy authority boundaries", async () => {
  const f = fixture();
  try {
    const handler = captureHandler("auto");
    const ctx = context(f.work, true);
    const commands = [
      "git commit -m checkpoint",
      "git push origin main",
      "rm output.txt",
      "rmdir build",
      "kubectl apply -f deploy.yaml",
      "terraform apply plan.out",
      "gh pr merge 42 --squash",
    ];
    for (const [index, command] of commands.entries()) {
      assert.equal(await handler({ toolName: "bash", input: { command } }, ctx.value), undefined);
      assert.equal(ctx.calls.length, index + 1);
      assert.ok(ctx.calls.at(-1).message.includes(command));
    }

    assert.equal(await handler({ toolName: "bash", input: { command: "git status --short" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, commands.length, "read-only git status should stay prompt-free in Auto");
  } finally {
    f.cleanup();
    resetPermissionRuntime();
  }
});

test("Bypass skips prompts but preserves credential and write-boundary hard stops", async () => {
  const f = fixture();
  const external = mkdtempSync(join(homedir(), ".pi-policy-bypass-out-"));
  try {
    const handler = captureHandler("bypass");
    const ctx = context(f.work, true);
    assert.equal(getPermissionMode(), "bypass");
    assert.equal(await handler({ toolName: "bash", input: { command: "rm -rf build" } }, ctx.value), undefined);
    assert.equal(await handler({ toolName: "write", input: { path: join(f.work, "ok.txt"), content: "x" } }, ctx.value), undefined);
    assert.equal(ctx.calls.length, 0);

    const outside = await handler(
      { toolName: "write", input: { path: join(external, "blocked.txt"), content: "x" } },
      ctx.value,
    );
    assert.equal(outside.block, true);
    assert.match(outside.reason, /Bypass skips prompts/);

    const credential = await handler({ toolName: "read", input: { path: join(f.work, ".env") } }, ctx.value);
    assert.equal(credential.block, true);
    const token = await handler({ toolName: "bash", input: { command: "gh auth token" } }, ctx.value);
    assert.equal(token.block, true);
    assert.equal(ctx.calls.length, 0);
  } finally {
    f.cleanup();
    rmSync(external, { recursive: true, force: true });
    resetPermissionRuntime();
  }
});

test("work subagent activation is broad-approved in Manual and blocked in Plan", async () => {
  const f = fixture();
  try {
    let handler = captureHandler("manual");
    let ctx = context(f.work, true);
    const start = {
      toolName: "subagent",
      input: { profile: "work", description: "implement parser", prompt: "details" },
    };
    assert.equal(await handler(start, ctx.value), undefined);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].message.includes("details"), false);

    rememberPermissionSubagent("work-child", "work");
    assert.equal(
      await handler({ toolName: "send_message", input: { subagent_id: "work-child", message: "continue" } }, ctx.value),
      undefined,
    );
    assert.equal(ctx.calls.length, 2);

    handler = captureHandler("plan");
    rememberPermissionSubagent("work-child", "work");
    ctx = context(f.work, true);
    assert.equal((await handler(start, ctx.value)).block, true);
    assert.equal(
      (await handler({ toolName: "send_message", input: { subagent_id: "work-child", message: "continue" } }, ctx.value)).block,
      true,
    );
    assert.equal(
      await handler({ toolName: "subagent", input: { profile: "explore", description: "inspect", prompt: "read" } }, ctx.value),
      undefined,
    );
    assert.equal(ctx.calls.length, 0);
  } finally {
    f.cleanup();
    resetPermissionRuntime();
  }
});

test("Seatbelt profile shares canonical roots and adds sensitive/protected denies", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, ".env"), "FAKE=1");
    const roots = writableRoots(f.work);
    const profile = buildProfile(roots, sensitiveReadRules(f.work), protectedWriteRules(f.work));
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\(allow file-write\*/);
    assert.match(profile, /\(deny file-read\*/);
    assert.ok(profile.includes(join(f.work, ".env")));
    assert.ok(profile.includes(join(f.work, ".git", "config")));
    assert.ok(confine("printf 'x'", profile).startsWith("sandbox-exec -p "));
  } finally {
    f.cleanup();
  }
});

test("sandbox source exposes no unsandboxed escalation path", () => {
  const source = readFileSync(new URL("../extensions/sandbox-bash.ts", import.meta.url), "utf8");
  assert.equal(source.includes("sandbox_permissions"), false);
  assert.equal(source.includes("danger-full-access"), false);
  assert.match(source, /executionMode: "sequential"/);
  assert.match(source, /mode === "plan"\s*\? \[\]/);

  const modeSource = readFileSync(new URL("../extensions/permission-mode.ts", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../extensions/lib/permission-mode.ts", import.meta.url), "utf8");
  assert.match(modeSource, /SEATBELT_AVAILABLE/);
  assert.match(source, /sandboxActive = SEATBELT_AVAILABLE/);
  assert.equal(modeSource.includes("PI_PERMISSION_MODE"), false);
  assert.equal(stateSource.includes("PI_PERMISSION_MODE"), false);
});

test("RPC subagent has no tmux, cwd override, or legacy control surface", () => {
  const source = readFileSync(new URL("../extensions/subagent.ts", import.meta.url), "utf8");
  assert.match(source, /ManagedRpcChild/);
  assert.match(source, /name: "subagent"/);
  assert.match(source, /name: "send_message"/);
  assert.match(source, /name: "list_agents"/);
  assert.match(source, /name: "interrupt_agent"/);
  assert.equal(source.includes("tmux"), false);
  assert.equal(source.includes("agent_spawn"), false);
  assert.equal(source.includes("agent_wait"), false);
  assert.equal(source.includes("output_schema"), false);
  assert.equal(source.includes("cwd: Type.Optional"), false);
  assert.ok(source.indexOf("await rpc.prompt(prompt)") < source.indexOf("active.set(record.id, activeChild)"));
  assert.match(source, /withChildControl/);
  assert.match(source, /setImmediate/);
  assert.match(source, /if \(!live\.settled\) return "queued"/);
  assert.match(source, /markInterruption/);
  assert.match(source, /getPermissionMode\(\) === "plan"/);
  assert.match(source, /markWorkSubagentRunning/);
  assert.equal(source.includes("PI_PERMISSION_MODE"), false);
  assert.match(source, /void settlement\.catch\(\(\) => \{\}\)/);
  assert.match(source, /finalizePromise\.catch\(\(\) => \{\}\)/);

  const statusline = readFileSync(new URL("../extensions/statusline.ts", import.meta.url), "utf8");
  assert.match(statusline, /ctx\.mode !== "tui"/);

  const present = readFileSync(new URL("../extensions/present.ts", import.meta.url), "utf8");
  assert.match(present, /ManagedRpcChild/);
  assert.match(present, /let enabled = false/);
  assert.match(present, /ctx\.mode !== "tui"/);
  assert.match(present, /--mode", "rpc"/);
  assert.match(present, /--no-session/);
  assert.match(present, /--no-tools/);
  assert.match(present, /--no-extensions/);
  assert.match(present, /PRESENT_MODEL = "openai-codex\/gpt-5\.6-sol:off"/);
  assert.match(present, /void settlement\.catch\(\(\) => \{\}\)/);
  assert.equal(present.includes("execFile"), false);
  assert.equal(present.includes("pi.sendMessage"), false);
});

test("permission gate shows exact destructive command and fails closed without UI", async () => {
  const f = fixture();
  try {
    const handler = captureHandler();
    const attended = context(f.work, true);
    const command = "git push --force-with-lease origin main";
    assert.equal(await handler({ toolName: "bash", input: { command } }, attended.value), undefined);
    assert.equal(attended.calls.length, 1);
    assert.match(attended.calls[0].message, /git push --force-with-lease origin main/);

    const blocked = await handler(
      { toolName: "bash", input: { command: "rm -rf build" } },
      { cwd: f.work, hasUI: false },
    );
    assert.equal(blocked.block, true);
  } finally {
    f.cleanup();
  }
});

async function spillHandlers(home) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const handlers = {};
    const { default: spill } = await import(`../extensions/spill.ts?test=${Date.now()}-${Math.random()}`);
    spill({ on(name, fn) { handlers[name] = fn; } });
    handlers.session_start();
    return handlers;
  } finally {
    process.env.HOME = previous;
  }
}

test("spill withholds oversized raw core output instead of exposing its locator", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-spill-home-"));
  try {
    const handlers = await spillHandlers(home);
    const rawPath = join(home, "raw-large.txt");
    writeFileSync(rawPath, "R".repeat(8 * 1024 * 1024 + 1));
    const result = handlers.tool_result({
      toolName: "bash",
      content: [{ type: "text", text: "safe preview\n".repeat(2000) }],
      details: { fullOutputPath: rawPath },
    });
    assert.match(result.content[0].text, /full text withheld/);
    assert.equal(result.content[0].text.includes(rawPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spill stores a redacted copy and removes a bounded raw core file", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-spill-home-"));
  try {
    const handlers = await spillHandlers(home);
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const rawPath = join(home, "raw-small.txt");
    writeFileSync(rawPath, `${token}\n${"x".repeat(20000)}`);
    const result = handlers.tool_result({
      toolName: "bash",
      content: [{ type: "text", text: `${token}\n${"x".repeat(20000)}` }],
      details: { fullOutputPath: rawPath },
    });
    const match = result.content[0].text.match(/full text saved to (.+?)\. Preview/);
    assert.ok(match);
    const stored = match[1];
    assert.equal(readFileSync(stored, "utf8").includes(token), false);
    assert.equal(readFileSync(stored, "utf8").includes("[REDACTED:GITHUB_TOKEN]"), true);
    assert.equal(existsSync(rawPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
