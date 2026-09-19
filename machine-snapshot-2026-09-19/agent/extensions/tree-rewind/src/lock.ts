import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { runBackend, type BackendLifetime } from "./backend-lifetime.js";

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
 * accidentally remove newly acquired live lock B. Hosted shutdown drains work;
 * standalone signals drain held writers before exit. Forced exit/crash leaves a visible lock that makes
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

// Standalone helpers own process termination. Pi lifetimes explicitly opt out:
// no host signal/exit callback may release a lock before its writer settles.
const HELD = new Map<string, { owner: string; done: Promise<void> }>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let terminating = false;

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
  if (signalHandlers.size) return;
  const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      if (terminating) return;
      terminating = true;
      process.exitCode = exitCodes[signal];
      void Promise.allSettled([...HELD.values()].map(held => held.done)).then(() => process.exit(exitCodes[signal]));
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function uninstallCleanup(): void {
  if (HELD.size > 0) return;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number; // Retained compatibility: never grants stale takeover.
  lifetime?: BackendLifetime;
  /** Cancels acquisition only. The writer owns any in-flight Git cancellation. */
  signal?: AbortSignal;
  /** Cleanup owned by an already-accepted job: admitted after close, never cancelled. */
  compensating?: boolean;
}

export function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  return runBackend(opts.lifetime, () => holdLock(path, fn, opts), { compensating: opts.compensating });
}

async function holdLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions): Promise<T> {
  const queued = opts.compensating ? undefined : opts.lifetime?.queued.signal;
  const signal = opts.signal && queued ? AbortSignal.any([opts.signal, queued]) : opts.signal ?? queued;
  const standalone = !opts.lifetime?.hostManaged;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const owner = randomUUID();

  for (;;) {
    signal?.throwIfAborted();
    if (standalone && terminating) throw new Error("Rewind process is terminating");
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
      if (standalone) {
        HELD.set(path, { owner, done });
        installCleanup();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (timeoutMs <= 0 || Date.now() >= deadline) throw new LockTimeout(path, timeoutMs);
      await sleep(Math.min(25 + Math.random() * 50, Math.max(0, deadline - Date.now())), signal);
    }
  }

  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    releaseOwned(path, owner);
    if (HELD.get(path)?.owner === owner) HELD.delete(path);
    finish();
    if (standalone) uninstallCleanup();
  }
}
