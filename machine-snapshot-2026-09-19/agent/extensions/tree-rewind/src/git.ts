import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Keep the user's own git configuration out of the capture path entirely.
 * Their global config may define a git-lfs clean filter, which would replace
 * file contents with pointer text on the way into the shadow store.
 */
export const HERMETIC_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ADVICE: "0",
} as const;

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
export const DEFAULT_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_BYTES = 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Never rejects — callers branch on `code`, because git uses exit codes as
 * data. Uses spawn rather than execFile so commands can receive NUL path lists
 * on stdin. Timeout/output/abort failures use code 124 with empty stdout.
 * Started children settle only on close, even if signalling fails, so callers
 * cannot release a writer's lock while it might still be alive.
 */
export function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; input?: string | Buffer; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
    if (opts.signal?.aborted) {
      resolve({ code: 124, stdout: Buffer.alloc(0), stderr: "git aborted" });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", args, { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: "failed to spawn git" });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const signalChild = (signal: NodeJS.Signals) => {
      try { child.kill(signal); }
      catch {
        // Failed signalling is not proof of exit. Keep the owner waiting for close.
      }
    };
    const stop = (message: string) => {
      if (settled || failure !== undefined) return;
      failure = message;
      // Arm escalation before kill, which can synchronously emit an error.
      forceKill = setTimeout(() => signalChild("SIGKILL"), 1_000);
      forceKill.unref?.();
      signalChild("SIGTERM");
    };
    const onAbort = () => stop("git aborted");
    const timer = setTimeout(() => stop(`git timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        stop(`git stdout exceeded ${maxOutputBytes} bytes`);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      errBytes += chunk.length;
      if (errBytes > STDERR_BYTES) {
        stop(`git stderr exceeded ${STDERR_BYTES} bytes`);
        return;
      }
      err.push(chunk);
    });
    child.on("error", () => {
      if (child.pid === undefined) {
        finish({ code: 127, stdout: Buffer.alloc(0), stderr: "failed to spawn git" });
      } else {
        // A started writer may still be alive after an error (including kill failure).
        stop("git process error");
      }
    });
    child.on("close", (code) =>
      finish(failure === undefined
        ? { code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }
        : { code: 124, stdout: Buffer.alloc(0), stderr: failure }),
    );
    child.stdin.on("error", () => {});
    opts.signal?.addEventListener("abort", onAbort);
    if (opts.signal?.aborted) onAbort();
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function text(r: GitResult): string {
  return r.stdout.toString("utf8");
}

/** Split NUL-delimited git output. */
export function nulList(r: GitResult): string[] {
  return text(r).split("\0").filter(Boolean);
}

/** The target repo's own tracked set, read with a clean env so we never
 *  accidentally query the shadow index instead of theirs. */
export async function targetTrackedFiles(worktree: string, signal?: AbortSignal): Promise<string[] | null> {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  const r = await runGit(["-C", worktree, "ls-files", "-z"], clean, { signal });
  if (r.code !== 0) return null;
  return nulList(r);
}

/**
 * The target's real git dir, resolved the way git resolves it. `<wt>/.git`
 * is a *file* for submodules and linked worktrees (`gitdir: ...`), so statting
 * `<wt>/.git/index` fails there and statting `<wt>/.git` gives an mtime that
 * never changes — which silently disabled reseeding for submodules.
 */
export async function targetGitDir(worktree: string, signal?: AbortSignal): Promise<string | null> {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  const r = await runGit(["-C", worktree, "rev-parse", "--absolute-git-dir"], clean, { signal });
  if (r.code !== 0) return null;
  const p = text(r).trim();
  return p || null;
}

export async function gitAvailable(): Promise<boolean> {
  const r = await runGit(["--version"], { ...process.env });
  return r.code === 0;
}
