/**
 * Where this extension is allowed to take checkpoints.
 *
 * A checkpoint is `git add -A` over the whole cwd. In a project that is exactly
 * what you want; in `~` it is a shadow copy of `.ssh`, `.aws` and `Library`, and
 * the user finds out when the store is 40 GB. Loading globally is the ergonomic
 * choice — you never think about installing it — so the cost of that choice is
 * paid here: decide per directory, refuse by default, and say why.
 *
 * Refusing is safe. `beginWorkspace` records the reason, the status line shows
 * "rewind off (reason)", and every prompt in that session is honestly declared
 * unprotected instead of being half-covered.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, sep } from "node:path";

export type Eligibility = { ok: true } | { ok: false; reason: string };

/**
 * A directory a human would call "a project". Marker files, not heuristics on
 * size: a fresh repo with two files is protectable, and a 200k-file download
 * folder is not, and neither of those is about file count.
 */
const MARKERS = [
  ".git",
  ".hg",
  ".svn",
  ".pi",
  "package.json",
  "deno.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "mix.exs",
  "Makefile",
  "CMakeLists.txt",
  "flake.nix",
];

/**
 * Off for the directory and everything below it. Some of these are git repos on
 * purpose (a dotfiles checkout under ~/.config), which is exactly the case where
 * a marker check alone would wave the secrets through.
 */
const NEVER_TREE = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".pi",
  ".claude",
  "Library",
];

/**
 * Off for the directory itself only. People really do keep projects in Desktop
 * and Documents; what must never happen is snapshotting the container, which is
 * a pile of unrelated files that happens to contain one.
 */
const NEVER_SELF = ["Downloads", "Desktop", "Documents", "Movies", "Music", "Pictures", "Public"];

/**
 * Absolute paths that are never worth snapshotting: kernel interfaces, not
 * files. Hashing `/proc/self/mem` is not a coverage gap worth having.
 */
const NEVER_ABS = ["/dev", "/proc", "/sys"];

/**
 * Names whose contents are credentials often enough that the right default is
 * "do not copy this into a store that outlives the session". The user can
 * still edit these files; rewind simply does not keep a copy.
 */
const SECRETISH = [
  /^\.env(\..+)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_[a-z0-9_]+$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^credentials?(\.(json|ya?ml|toml|ini))?$/i,
];

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * `realpath` for a path that may not exist yet: resolve the deepest ancestor
 * that does, then re-attach the rest literally.
 *
 * This is the whole defence against alias paths. `~/.Claude Code` is a symlink
 * to `~/.pi` on this machine, and a string check for `~/.pi` waves
 * `~/.Claude Code/agent/auth.json` straight through. Resolving first means the
 * deny list is matched against the file, not against the spelling.
 */
export function resolveExisting(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(cur)) return tail.length ? join(real(cur), ...tail) : real(cur);
    const parent = dirname(cur);
    if (parent === cur) return tail.length ? join(cur, ...tail) : cur;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/** Not a refusal: the shadow repo already covers it. */
export const INSIDE_PROJECT = "inside the project";

export type PathVerdict = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Whether a single file outside the project may be snapshotted. The directory
 * rules of `checkEligible` do not transfer: this is one named file the agent is
 * about to write, not a tree we are about to stage, so the question is only
 * "would keeping a copy of this file be a mistake".
 *
 * `cwd` is null where there is no project at all (pi started in `~`). Then
 * nothing is "inside", every edited file is a candidate, and this list is the
 * only thing standing between the agent and a copy of your keys.
 */
export function checkTrackablePath(abs: string, cwd: string | null): PathVerdict {
  const path = resolveExisting(abs);
  const home = real(homedir());

  if (cwd !== null && isInside(real(cwd), path)) return { ok: false, reason: INSIDE_PROJECT };

  for (const p of NEVER_ABS) {
    if (isInside(p, path)) return { ok: false, reason: `inside ${p}` };
  }
  for (const name of NEVER_TREE) {
    if (isInside(join(home, name), path)) return { ok: false, reason: `inside ~/${name}` };
  }

  const name = basename(path);
  if (SECRETISH.some((re) => re.test(name))) {
    return { ok: false, reason: "looks like a credential file" };
  }

  return { ok: true, path };
}

const isInside = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent + sep);

export function checkEligible(cwd: string): Eligibility {
  // An explicit opt-in beats every rule below, including the home directory:
  // a bare dotfiles repo checked out at ~ is a real setup, and someone running
  // with this set has already answered the question this file exists to ask.
  if (process.env.PI_REWIND_FORCE === "1") return { ok: true };

  const dir = real(cwd);
  const home = real(homedir());

  if (dir === parse(dir).root) return { ok: false, reason: "filesystem root" };
  if (dir === home) return { ok: false, reason: "home directory" };
  // /Users, /home, / — anything containing the home directory is far too broad
  // to snapshot, marker or not.
  if (isInside(dir, home)) return { ok: false, reason: "contains your home directory" };

  for (const name of NEVER_TREE) {
    if (isInside(join(home, name), dir)) return { ok: false, reason: `inside ~/${name}` };
  }
  for (const name of NEVER_SELF) {
    if (dir === join(home, name)) return { ok: false, reason: `~/${name} itself` };
  }

  if (!MARKERS.some((m) => existsSync(join(dir, m)))) {
    return { ok: false, reason: "not a project directory" };
  }

  return { ok: true };
}
