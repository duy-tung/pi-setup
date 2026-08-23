import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_LINE_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;
const DEFAULT_STDERR_FILE_BYTES = 1024 * 1024;
const DEFAULT_DISPOSE_GRACE_MS = 5_000;
const STDERR_TRUNCATED = "\n[stderr truncated by Pi subagent RPC transport]\n";
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

export type RpcObject = Record<string, unknown>;
export type RpcEvent = RpcObject & { type?: string };

export interface RpcSessionState {
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  pendingMessageCount: number;
}

export interface ManagedRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stderrPath: string;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  lineLimitBytes?: number;
  stderrTailBytes?: number;
  stderrFileLimitBytes?: number;
  disposeGraceMs?: number;
}

export interface RpcProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class RpcProtocolError extends Error {}
export class RpcCommandError extends Error {}
export class RpcProcessExitError extends Error {
  readonly exit: RpcProcessExit;

  constructor(exit: RpcProcessExit) {
    super(`Pi RPC child exited before settlement (code=${String(exit.code)}, signal=${String(exit.signal)})`);
    this.exit = exit;
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: RpcObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is RpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RpcAssistantSnapshot {
  text: string | null;
  stopReason?: string;
  errorMessage?: string;
  tokens?: number;
  cost?: number;
}

export function assistantSnapshotFromRpcEvent(event: unknown): RpcAssistantSnapshot | undefined {
  if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
    return undefined;
  }
  const content = Array.isArray(event.message.content) ? event.message.content : [];
  const text = content
    .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const usage = isRecord(event.message.usage) ? event.message.usage : undefined;
  const cost = usage && isRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : undefined;
  return {
    text: text || null,
    ...(typeof event.message.stopReason === "string" ? { stopReason: event.message.stopReason } : {}),
    ...(typeof event.message.errorMessage === "string" ? { errorMessage: event.message.errorMessage } : {}),
    ...(usage && typeof usage.totalTokens === "number" ? { tokens: usage.totalTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * One managed Pi `--mode rpc` process. The process is an activation cache; its
 * session file is the durable conversation.
 */
export class ManagedRpcChild {
  readonly process: ChildProcessWithoutNullStreams;

  private readonly options: Required<Pick<ManagedRpcOptions,
    "commandTimeoutMs" | "lineLimitBytes" | "stderrTailBytes" | "stderrFileLimitBytes" | "disposeGraceMs"
  >>;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private stderrFd: number | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private stderrFileBytes = 0;
  private stderrFileTruncated = false;
  private requestSerial = 0;
  private fatalError: Error | undefined;
  private fatalResolve!: (error: Error) => void;
  private readonly fatalPromise: Promise<Error>;
  private exitResolve!: (exit: RpcProcessExit) => void;
  private readonly exitPromise: Promise<RpcProcessExit>;
  private disposing: Promise<void> | undefined;

  private constructor(options: ManagedRpcOptions) {
    this.options = {
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      lineLimitBytes: options.lineLimitBytes ?? DEFAULT_LINE_LIMIT_BYTES,
      stderrTailBytes: options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
      stderrFileLimitBytes: options.stderrFileLimitBytes ?? DEFAULT_STDERR_FILE_BYTES,
      disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    };

    mkdirSync(dirname(options.stderrPath), { recursive: true, mode: 0o700 });
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new Error("Pi RPC stderr logging requires O_NOFOLLOW support");
    }
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
    const fd = openSync(options.stderrPath, flags, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Pi RPC stderr path is not a regular file");
      fchmodSync(fd, 0o600);
      this.stderrFd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.fatalPromise = new Promise((resolve) => {
      this.fatalResolve = resolve;
    });
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    const command = process.platform === "win32" ? options.command : "/bin/sh";
    const args = process.platform === "win32"
      ? options.args
      : ["-c", "umask 077; exec \"$@\"", "pi-subagent", options.command, ...options.args];

    try {
      this.process = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      });
    } catch (error) {
      this.closeStderr();
      throw error;
    }

    this.process.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => this.consumeStderr(chunk));
    this.process.once("error", (error) => this.fail(new Error(`Failed to start Pi RPC child: ${error.message}`)));
    this.process.once("close", (code, signal) => {
      const exit = { code, signal };
      this.exitResolve(exit);
      this.rejectPending(new RpcProcessExitError(exit));
    });
    this.process.stdin.on("error", (error) => this.fail(new Error(`Pi RPC stdin failed: ${error.message}`)));
  }

  static async start(options: ManagedRpcOptions): Promise<ManagedRpcChild> {
    const child = new ManagedRpcChild(options);
    const abort = () => {
      void child.dispose().catch(() => {});
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) throw new Error("Pi RPC startup was aborted");
      await child.waitForSpawn();
      if (options.signal?.aborted) throw new Error("Pi RPC startup was aborted");
      await child.getState();
      if (options.signal?.aborted) throw new Error("Pi RPC startup was aborted");
      return child;
    } catch (error) {
      await child.dispose();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  getStderrTail(): string {
    return this.stderrTail.toString("utf8");
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(message: string): Promise<RpcObject> {
    return this.send({ type: "prompt", message });
  }

  followUp(message: string): Promise<RpcObject> {
    return this.send({ type: "follow_up", message });
  }

  steer(message: string): Promise<RpcObject> {
    return this.send({ type: "steer", message });
  }

  abort(): Promise<RpcObject> {
    return this.send({ type: "abort" }, Math.max(this.options.commandTimeoutMs, 60_000));
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: "get_state" });
    if (!isRecord(response.data)) throw new RpcProtocolError("Pi RPC get_state returned no data object");
    return response.data as unknown as RpcSessionState;
  }

  async getLastAssistantText(): Promise<string | null> {
    const response = await this.send({ type: "get_last_assistant_text" });
    if (!isRecord(response.data)) throw new RpcProtocolError("Pi RPC get_last_assistant_text returned no data object");
    const text = response.data.text;
    if (text !== null && typeof text !== "string") {
      throw new RpcProtocolError("Pi RPC get_last_assistant_text returned an invalid text value");
    }
    return text;
  }

  async getSessionStats(): Promise<RpcObject | undefined> {
    const response = await this.send({ type: "get_session_stats" });
    return isRecord(response.data) ? response.data : undefined;
  }

  /** Wait for the next authoritative `agent_settled` event. */
  nextSettlement(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return Promise.reject(new RpcProcessExitError({ code: this.process.exitCode, signal: this.process.signalCode }));
    }

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_settled") finish();
      });
      const timer = setTimeout(
        () => finish(new Error(`Pi RPC child did not settle within ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
      const onAbort = () => finish(new Error("Pi RPC settlement wait was aborted"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      void this.exitPromise.then((exit) => finish(new RpcProcessExitError(exit)));
      void this.fatalPromise.then((error) => finish(error));
    });
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.disposeInner();
    return this.disposing;
  }

  private async waitForSpawn(): Promise<void> {
    if (this.process.pid !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.process.off("spawn", onSpawn);
        this.process.off("error", onError);
      };
      this.process.once("spawn", onSpawn);
      this.process.once("error", onError);
    });
  }

  private writeStderr(buffer: Buffer): void {
    const fd = this.stderrFd;
    if (fd === undefined) throw new Error("Pi RPC stderr file is closed");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error("Pi RPC stderr write made no progress");
      offset += written;
    }
  }

  private closeStderr(): void {
    const fd = this.stderrFd;
    if (fd === undefined) return;
    this.stderrFd = undefined;
    closeSync(fd);
  }

  private consumeStderr(chunk: Buffer): void {
    const tailLimit = this.options.stderrTailBytes;
    if (tailLimit <= 0) {
      this.stderrTail = Buffer.alloc(0);
    } else if (chunk.length >= tailLimit) {
      this.stderrTail = Buffer.from(chunk.subarray(chunk.length - tailLimit));
    } else {
      const oldBudget = tailLimit - chunk.length;
      const oldTail = this.stderrTail.length > oldBudget
        ? this.stderrTail.subarray(this.stderrTail.length - oldBudget)
        : this.stderrTail;
      this.stderrTail = Buffer.concat([oldTail, chunk], oldTail.length + chunk.length);
    }

    if (this.stderrFileTruncated) return;
    try {
      const marker = Buffer.from(STDERR_TRUNCATED, "utf8");
      const payloadLimit = Math.max(0, this.options.stderrFileLimitBytes - marker.length);
      const remaining = Math.max(0, payloadLimit - this.stderrFileBytes);
      const payload = chunk.subarray(0, Math.min(chunk.length, remaining));
      if (payload.length > 0) {
        this.writeStderr(payload);
        this.stderrFileBytes += payload.length;
      }
      if (payload.length < chunk.length) {
        const markerRoom = Math.max(0, this.options.stderrFileLimitBytes - this.stderrFileBytes);
        const boundedMarker = marker.subarray(0, markerRoom);
        if (boundedMarker.length > 0) {
          this.writeStderr(boundedMarker);
          this.stderrFileBytes += boundedMarker.length;
        }
        this.stderrFileTruncated = true;
      }
    } catch (error) {
      this.fail(new Error(`Pi RPC stderr log failed: ${asError(error).message}`));
    }
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.fatalError) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.options.lineLimitBytes) {
        this.fail(new RpcProtocolError(`Pi RPC record exceeded ${this.options.lineLimitBytes} bytes`));
        return;
      }
      if (line.length === 0) continue;
      try {
        this.handleRecord(JSON.parse(decoder.decode(line)));
      } catch (error) {
        this.fail(new RpcProtocolError(`Invalid Pi RPC JSON record: ${asError(error).message}`));
        return;
      }
    }
    if (this.stdoutBuffer.length > this.options.lineLimitBytes) {
      this.fail(new RpcProtocolError(`Pi RPC record exceeded ${this.options.lineLimitBytes} bytes`));
    }
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value)) throw new RpcProtocolError("Pi RPC record was not an object");

    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.success === true) pending.resolve(value);
      else pending.reject(new RpcCommandError(
        typeof value.error === "string" ? value.error : `Pi RPC ${pending.command} failed`,
      ));
      return;
    }

    if (
      value.type === "extension_ui_request"
      && typeof value.id === "string"
      && typeof value.method === "string"
      && DIALOG_METHODS.has(value.method)
    ) {
      void this.writeRecord({ type: "extension_ui_response", id: value.id, cancelled: true }).catch((error) => {
        this.fail(asError(error));
      });
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // One observer cannot corrupt the protocol or starve peer observers.
      }
    }
  }

  private send(command: RpcObject, timeoutMs = this.options.commandTimeoutMs): Promise<RpcObject> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.process.stdin.writable || this.process.stdin.destroyed) {
      return Promise.reject(new Error("Pi RPC stdin is not writable"));
    }

    const id = `rpc_${++this.requestSerial}`;
    const type = typeof command.type === "string" ? command.type : "command";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC ${type} response`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { command: type, resolve, reject, timer });
      void this.writeRecord({ ...command, id }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(asError(error));
      });
    });
  }

  private writeRecord(value: RpcObject): Promise<void> {
    return new Promise((resolve, reject) => {
      const line = `${JSON.stringify(value)}\n`;
      this.process.stdin.write(line, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.fatalResolve(error);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.process.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") this.process.kill(signal);
      else process.kill(-pid, signal);
    } catch (error: any) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  private async disposeInner(): Promise<void> {
    this.rejectPending(new Error("Pi RPC child disposed"));
    this.listeners.clear();
    const waitForExit = () => Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.options.disposeGraceMs);
        timer.unref?.();
      }),
    ]);

    try {
      if (this.process.exitCode === null && this.process.signalCode === null) {
        try {
          this.kill("SIGTERM");
        } catch {
          // The exit observer remains authoritative; escalate after the grace period.
        }
        const exited = await waitForExit();
        if (!exited && this.process.exitCode === null && this.process.signalCode === null) {
          let killError: Error | undefined;
          try {
            this.kill("SIGKILL");
          } catch (error) {
            killError = asError(error);
          }
          const killed = await waitForExit();
          if (!killed && this.process.exitCode === null && this.process.signalCode === null) {
            throw new Error(
              `Pi RPC child did not exit after SIGKILL${killError ? `: ${killError.message}` : ""}`,
            );
          }
        }
      }
    } finally {
      this.process.stdin.destroy();
      this.closeStderr();
    }
  }
}
