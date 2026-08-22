import { lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

const HOME = canonicalExisting(homedir());
const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const MAX_SYMLINK_DEPTH = 40;

export type ResolvedPolicyPath = {
  requested: string;
  lexical: string;
  canonical: string;
};

export type PolicyHit = { id: string; what: string };
export type PathAccessRule = { path: string; kind: "literal" | "subpath" };

const SENSITIVE_TREES: { path: string; what: string }[] = [
  [".ssh", "SSH credentials"],
  [".aws", "AWS credentials"],
  [".gnupg", "GnuPG keys"],
  [".kube", "kubeconfig"],
  [".docker", "Docker credentials"],
  [join(".config", "gcloud"), "gcloud credentials"],
  [join(".config", "gh"), "GitHub CLI credentials"],
].map(([path, what]) => ({ path: canonicalOrMissing(join(HOME, path)), what }));

const SENSITIVE_FILES: { path: string; what: string }[] = [
  [join(HOME, ".pi", "agent", "auth.json"), "Pi authentication store"],
  [join(HOME, ".pi", "agent", "scrub-backups.txt"), "secret scrub backup list"],
  [join(HOME, ".netrc"), ".netrc credentials"],
  [join(HOME, ".npmrc"), "npm credentials"],
  [join(HOME, ".pypirc"), "Python package credentials"],
  [join(HOME, ".pgpass"), "PostgreSQL credentials"],
  [join(HOME, ".git-credentials"), "Git credentials"],
].map(([path, what]) => ({ path: canonicalOrMissing(path), what }));

const SENSITIVE_NAMES: { re: RegExp; what: string }[] = [
  { re: /^\.env(?!\.(?:example|sample|template|dist)$)(?:\..+)?$/i, what: "environment secret file" },
  { re: /^id_(?:rsa|dsa|ecdsa|ed25519)$/i, what: "private key" },
  { re: /\.(?:pem|p12|pfx|keystore|jks|key)$/i, what: "key material" },
  { re: /^credentials?(?:\.(?:json|ya?ml|toml|ini))?$/i, what: "credential file" },
];

const GLOBAL_PROTECTED_WRITES: { path: string; what: string }[] = [
  [join(HOME, ".pi", "agent", "settings.json"), "global Pi settings"],
  [join(HOME, ".pi", "agent", "trust.json"), "Pi trust policy"],
  [join(HOME, ".pi", "agent", "extensions"), "global Pi extensions"],
  [join(HOME, ".pi", "agent", "skills"), "global Pi skills"],
  [join(HOME, ".pi", "agent", "prompts"), "global Pi prompts"],
  [join(HOME, ".zshrc"), "shell startup file"],
  [join(HOME, ".bashrc"), "shell startup file"],
  [join(HOME, ".bash_profile"), "shell startup file"],
  [join(HOME, ".profile"), "shell startup file"],
  [join(HOME, ".gitconfig"), "global Git configuration"],
].map(([path, what]) => ({ path: canonicalOrMissing(path), what }));

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function missing(error: unknown): boolean {
  return MISSING.has(codeOf(error) ?? "");
}

function canonicalExisting(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

/** Resolve existing paths, dangling final links, and missing suffixes to filesystem identity. */
function canonicalOrMissing(path: string, seen = new Set<string>()): string {
  const lexical = normalize(path);
  if (seen.size > MAX_SYMLINK_DEPTH || seen.has(lexical)) {
    throw new Error(`path-policy: symlink loop while resolving ${path}`);
  }
  seen.add(lexical);

  try {
    return realpathSync.native(lexical);
  } catch (error: unknown) {
    if (!missing(error)) throw error;
  }

  try {
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(lexical);
      const target = isAbsolute(link) ? link : resolve(dirname(lexical), link);
      return canonicalOrMissing(target, seen);
    }
  } catch (error: unknown) {
    if (!missing(error)) throw error;
  }

  const parent = dirname(lexical);
  if (parent === lexical) return lexical;
  return join(canonicalOrMissing(parent, seen), basename(lexical));
}

export function resolvePolicyPath(input: string, cwd: string): ResolvedPolicyPath {
  const expanded = input.replace(/^~(?=\/|$)/, HOME);
  const lexical = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  return { requested: input, lexical, canonical: canonicalOrMissing(lexical) };
}

export function isUnder(path: string, root: string): boolean {
  const candidate = normalize(path);
  const parent = normalize(root);
  return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function sensitivePath(path: string): PolicyHit | undefined {
  const canonical = canonicalOrMissing(path);
  for (const item of SENSITIVE_TREES) {
    if (isUnder(canonical, item.path)) return { id: "sensitive-path", what: item.what };
  }
  for (const item of SENSITIVE_FILES) {
    if (canonical === item.path) return { id: "sensitive-path", what: item.what };
  }
  const name = basename(canonical);
  const privatePiRoot = canonicalOrMissing(join(HOME, ".pi"));
  if (name.endsWith(".bak") && (isUnder(canonical, privatePiRoot) || canonical.includes(`${sep}.pi${sep}agents${sep}`))) {
    return { id: "sensitive-path", what: "secret scrub backup" };
  }
  const named = SENSITIVE_NAMES.find((item) => item.re.test(name));
  return named ? { id: "sensitive-path", what: named.what } : undefined;
}

export function protectedWrite(path: string, workspaceRoot: string): PolicyHit | undefined {
  const canonical = canonicalOrMissing(path);
  for (const item of GLOBAL_PROTECTED_WRITES) {
    if (canonical === item.path || isUnder(canonical, item.path)) {
      return { id: "protected-write", what: item.what };
    }
  }

  const root = canonicalOrMissing(workspaceRoot);
  const projectItems: { path: string; what: string }[] = [
    { path: join(root, ".pi"), what: "project Pi configuration" },
    { path: join(root, ".agents"), what: "project agent configuration" },
    { path: join(root, ".git", "config"), what: "repository Git configuration" },
    { path: join(root, ".git", "hooks"), what: "repository Git hooks" },
  ];
  for (const item of projectItems) {
    const protectedPath = canonicalOrMissing(item.path);
    if (canonical === protectedPath || isUnder(canonical, protectedPath)) {
      return { id: "protected-write", what: item.what };
    }
  }
  return undefined;
}

export function isTemporary(path: string): boolean {
  const canonical = canonicalOrMissing(path);
  return isUnder(canonical, canonicalExisting("/tmp")) || isUnder(canonical, canonicalExisting(tmpdir()));
}

export function isUnsafeWorkspaceRoot(path: string): boolean {
  const root = canonicalOrMissing(path);
  return root === sep || root === HOME || isUnder(HOME, root);
}

export function sensitiveReadRules(workspaceRoot: string): PathAccessRule[] {
  const rules: PathAccessRule[] = [
    ...SENSITIVE_TREES.map((item) => ({ path: item.path, kind: "subpath" as const })),
    ...SENSITIVE_FILES.map((item) => ({ path: item.path, kind: "literal" as const })),
  ];
  const root = canonicalOrMissing(workspaceRoot);
  try {
    for (const name of readdirSync(root)) {
      if (SENSITIVE_NAMES.some((item) => item.re.test(name))) {
        rules.push({ path: canonicalOrMissing(join(root, name)), kind: "literal" });
      }
    }
  } catch {
    // An unreadable workspace is handled by the Bash tool itself.
  }
  return rules;
}

export function protectedWriteRules(workspaceRoot: string): PathAccessRule[] {
  const directoryNames = new Set(["extensions", "skills", "prompts"]);
  const rules: PathAccessRule[] = GLOBAL_PROTECTED_WRITES.map((item) => ({
    path: item.path,
    kind: directoryNames.has(basename(item.path)) ? "subpath" : "literal",
  }));
  const root = canonicalOrMissing(workspaceRoot);
  rules.push(
    { path: canonicalOrMissing(join(root, ".pi")), kind: "subpath" },
    { path: canonicalOrMissing(join(root, ".agents")), kind: "subpath" },
    { path: canonicalOrMissing(join(root, ".git", "config")), kind: "literal" },
    { path: canonicalOrMissing(join(root, ".git", "hooks")), kind: "subpath" },
  );
  return rules;
}

export function homePath(): string {
  return HOME;
}
