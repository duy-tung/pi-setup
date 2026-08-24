import { spawn } from "node:child_process";

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

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Never rejects — callers branch on `code`, because git uses exit codes as
 * data. Uses spawn rather than execFile so that commands which only accept
 * their path list on stdin (`checkout-index --stdin -z`) are expressible, and
 * so output is not capped by maxBuffer.
 */
export function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; input?: string | Buffer } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", () =>
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: "failed to spawn git" }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }),
    );
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
export async function targetTrackedFiles(worktree: string): Promise<string[] | null> {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  const r = await runGit(["-C", worktree, "ls-files", "-z"], clean);
  if (r.code !== 0) return null;
  return nulList(r);
}

/**
 * The target's real git dir, resolved the way git resolves it. `<wt>/.git`
 * is a *file* for submodules and linked worktrees (`gitdir: ...`), so statting
 * `<wt>/.git/index` fails there and statting `<wt>/.git` gives an mtime that
 * never changes — which silently disabled reseeding for submodules.
 */
export async function targetGitDir(worktree: string): Promise<string | null> {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  const r = await runGit(["-C", worktree, "rev-parse", "--absolute-git-dir"], clean);
  if (r.code !== 0) return null;
  const p = text(r).trim();
  return p || null;
}

export async function gitAvailable(): Promise<boolean> {
  const r = await runGit(["--version"], { ...process.env });
  return r.code === 0;
}
