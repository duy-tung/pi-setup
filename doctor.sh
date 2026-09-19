#!/usr/bin/env bash
# Verify the repository and its installed Pi configuration without model calls.
set -euo pipefail

NODE_VERSION="24.15.0"
PI_VERSION="0.85.1"
OAUTH_REWRITE_MODE="technical-safe"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
MANIFEST="$ROOT/scripts/managed-paths.txt"
HOME_REAL="$(CDPATH= cd -- "$HOME" && pwd -P)"
PI_ROOT="$HOME_REAL/.pi"
AGENT_DIR="$PI_ROOT/agent"
MODE="full"

usage() {
  printf '%s\n' "Usage: ./doctor.sh [--config-only]"
}

case "${1:-}" in
  "") ;;
  --config-only) MODE="config" ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

fail() {
  printf 'doctor: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this setup is verified only on macOS"
[ ! -L "$PI_ROOT" ] || fail "$PI_ROOT must be a real directory, not a symlink"
[ ! -L "$AGENT_DIR" ] || fail "$AGENT_DIR must be a real directory, not a symlink"
command -v rsync >/dev/null 2>&1 || fail "rsync is not available"
command -v patch >/dev/null 2>&1 || fail "patch is not available"
command -v shasum >/dev/null 2>&1 || fail "shasum is not available"
MISE=""
if [ "$MODE" = "full" ]; then
  MISE="$(command -v mise 2>/dev/null || true)"
  [ -n "$MISE" ] || fail "mise must be on PATH"
  "$MISE" -C / exec "node@$NODE_VERSION" -- node "$ROOT/scripts/audit-repo.mjs"
else
  command -v node >/dev/null 2>&1 || fail "node is not available"
  node "$ROOT/scripts/audit-repo.mjs"
fi

compare_path() {
  rel="$1"
  src="$ROOT/$rel"
  dst="$AGENT_DIR/$rel"
  [ -e "$dst" ] || [ -L "$dst" ] || fail "live managed path is missing: $rel"
  [ ! -L "$dst" ] || fail "live managed path is a non-portable symlink: $rel"
  if [ -d "$src" ]; then
    [ -d "$dst" ] || fail "live managed path has wrong type: $rel"
    # Keep content/type/mode/ownership checks; timestamps are not portable config.
    changes="$(rsync -ainc --delete --out-format='%i' "$src/" "$dst/" | awk '!/^\.[fd]\.\.[tT]\.+$/ && NF')" || fail "unable to compare live managed directory: $rel"
    [ -z "$changes" ] || fail "live managed directory differs from repository: $rel"
  else
    [ -f "$dst" ] || fail "live managed path has wrong type: $rel"
    case "$rel" in
      settings.json|zentui.json)
        if [ "$MODE" = "full" ]; then
          "$MISE" -C / exec "node@$NODE_VERSION" -- node "$ROOT/scripts/json-equal.mjs" "$src" "$dst"
        else
          node "$ROOT/scripts/json-equal.mjs" "$src" "$dst"
        fi || fail "live managed file differs from repository: $rel"
        ;;
      *) cmp -s "$src" "$dst" || fail "live managed file differs from repository: $rel" ;;
    esac
    [ "$(stat -f '%Lp' "$src")" = "$(stat -f '%Lp' "$dst")" ] || fail "live managed file mode differs from repository: $rel"
  fi
}

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  compare_path "$rel"
done < "$MANIFEST"

[ -x "$ROOT/scrub-session-secrets.sh" ] || fail "repository scrub script is not executable"
[ -x "$AGENT_DIR/scrub-session-secrets.sh" ] || fail "live scrub script is not executable"
bash -n "$ROOT/install.sh" "$ROOT/doctor.sh" "$ROOT/sync-from-live.sh" "$ROOT/scrub-session-secrets.sh"

printf '%s\n' "Config audit and live parity passed."
[ "$MODE" = "full" ] || exit 0

node_version="$("$MISE" --quiet -C / exec "node@$NODE_VERSION" -- node --version)"
[ "$node_version" = "v$NODE_VERSION" ] || fail "expected Node v$NODE_VERSION, got $node_version"
pi_version="$("$MISE" --quiet -C / exec "node@$NODE_VERSION" -- pi --version)"
[ "$pi_version" = "$PI_VERSION" ] || fail "expected Pi $PI_VERSION, got $pi_version"
cache_value="$(env -u PI_CACHE_RETENTION "$MISE" --quiet -C / exec "node@$NODE_VERSION" -- sh -c 'printf %s "${PI_CACHE_RETENTION-}"')"
[ "$cache_value" = "long" ] || fail "global mise environment does not set PI_CACHE_RETENTION=long"
rewrite_value="$(env -u PI_ANTHROPIC_OAUTH_REWRITE_MODE "$MISE" --quiet -C / exec "node@$NODE_VERSION" -- sh -c 'printf %s "${PI_ANTHROPIC_OAUTH_REWRITE_MODE-}"')"
[ "$rewrite_value" = "$OAUTH_REWRITE_MODE" ] || fail "global mise environment does not set PI_ANTHROPIC_OAUTH_REWRITE_MODE=$OAUTH_REWRITE_MODE"

list_output="$("$MISE" --quiet -C / exec "node@$NODE_VERSION" -- pi list)"
for spec in \
  "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2" \
  "npm:pi-web-search@1.4.0" \
  "npm:pi-zentui@0.22.3" \
  "npm:@firstpick/pi-themes-bundle@0.1.6"
do
  grep -Fxq "  $spec" <<<"$list_output" || fail "pi list is missing exact pinned package: $spec"
done
context7_spec="npm:@upstash/context7-pi@0.1.2"
grep -Fxq "  $context7_spec" <<<"$list_output" || fail "pi list is missing exact unfiltered package: $context7_spec"

oauth_store="$AGENT_DIR/git/github.com/duy-tung/pi-anthropic-oauth-plus"
# Known patch changes are required; all other tracked/untracked changes are rejected.
"$MISE" -C / exec "node@$NODE_VERSION" -- node "$ROOT/scripts/package-health.mjs" "$AGENT_DIR" \
  || fail "installed package pins or patch images differ; review before rerunning ./install.sh"
rewrite_probe="$(env -u PI_ANTHROPIC_OAUTH_REWRITE_MODE "$MISE" --quiet -C / exec "node@$NODE_VERSION" -- node --experimental-strip-types --input-type=module -e '
import { pathToFileURL } from "node:url";
const { sanitizeSystemText } = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(sanitizeSystemText("Pi uses /tmp/example/pi-setup and ~/.pi/agent."));
' "$oauth_store/src/prompt.ts")" || fail "unable to probe installed OAuth prompt rewrite"
[ "$rewrite_probe" = "Claude Code uses /tmp/example/pi-setup and ~/.pi/agent." ] || fail "OAuth prompt rewrite does not preserve technical paths under $OAUTH_REWRITE_MODE mode"
web_meta="$AGENT_DIR/npm/node_modules/pi-web-search/package.json"
context_meta="$AGENT_DIR/npm/node_modules/@upstash/context7-pi/package.json"
installed_versions="$("$MISE" -C / exec "node@$NODE_VERSION" -- node -e '
const fs = require("node:fs");
for (const p of process.argv.slice(1)) process.stdout.write(`${JSON.parse(fs.readFileSync(p, "utf8")).version}\n`);
' "$web_meta" "$context_meta")" || fail "unable to read installed npm package metadata"
[ "$installed_versions" = "1.4.0
0.1.2" ] || fail "installed npm package versions do not match settings pins"

printf '%s\n' "==> Running Pi setup tests"
"$MISE" -C / exec "node@$NODE_VERSION" -- node --experimental-strip-types --import "$ROOT/extensions/tree-rewind/spike/register.mjs" --test "$ROOT"/tests/*.test.mjs

printf '%s\n' "==> Running bundled tree-rewind backend tests"
"$MISE" -C / exec "node@$NODE_VERSION" -- npm --prefix "$ROOT/extensions/tree-rewind" test

git -C "$ROOT" diff --check

"$MISE" -C / exec "node@$NODE_VERSION" -- node "$ROOT/scripts/package-smoke.mjs" "$AGENT_DIR"

# tests/patched-packages-typecheck.test.mjs compiles every patched package against
# the installed Pi types, which is what catches a patch that deletes a helper and
# leaves a call behind. Without a compiler that gate skips, so say so out loud.
if ! "$MISE" -C / exec "node@$NODE_VERSION" -- node -e '
const { createRequire } = require("node:module");
for (const dir of [process.argv[1], process.argv[2], process.argv[2] + "/git/github.com/duy-tung/pi-anthropic-oauth-plus", process.argv[2] + "/local-packages/pi-anthropic-oauth-plus"]) {
  try { createRequire(dir + "/noop.js").resolve("typescript/bin/tsc"); process.exit(0); } catch {}
}
process.exit(process.env.PI_SETUP_TSC ? 0 : 1);
' "$ROOT" "$AGENT_DIR" >/dev/null 2>&1; then
  printf '%s\n' "doctor: warning: no TypeScript compiler found, so the patched-package typecheck gate was skipped; set PI_SETUP_TSC to enforce it" >&2
fi

if ! command -v nvim >/dev/null 2>&1; then
  printf '%s\n' "doctor: warning: nvim is configured as externalEditor but is not installed" >&2
fi

printf '%s\n' "Full no-cost Pi setup verification passed."
