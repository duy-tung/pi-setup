#!/usr/bin/env bash
# Verify the repository and its installed Pi configuration without model calls.
set -euo pipefail

NODE_VERSION="24.15.0"
PI_VERSION="0.84.3"
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
    changes="$(rsync -ainc --delete "$src/" "$dst/")" || fail "unable to compare live managed directory: $rel"
    [ -z "$changes" ] || fail "live managed directory differs from repository: $rel"
  else
    [ -f "$dst" ] || fail "live managed path has wrong type: $rel"
    cmp -s "$src" "$dst" || fail "live managed file differs from repository: $rel"
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
  "npm:pi-web-search@1.3.1"
do
  grep -Fxq "  $spec" <<<"$list_output" || fail "pi list is missing exact pinned package: $spec"
done
context7_spec="npm:@upstash/context7-pi@0.1.2"
grep -Fxq "  $context7_spec (filtered)" <<<"$list_output" || fail "pi list is missing exact filtered package: $context7_spec"

oauth_store="$AGENT_DIR/git/github.com/duy-tung/pi-anthropic-oauth-plus"
[ "$(git -C "$oauth_store" rev-parse HEAD 2>/dev/null || true)" = "1996fbbc3f0a8a3d3e36fc4ac4f4d1bb871d5d49" ] || fail "installed OAuth checkout is not the v0.3.2 commit"
[ -z "$(git -C "$oauth_store" status --porcelain --untracked-files=all 2>/dev/null || printf dirty)" ] || fail "installed OAuth checkout has tracked modifications"
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
[ "$installed_versions" = "1.3.1
0.1.2" ] || fail "installed npm package versions do not match settings pins"

printf '%s\n' "==> Running Pi setup tests"
"$MISE" -C / exec "node@$NODE_VERSION" -- node --experimental-strip-types --test "$ROOT"/tests/*.test.mjs

printf '%s\n' "==> Running bundled tree-rewind backend tests"
"$MISE" -C / exec "node@$NODE_VERSION" -- npm --prefix "$ROOT/extensions/tree-rewind" test

git -C "$ROOT" diff --check

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-setup-doctor.XXXXXX")"
smoke_home="$smoke_root/home"
smoke_agent="$smoke_root/agent"
stderr_file="$smoke_root/stderr"
stdout_file="$smoke_root/stdout"
mkdir -p "$smoke_home" "$smoke_agent/extensions" "$smoke_agent/skills" "$smoke_agent/prompts"
rsync -a "$ROOT/extensions/" "$smoke_agent/extensions/"
rsync -a "$ROOT/skills/" "$smoke_agent/skills/"
rsync -a "$ROOT/prompts/" "$smoke_agent/prompts/"
cp "$ROOT/AGENTS.md" "$smoke_agent/AGENTS.md"
cat > "$smoke_agent/extensions/doctor-resource-audit.ts" <<'EOF'
export default function (pi) {
  pi.registerCommand("doctor-resource-audit", {
    description: "Verify isolated resource filtering",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const required = ["resolve-library-id", "query-docs"];
      const missing = required.filter((name) => !active.has(name));
      ctx.ui.notify(missing.length === 0 ? "doctor-context7-tools-active" : `doctor-context7-tools-missing:${missing.join(",")}`, missing.length === 0 ? "info" : "error");
    },
  });
}
EOF
"$MISE" -C / exec "node@$NODE_VERSION" -- node -e '
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const packagePaths = process.argv.slice(3);
settings.packages = [packagePaths[0], packagePaths[1], { source: packagePaths[2], skills: [] }];
delete settings.defaultProvider;
delete settings.defaultModel;
delete settings.enabledModels;
fs.writeFileSync(process.argv[2], `${JSON.stringify(settings, null, 2)}\n`);
' "$ROOT/settings.json" "$smoke_agent/settings.json" "$oauth_store" "$(dirname "$web_meta")" "$(dirname "$context_meta")"
trap 'rm -rf "$smoke_root"' EXIT
"$MISE" --quiet -C / exec "node@$NODE_VERSION" -- env HOME="$smoke_home" PI_CODING_AGENT_DIR="$smoke_agent" PI_OFFLINE=1 pi --no-approve --list-models >"$stdout_file" 2>"$stderr_file" || {
  cat "$stderr_file" >&2
  fail "isolated offline Pi startup failed"
}
if [ -s "$stderr_file" ]; then
  cat "$stderr_file" >&2
  fail "isolated offline Pi startup emitted extension diagnostics"
fi
grep -Fq "provider" "$stdout_file" || fail "isolated offline model listing returned no model table"

commands_stdout="$smoke_root/commands-stdout"
commands_stderr="$smoke_root/commands-stderr"
printf '%s\n' \
  '{"id":"commands","type":"get_commands"}' \
  '{"id":"resources","type":"prompt","message":"/doctor-resource-audit"}' \
  | "$MISE" --quiet -C / exec "node@$NODE_VERSION" -- env HOME="$smoke_home" PI_CODING_AGENT_DIR="$smoke_agent" PI_OFFLINE=1 pi --mode rpc --no-session --no-approve >"$commands_stdout" 2>"$commands_stderr" || {
    cat "$commands_stderr" >&2
    fail "isolated offline command inventory failed"
  }
[ ! -s "$commands_stderr" ] || { cat "$commands_stderr" >&2; fail "isolated command inventory emitted extension diagnostics"; }
grep -Fq '"name":"c7-docs"' "$commands_stdout" || fail "Context7 explicit prompt is missing"
if grep -Fq '"name":"skill:context7-docs"' "$commands_stdout"; then
  fail "Context7 package skill should be filtered out of recurring model context"
fi
grep -Fq '"message":"doctor-context7-tools-active"' "$commands_stdout" || fail "Context7 tools are not active after package skill filtering"

if ! command -v nvim >/dev/null 2>&1; then
  printf '%s\n' "doctor: warning: nvim is configured as externalEditor but is not installed" >&2
fi

printf '%s\n' "Full no-cost Pi setup verification passed."
