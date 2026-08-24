import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/**
 * Cross-process advisory lock for a shadow store.
 *
 * Two pi sessions in the same directory shadow the same worktree, so sharing
 * the index is correct — but git serialises index writes with index.lock, and
 * a losing writer just fails. Measured without this: two processes taking 8
 * checkpoints each lost 13 of 16, silently. Snapshots take ~200 ms even on the
 * linux kernel, so serialising them costs nothing worth measuring.
 *
 * There is deliberately no automatic stale-lock takeover. POSIX has no
 * compare-and-unlink operation: a contender can judge dead lock A stale, then
 * accidentally remove newly acquired live lock B. Normal exits and catchable
 * termination signals clean up; SIGKILL/crash leaves a visible lock that makes
 * later operations fail closed until the user confirms no session owns it and
 * removes that exact path.
 */

export class LockTimeout extends Error {
  constructor(path: string, ms: number) {
    super(
      `another pi session still owns the rewind lock (${path}, waited ${ms}ms). ` +
        "If no Pi session is using this project, remove that exact lock file manually and retry.",
    );
    this.name = "LockTimeout";
  }
}

interface LockInfo {
  pid: number;
  host: string;
  time: number;
  owner: string;
}

const HELD = new Map<string, string>();
let exitHandler: (() => void) | null = null;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function readInfo(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

function releaseOwned(path: string, owner: string): void {
  if (readInfo(path)?.owner !== owner) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

function installCleanup(): void {
  if (exitHandler) return;
  const release = () => {
    for (const [path, owner] of HELD) releaseOwned(path, owner);
    HELD.clear();
  };
  exitHandler = release;
  process.once("exit", exitHandler);
  const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      release();
      process.exit(exitCodes[signal]);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function uninstallCleanup(): void {
  if (HELD.size > 0 || !exitHandler) return;
  process.off("exit", exitHandler);
  exitHandler = null;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const owner = randomUUID();

  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), time: Date.now(), owner } satisfies LockInfo));
      } catch (error) {
        closeSync(fd);
        rmSync(path, { force: true });
        throw error;
      }
      closeSync(fd);
      HELD.set(path, owner);
      installCleanup();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new LockTimeout(path, timeoutMs);
      await sleep(25 + Math.random() * 50);
    }
  }

  try {
    return await fn();
  } finally {
    if (HELD.get(path) === owner) HELD.delete(path);
    releaseOwned(path, owner);
    uninstallCleanup();
  }
}
