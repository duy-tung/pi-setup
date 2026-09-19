// Verify every managed package pin and every checksum-pinned patch target.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packagePatches, verifyOAuthCheckout, verifyPackagePatches } from "./package-patches.mjs";

export const migrationPackages = {
  "pi-web-search": "1.4.0",
  "@upstash/context7-pi": "0.1.2",
  "@juicesharp/rpiv-ask-user-question": "2.9.0",
  "@juicesharp/rpiv-todo": "2.9.0",
  "@tintinweb/pi-subagents": "0.19.0",
  "pi-background-tasks": "2.5.0",
  "pi-zentui": "0.22.3",
  "@juicesharp/rpiv-advisor": "2.9.0",
  "@firstpick/pi-themes-bundle": "0.1.6",
};
const postImages = name => Object.fromEntries(Object.entries(packagePatches.find(p => p.patch === name).targets)
  .map(([file, hashes]) => [file, hashes.after]));
export const activitySha = postImages("pi-subagents-activity.patch")["src/index.ts"];
export const backgroundThemeShas = postImages("pi-background-tasks-theme.patch");

export function verifyMigrationPackages(agentDir) {
  const store = join(agentDir, "npm", "node_modules");
  for (const [name, version] of Object.entries(migrationPackages)) {
    const pkg = JSON.parse(readFileSync(join(store, name, "package.json"), "utf8"));
    if (pkg.version !== version) throw new Error(`Expected ${name}@${version}, found ${pkg.version}`);
  }
  verifyOAuthCheckout(agentDir);
  verifyPackagePatches(agentDir);
}

if (process.argv[1]?.endsWith("/package-health.mjs")) {
  try { verifyMigrationPackages(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
