import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ManagedRpcChild,
  RpcProcessExitError,
  RpcProtocolError,
} from "../extensions/lib/subagent-rpc.ts";
import { resolvePiInvocation } from "../extensions/lib/pi-invocation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-rpc-child.mjs");

test("Pi invocation resolver handles script, Bun virtual, and standalone binaries", () => {
  assert.deepEqual(resolvePiInvocation({
    currentScript: "/opt/pi/cli.js",
    executablePath: "/opt/node/bin/node",
    fileExists: () => true,
  }), { command: "/opt/node/bin/node", args: ["/opt/pi/cli.js"] });
  assert.deepEqual(resolvePiInvocation({
    currentScript: "/$bunfs/root/cli.js",
    executablePath: "/opt/bun/bin/bun",
    fileExists: () => true,
  }), { command: "pi", args: [] });
  assert.deepEqual(resolvePiInvocation({
    currentScript: "",
    executablePath: "/usr/local/bin/pi",
    fileExists: () => false,
  }), { command: "/usr/local/bin/pi", args: [] });
});

async function start(mode, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-rpc-"));
  try {
    const child = await ManagedRpcChild.start({
      command: process.execPath,
      args: [fixture],
      cwd: root,
      env: { FAKE_RPC_MODE: mode },
      stderrPath: join(root, "stderr.log"),
      ...overrides,
    });
    return {
      child,
      root,
      async cleanup() {
        await child.dispose();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("managed RPC child publishes, settles, follows up, and disposes", async () => {
  const f = await start("normal");
  try {
    assert.equal(statSync(join(f.root, "stderr.log")).mode & 0o777, 0o600);
    const first = f.child.nextSettlement(2_000);
    await f.child.prompt("alpha");
    await first;
    assert.equal(await f.child.getLastAssistantText(), "prompt: alpha");
    assert.deepEqual(await f.child.getSessionStats(), { tokens: 12, cost: 0.001 });

    const second = f.child.nextSettlement(2_000);
    await f.child.followUp("beta");
    await second;
    assert.equal(await f.child.getLastAssistantText(), "follow-up: beta");
  } finally {
    await f.cleanup();
  }
  assert.ok(f.child.process.exitCode !== null || f.child.process.signalCode !== null);
});

test("strict LF framing preserves Unicode line separators and immediate settlement", async () => {
  const f = await start("immediate");
  try {
    const settled = f.child.nextSettlement(2_000);
    await f.child.prompt("unicode");
    await settled;
    assert.equal(await f.child.getLastAssistantText(), "contains U+2028 inside");
  } finally {
    await f.cleanup();
  }
});

test("RPC extension dialogs are cancelled without an attended child UI", async () => {
  const f = await start("dialog");
  try {
    const settled = f.child.nextSettlement(2_000);
    await f.child.prompt("ask");
    await settled;
    assert.equal(await f.child.getLastAssistantText(), "dialog denied safely");
  } finally {
    await f.cleanup();
  }
});

test("startup abort disposes a child blocked in RPC readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-rpc-startup-"));
  const pidPath = join(root, "child.pid");
  const controller = new AbortController();
  const starting = ManagedRpcChild.start({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: { FAKE_RPC_MODE: "slow-state", FAKE_SELF_PID: pidPath },
    stderrPath: join(root, "stderr.log"),
    signal: controller.signal,
    disposeGraceMs: 50,
  });
  try {
    for (let attempt = 0; attempt < 40 && !existsSync(pidPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(pidPath), true);
    const pid = Number(readFileSync(pidPath, "utf8"));
    controller.abort();
    await assert.rejects(starting, /aborted|disposed/);
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        if (error?.code === "ESRCH") alive = false;
        else throw error;
      }
    }
    assert.equal(alive, false);
  } finally {
    controller.abort();
    await starting.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("process exit before settlement is an explicit failure", async () => {
  const f = await start("exit-before-settle");
  try {
    const settled = f.child.nextSettlement(2_000);
    await f.child.prompt("exit");
    await assert.rejects(settled, RpcProcessExitError);
  } finally {
    await f.cleanup();
  }
});

test("malformed and oversized RPC records fail closed", async (t) => {
  await t.test("malformed", async () => {
    const f = await start("malformed");
    try {
      const settled = f.child.nextSettlement(2_000);
      await f.child.prompt("bad json");
      await assert.rejects(settled, RpcProtocolError);
    } finally {
      await f.cleanup();
    }
  });

  await t.test("oversized", async () => {
    const f = await start("oversized", { lineLimitBytes: 512 });
    try {
      const settled = f.child.nextSettlement(2_000);
      await f.child.prompt("too large");
      await assert.rejects(settled, RpcProtocolError);
    } finally {
      await f.cleanup();
    }
  });
});

test("abort settles a delayed activation", async () => {
  const f = await start("delayed");
  try {
    const settled = f.child.nextSettlement(2_000);
    await f.child.prompt("wait");
    await f.child.abort();
    await settled;
  } finally {
    await f.cleanup();
  }
});

test("dispose escalates when the child ignores SIGTERM", async () => {
  const f = await start("ignore-term", { disposeGraceMs: 50 });
  await f.child.prompt("stay alive");
  const before = Date.now();
  await f.cleanup();
  assert.ok(Date.now() - before < 2_000);
  assert.ok(f.child.process.exitCode !== null || f.child.process.signalCode !== null);
});

test("dispose fails within a bound when neither TERM nor KILL can be delivered", async () => {
  const f = await start("ignore-term", { disposeGraceMs: 30 });
  const pid = f.child.process.pid;
  await f.child.prompt("stay alive");
  f.child.kill = () => {
    throw new Error("signal delivery blocked");
  };
  try {
    const before = Date.now();
    await assert.rejects(f.child.dispose(), /did not exit after SIGKILL.*signal delivery blocked/);
    assert.ok(Date.now() - before < 1_000);
  } finally {
    if (pid) {
      try {
        if (process.platform === "win32") f.child.process.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (f.child.process.exitCode !== null || f.child.process.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("stderr logging refuses symlinks without modifying their target", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-rpc-symlink-"));
  const target = join(root, "target.txt");
  const link = join(root, "stderr.log");
  writeFileSync(target, "DO_NOT_TOUCH", { mode: 0o644 });
  symlinkSync(target, link);
  try {
    await assert.rejects(ManagedRpcChild.start({
      command: process.execPath,
      args: [fixture],
      cwd: root,
      env: { FAKE_RPC_MODE: "normal" },
      stderrPath: link,
    }));
    assert.equal(readFileSync(target, "utf8"), "DO_NOT_TOUCH");
    assert.equal(statSync(target).mode & 0o777, 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stderr artifact and in-memory tail stay bounded", async () => {
  const f = await start("stderr", { stderrFileLimitBytes: 1024, stderrTailBytes: 128 });
  try {
    const settled = f.child.nextSettlement(5_000);
    await f.child.prompt("be noisy");
    await settled;
    assert.ok(statSync(join(f.root, "stderr.log")).size <= 1024);
    assert.ok(Buffer.byteLength(f.child.getStderrTail(), "utf8") <= 128);
    assert.match(readFileSync(join(f.root, "stderr.log"), "utf8"), /stderr truncated/);
  } finally {
    await f.cleanup();
  }
});

test("process-group disposal also terminates a spawned descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-rpc-tree-"));
  const pidPath = join(root, "descendant.pid");
  const child = await ManagedRpcChild.start({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: { FAKE_RPC_MODE: "descendant", FAKE_DESCENDANT_PID: pidPath },
    stderrPath: join(root, "stderr.log"),
    disposeGraceMs: 50,
  });
  try {
    assert.equal(existsSync(pidPath), true);
    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid));
    await child.dispose();
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        if (error?.code === "ESRCH") alive = false;
        else throw error;
      }
    }
    assert.equal(alive, false);
  } finally {
    await child.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
