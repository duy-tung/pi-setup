// One pre/post-image registry for installation, health checks and regression tests.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packagePatches = JSON.parse(readFileSync(join(root, "patches/manifest.json"), "utf8"));
export const oauthCommit = "1996fbbc3f0a8a3d3e36fc4ac4f4d1bb871d5d49";
export const oauthPackageDir = "git/github.com/duy-tung/pi-anthropic-oauth-plus";

function segments(rel) {
  const parts = rel.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`Unsafe package patch path: ${rel}`);
  }
  return parts;
}

function digest(agentDir, rel) {
  let path = resolve(agentDir);
  const parts = segments(rel);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) path = join(path, parts[i]);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const leaf = i === parts.length - 1;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Non-regular package patch target: ${rel}`);
    }
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function matchesPatch(agentDir, patch, image) {
  return Object.entries(patch.targets).every(([file, hashes]) =>
    digest(agentDir, `${patch.packageDir}/${file}`) === hashes[image]);
}

export function verifyPackagePatches(agentDir) {
  for (const patch of packagePatches) {
    if (!matchesPatch(agentDir, patch, "after")) throw new Error(`Package patch checksum mismatch: ${patch.patch}`);
  }
}

export function verifyOAuthCheckout(agentDir) {
  const cwd = join(agentDir, oauthPackageDir);
  const git = args => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (git(["rev-parse", "HEAD"]).trim() !== oauthCommit) throw new Error("OAuth checkout is not the pinned v0.3.2 commit");
  const allowed = new Set(Object.keys(packagePatches.find(p => p.packageDir === oauthPackageDir).targets));
  const changed = (git(["diff", "--name-only", "-z", "HEAD"]) + git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  if (changed.some(file => !allowed.has(file))) throw new Error("OAuth checkout has changes outside the pinned patch");
}

// The installer owns the surrounding package-store transaction/rollback. Refuse
// partial or foreign pre-images before invoking patch; an exact post-image is a no-op.
export function applyPackagePatches(agentDir) {
  verifyOAuthCheckout(agentDir);
  const pending = [];
  for (const patch of packagePatches) {
    const patchFile = resolve(root, "patches", patch.patch);
    if (dirname(patchFile) !== join(root, "patches") || !patch.patch.endsWith(".patch")) throw new Error("Unsafe patch filename");
    segments(patch.packageDir);
    const input = readFileSync(patchFile, "utf8");
    const targets = [...input.matchAll(/^\+\+\+ b\/([^\t\r\n]+)/gm)].map(match => match[1]);
    if (JSON.stringify(targets.sort()) !== JSON.stringify(Object.keys(patch.targets).sort())) throw new Error(`Unregistered patch target: ${patch.patch}`);
    if (matchesPatch(agentDir, patch, "after")) continue;
    if (!matchesPatch(agentDir, patch, "before")) throw new Error(`Partial or foreign package pre-image: ${patch.patch}`);
    const targetDir = resolve(agentDir, patch.packageDir);
    if (!targetDir.startsWith(resolve(agentDir) + sep)) throw new Error("Package patch escapes agent directory");
    const args = ["-p1", "-s", "--batch", "--forward", "-d", targetDir];
    execFileSync("patch", [...args, "--dry-run"], { input, stdio: ["pipe", "pipe", "pipe"] });
    pending.push({ patch, args, input });
  }
  for (const { patch, args, input } of pending) {
    execFileSync("patch", args, { input, stdio: ["pipe", "pipe", "pipe"] });
    if (!matchesPatch(agentDir, patch, "after")) throw new Error(`Patched source checksum mismatch: ${patch.patch}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, agentDir] = process.argv.slice(2);
    if (!agentDir || !["--apply", "--check"].includes(action)) throw new Error("Usage: package-patches.mjs --apply|--check <agent-dir>");
    if (action === "--apply") applyPackagePatches(agentDir);
    verifyPackagePatches(agentDir);
    verifyOAuthCheckout(agentDir);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
