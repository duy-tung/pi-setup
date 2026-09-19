#!/usr/bin/env bash
# Reproduce this repository's managed Pi configuration on macOS.
set -euo pipefail
umask 077

NODE_VERSION="24.15.0"
PI_PACKAGE="@earendil-works/pi-coding-agent"
PI_VERSION="0.85.1"
OAUTH_REWRITE_MODE="technical-safe"
BACKUP_RETENTION_DAYS=30
BACKUP_MARKER=".pi-setup-managed-backup-v1"
BACKUP_MARKER_VALUE="pi-setup-managed-config-backup-v1"

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
MANIFEST="$ROOT/scripts/managed-paths.txt"
HOME_REAL="$(CDPATH= cd -- "$HOME" && pwd -P)"
PI_ROOT="$HOME_REAL/.pi"
AGENT_DIR="$PI_ROOT/agent"
STATE_DIR="$HOME_REAL/.local/state/pi-setup"
if [ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ]; then
  MISE_CONFIG="$MISE_GLOBAL_CONFIG_FILE"
elif [ -n "${MISE_CONFIG_DIR:-}" ]; then
  MISE_CONFIG="${MISE_CONFIG_DIR%/}/config.toml"
else
  MISE_CONFIG="${XDG_CONFIG_HOME:-$HOME_REAL/.config}/mise/config.toml"
fi
MODE="full"
MISE=""
STAGE=""
BACKUP=""
RUNTIME_BACKUP=""
PI_PREVIOUS_VERSION=""
PI_WAS_PRESENT=0
CONFIG_ROLLBACK_NEEDED=0
RUNTIME_ROLLBACK_NEEDED=0
PACKAGE_ROLLBACK_NEEDED=0
FINISHING=0
SIGNAL_DURING_FINISH=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--config-only]

Without arguments, pin Node and Pi through mise, apply the managed config,
install pinned Pi packages, and run the full doctor. --config-only only applies
and validates repository-managed config; it performs no package/network work.
EOF
}

die() {
  printf 'pi-setup: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  "") ;;
  --config-only) MODE="config" ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is verified on macOS only"
[ ! -L "$PI_ROOT" ] || die "$PI_ROOT must be a real directory, not a symlink"
[ ! -L "$AGENT_DIR" ] || die "$AGENT_DIR must be a real directory, not a symlink"
[ -f "$MANIFEST" ] || die "missing managed-path manifest: $MANIFEST"
command -v git >/dev/null 2>&1 || die "git is required"
command -v rsync >/dev/null 2>&1 || die "rsync is required"
command -v diff >/dev/null 2>&1 || die "diff is required"
command -v patch >/dev/null 2>&1 || die "patch is required"
command -v shasum >/dev/null 2>&1 || die "shasum is required"
# shellcheck source=scripts/operation-lock.sh
. "$ROOT/scripts/operation-lock.sh"
acquire_operation_lock "$STATE_DIR" || exit 1

handle_signal() {
  signal_code="$1"
  if [ "$FINISHING" -eq 1 ]; then
    SIGNAL_DURING_FINISH="$signal_code"
    return 0
  fi
  exit "$signal_code"
}

finish() {
  code=$?
  [ "$FINISHING" -eq 0 ] || return 0
  FINISHING=1
  rollback_failed=0
  set +e
  if [ "$code" -ne 0 ]; then
    if [ "$PACKAGE_ROLLBACK_NEEDED" -eq 1 ]; then restore_packages || rollback_failed=1; fi
    if [ "$CONFIG_ROLLBACK_NEEDED" -eq 1 ]; then restore_config || rollback_failed=1; fi
    if [ "$RUNTIME_ROLLBACK_NEEDED" -eq 1 ]; then restore_runtime || rollback_failed=1; fi
    if [ "$SIGNAL_DURING_FINISH" -ne 0 ]; then
      rollback_failed=1
      printf 'pi-setup: CRITICAL: signal %s arrived during cleanup; verify rollback before removing preserved state\n' "$SIGNAL_DURING_FINISH" >&2
    fi
    if [ "$rollback_failed" -ne 0 ]; then
      printf 'pi-setup: CRITICAL: rollback was incomplete; preserve managed backup %s and runtime transaction %s\n' "${BACKUP:-<none>}" "${RUNTIME_BACKUP:-<none>}" >&2
    elif [ -n "$RUNTIME_BACKUP" ]; then
      rm -rf -- "$RUNTIME_BACKUP" || rollback_failed=1
    fi
  fi
  if [ -n "$STAGE" ] && ! rm -rf -- "$STAGE"; then
    printf 'pi-setup: CRITICAL: unable to remove staging directory %s\n' "$STAGE" >&2
    [ "$code" -ne 0 ] || code=1
  fi
  if ! release_operation_lock; then
    printf '%s\n' 'pi-setup: CRITICAL: unable to release operation lock' >&2
    [ "$code" -ne 0 ] || code=1
  fi
  if [ "$code" -eq 0 ] && [ "$SIGNAL_DURING_FINISH" -ne 0 ]; then code="$SIGNAL_DURING_FINISH"; fi
  trap - EXIT INT TERM HUP
  exit "$code"
}
trap finish EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM HUP

if [ "$MODE" = "full" ]; then
  case "$MISE_CONFIG" in
    /*) ;;
    *) die "MISE_GLOBAL_CONFIG_FILE/MISE_CONFIG_DIR/XDG_CONFIG_HOME must resolve to an absolute global config path" ;;
  esac
  for package_path in \
    "$AGENT_DIR/npm" \
    "$AGENT_DIR/git" \
    "$AGENT_DIR/git/github.com" \
    "$AGENT_DIR/git/github.com/duy-tung" \
    "$AGENT_DIR/git/github.com/duy-tung/pi-anthropic-oauth-plus"
  do
    [ ! -L "$package_path" ] || die "Pi package-store path must not be a symlink: $package_path"
    [ ! -e "$package_path" ] || [ -d "$package_path" ] || die "Pi package-store path must be a directory: $package_path"
  done

  MISE="$(command -v mise 2>/dev/null || true)"
  [ -n "$MISE" ] || die "mise must be on PATH; install it with 'brew install mise' and activate it in your shell"
  # Installing a tool version does not select it globally. If a later step
  # fails, this may leave only an inert mise download/cache, never a changed
  # active runtime.
  "$MISE" -C / install --yes "node@$NODE_VERSION"
else
  command -v node >/dev/null 2>&1 || die "node is required for --config-only validation"
fi

run_node() {
  if [ "$MODE" = "full" ]; then
    "$MISE" -C / exec "node@$NODE_VERSION" -- node "$@"
  else
    node "$@"
  fi
}

validate_rel() {
  case "$1" in
    AGENTS.md|settings.json|zentui.json|scrub-session-secrets.sh|extensions|skills|prompts|agents) ;;
    *) die "unexpected managed path in manifest: $1" ;;
  esac
}

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  validate_rel "$rel"
  src="$ROOT/$rel"
  [ -e "$src" ] || die "managed source is missing: $rel"
  [ ! -L "$src" ] || die "managed source must not be a symlink: $rel"
  escaped="$(find "$src" -type l -print -quit 2>/dev/null || true)"
  [ -z "$escaped" ] || die "managed source contains a non-portable symlink: ${escaped#$ROOT/}"
done < "$MANIFEST"
case "$ROOT/" in
  "$AGENT_DIR/"*) die "the setup repository must not live inside $AGENT_DIR" ;;
esac

mkdir -p "$AGENT_DIR" "$STATE_DIR/backups" "$STATE_DIR/transactions"
STAGE="$AGENT_DIR/.pi-setup-stage.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"

copy_to_stage() {
  rel="$1"
  src="$ROOT/$rel"
  dst="$STAGE/$rel"
  mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    rsync -a --delete "$src/" "$dst/"
  else
    rsync -a "$src" "$dst"
  fi
}

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  copy_to_stage "$rel"
done < "$MANIFEST"

# Validate all repository-controlled input before changing global runtime state.
run_node "$ROOT/scripts/audit-repo.mjs"
run_node -e '
const fs = require("node:fs");
const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, "utf8"));
const expected = [
  "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2",
  "npm:pi-web-search@1.4.0",
  "npm:@upstash/context7-pi@0.1.2",
  "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  "npm:@juicesharp/rpiv-todo@2.9.0",
  "npm:@tintinweb/pi-subagents@0.19.0",
  "npm:pi-zentui@0.22.3",
  "npm:@juicesharp/rpiv-advisor@2.9.0",
  { source: "npm:pi-background-tasks@2.5.0", extensions: ["extensions/background-tasks.ts"] },
  "npm:@firstpick/pi-themes-bundle@0.1.6",
];
const defaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
if (JSON.stringify(s.npmCommand) !== JSON.stringify(["mise", "--no-config", "exec", "node@24.15.0", "--", "npm"])) throw new Error("portable npmCommand mismatch");
if (JSON.stringify(s.packages) !== JSON.stringify(expected)) throw new Error("pinned package list mismatch");
if (JSON.stringify(s.defaultTools) !== JSON.stringify(defaultTools)) throw new Error("default tool list mismatch");
' "$STAGE/settings.json"
bash -n "$STAGE/scrub-session-secrets.sh"

same_path() {
  src="$1"
  dst="$2"
  [ -e "$dst" ] || [ -L "$dst" ] || return 1
  [ ! -L "$dst" ] || return 1
  if [ -d "$src" ] && [ -d "$dst" ]; then
    # Itemize every real drift, but not mtimes (a fresh Git checkout changes those).
    changes="$(rsync -ainc --delete --out-format='%i' "$src/" "$dst/" | awk '!/^\.[fd]\.\.[tT]\.+$/ && NF')" || return 1
    [ -z "$changes" ]
    return
  fi
  [ -f "$src" ] && [ -f "$dst" ] || return 1
  case "${src##*/}" in
    settings.json|zentui.json) run_node "$ROOT/scripts/json-equal.mjs" "$src" "$dst" || return 1 ;;
    *) cmp -s "$src" "$dst" || return 1 ;;
  esac
  [ "$(stat -f '%Lp' "$src")" = "$(stat -f '%Lp' "$dst")" ]
}

CHANGED=0
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  if ! same_path "$STAGE/$rel" "$AGENT_DIR/$rel"; then
    CHANGED=1
    break
  fi
done < "$MANIFEST"

copy_existing() {
  src="$1"
  dst="$2"
  mkdir -p "$(dirname "$dst")" || return 1
  if [ -d "$src" ] && [ ! -L "$src" ]; then
    mkdir -p "$dst" || return 1
    rsync -a "$src/" "$dst/"
  else
    cp -pP "$src" "$dst"
  fi
}

prune_managed_backups() {
  # Retention is future-only. Legacy/unmarked backups are never adopted or removed.
  for marker in "$STATE_DIR"/backups/*/"$BACKUP_MARKER"; do
    [ -f "$marker" ] && [ ! -L "$marker" ] || continue
    marker_value="$(cat "$marker" 2>/dev/null || true)"
    [ "$marker_value" = "$BACKUP_MARKER_VALUE" ] || continue
    if [ -n "$(find "$marker" -prune -mtime "+$BACKUP_RETENTION_DAYS" -print 2>/dev/null || true)" ]; then
      backup_dir="${marker%/*}"
      if ! rm -rf -- "$backup_dir"; then
        printf 'pi-setup: warning: unable to prune expired managed backup %s\n' "$backup_dir" >&2
      fi
    fi
  done
}

restore_config() {
  [ -n "$BACKUP" ] || return 0
  printf 'pi-setup: restoring managed config from %s\n' "$BACKUP" >&2
  restore_failed=0
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    if ! rm -rf "$AGENT_DIR/$rel"; then restore_failed=1; fi
    if grep -Fxq "$rel" "$BACKUP/.present"; then
      if ! copy_existing "$BACKUP/$rel" "$AGENT_DIR/$rel"; then restore_failed=1; fi
    fi
  done < "$MANIFEST"
  return "$restore_failed"
}

restore_runtime() {
  [ -n "$RUNTIME_BACKUP" ] || return 0
  printf 'pi-setup: restoring previous global mise/Pi runtime state\n' >&2
  runtime_failed=0

  if [ "$PI_WAS_PRESENT" -eq 1 ]; then
    if [ "$PI_PREVIOUS_VERSION" != "$PI_VERSION" ]; then
      "$MISE" -C / exec "node@$NODE_VERSION" -- npm install --global "$PI_PACKAGE@$PI_PREVIOUS_VERSION" >/dev/null 2>&1 || runtime_failed=1
    fi
  else
    "$MISE" -C / exec "node@$NODE_VERSION" -- npm uninstall --global "$PI_PACKAGE" >/dev/null 2>&1 || runtime_failed=1
  fi

  if [ -f "$RUNTIME_BACKUP/.mise-present" ]; then
    mkdir -p "$(dirname "$MISE_CONFIG")" || runtime_failed=1
    cp -p "$RUNTIME_BACKUP/mise-config.toml" "$MISE_CONFIG" || runtime_failed=1
  else
    rm -f "$MISE_CONFIG" || runtime_failed=1
  fi
  return "$runtime_failed"
}

restore_packages() {
  [ -n "$RUNTIME_BACKUP" ] || return 0
  printf 'pi-setup: restoring previous Pi package stores\n' >&2
  package_failed=0
  npm_store="$AGENT_DIR/npm"
  oauth_store="$AGENT_DIR/git/github.com/duy-tung/pi-anthropic-oauth-plus"
  if [ -f "$RUNTIME_BACKUP/.npm-store-transaction" ]; then
    if [ -e "$RUNTIME_BACKUP/pi-npm" ]; then
      rm -rf "$npm_store" || package_failed=1
      mkdir -p "$(dirname "$npm_store")" || package_failed=1
      mv "$RUNTIME_BACKUP/pi-npm" "$npm_store" || package_failed=1
    elif [ -f "$RUNTIME_BACKUP/.npm-store-absent" ]; then
      rm -rf "$npm_store" || package_failed=1
    fi
  fi
  if [ -f "$RUNTIME_BACKUP/.oauth-store-transaction" ]; then
    if [ -e "$RUNTIME_BACKUP/pi-oauth" ]; then
      rm -rf "$oauth_store" || package_failed=1
      mkdir -p "$(dirname "$oauth_store")" || package_failed=1
      mv "$RUNTIME_BACKUP/pi-oauth" "$oauth_store" || package_failed=1
    elif [ -f "$RUNTIME_BACKUP/.oauth-store-absent" ]; then
      rm -rf "$oauth_store" || package_failed=1
    fi
  fi
  return "$package_failed"
}

packages_ready() {
  run_node "$ROOT/scripts/package-health.mjs" "$AGENT_DIR"
}

prepare_package_transaction() {
  npm_store="$AGENT_DIR/npm"
  oauth_store="$AGENT_DIR/git/github.com/duy-tung/pi-anthropic-oauth-plus"
  PACKAGE_ROLLBACK_NEEDED=1
  : > "$RUNTIME_BACKUP/.npm-store-transaction"
  if [ -e "$npm_store" ] || [ -L "$npm_store" ]; then
    mv "$npm_store" "$RUNTIME_BACKUP/pi-npm"
    # Reconcile managed pins in a copy of the prior store. npm/pi can update
    # those pins while unrelated user-installed entries remain transactionally
    # protected by the untouched original in RUNTIME_BACKUP.
    copy_existing "$RUNTIME_BACKUP/pi-npm" "$npm_store"
    # Force the managed npm packages to be reconstructed while leaving all
    # unrelated package entries and shared dependencies in the working copy.
    rm -rf -- \
      "$npm_store/node_modules/pi-web-search" \
      "$npm_store/node_modules/@upstash/context7-pi" \
      "$npm_store/node_modules/@juicesharp/rpiv-ask-user-question" \
      "$npm_store/node_modules/@juicesharp/rpiv-todo" \
      "$npm_store/node_modules/@tintinweb/pi-subagents" \
      "$npm_store/node_modules/pi-background-tasks" \
      "$npm_store/node_modules/pi-zentui" \
      "$npm_store/node_modules/@juicesharp/rpiv-advisor" \
      "$npm_store/node_modules/@firstpick/pi-themes-bundle"
  else
    : > "$RUNTIME_BACKUP/.npm-store-absent"
  fi
  : > "$RUNTIME_BACKUP/.oauth-store-transaction"
  if [ -e "$oauth_store" ] || [ -L "$oauth_store" ]; then
    mv "$oauth_store" "$RUNTIME_BACKUP/pi-oauth"
  else
    : > "$RUNTIME_BACKUP/.oauth-store-absent"
  fi
}

if [ "$MODE" = "full" ]; then
  RUNTIME_BACKUP="$(mktemp -d "$STATE_DIR/transactions/install.XXXXXX")"
  if [ -e "$MISE_CONFIG" ] || [ -L "$MISE_CONFIG" ]; then
    : > "$RUNTIME_BACKUP/.mise-present"
    cp -pL "$MISE_CONFIG" "$RUNTIME_BACKUP/mise-config.toml"
  fi
  NPM_ROOT="$("$MISE" -C / exec "node@$NODE_VERSION" -- npm root --global)"
  PI_META="$NPM_ROOT/$PI_PACKAGE/package.json"
  if [ -f "$PI_META" ]; then
    PI_WAS_PRESENT=1
    PI_PREVIOUS_VERSION="$(run_node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$PI_META")"
  fi
  RUNTIME_ROLLBACK_NEEDED=1

  printf '%s\n' "==> Pinning Node $NODE_VERSION, long cache retention, and technical-safe OAuth prompt rewriting with mise"
  "$MISE" -C / use --global --pin --yes "node@$NODE_VERSION"
  "$MISE" -C / set --global PI_CACHE_RETENTION=long
  "$MISE" -C / set --global "PI_ANTHROPIC_OAUTH_REWRITE_MODE=$OAUTH_REWRITE_MODE"
  if [ "$PI_WAS_PRESENT" -eq 1 ] && [ "$PI_PREVIOUS_VERSION" = "$PI_VERSION" ]; then
    printf '%s\n' "==> $PI_PACKAGE@$PI_VERSION is already installed"
  else
    printf '%s\n' "==> Installing $PI_PACKAGE@$PI_VERSION"
    "$MISE" -C / exec "node@$NODE_VERSION" -- npm install --global "$PI_PACKAGE@$PI_VERSION"
  fi
fi

if [ "$CHANGED" -eq 1 ]; then
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  BACKUP="$STATE_DIR/backups/$stamp"
  mkdir -p "$BACKUP"
  printf '%s\n' "$BACKUP_MARKER_VALUE" > "$BACKUP/$BACKUP_MARKER"
  : > "$BACKUP/.present"
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    if [ -e "$AGENT_DIR/$rel" ] || [ -L "$AGENT_DIR/$rel" ]; then
      printf '%s\n' "$rel" >> "$BACKUP/.present"
      copy_existing "$AGENT_DIR/$rel" "$BACKUP/$rel"
    fi
  done < "$MANIFEST"

  CONFIG_ROLLBACK_NEEDED=1
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    rm -rf "$AGENT_DIR/$rel"
    mv "$STAGE/$rel" "$AGENT_DIR/$rel"
  done < "$MANIFEST"
  printf '%s\n' "==> Managed config installed; previous content backed up at $BACKUP"
else
  printf '%s\n' "==> Managed config already matches the repository"
fi

if [ "$MODE" = "full" ]; then
  PATCH_ACTION="--check"
  if packages_ready; then
    printf '%s\n' "==> Pinned Pi package stores already match"
  else
    PATCH_ACTION="--apply"
    printf '%s\n' "==> Reconciling pinned Pi packages transactionally"
    prepare_package_transaction
    for spec in \
      "git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2" \
      "npm:pi-web-search@1.4.0" \
      "npm:@upstash/context7-pi@0.1.2" \
      "npm:@juicesharp/rpiv-ask-user-question@2.9.0" \
      "npm:@juicesharp/rpiv-todo@2.9.0" \
      "npm:@tintinweb/pi-subagents@0.19.0" \
      "npm:pi-background-tasks@2.5.0" \
      "npm:pi-zentui@0.22.3" \
      "npm:@juicesharp/rpiv-advisor@2.9.0" \
      "npm:@firstpick/pi-themes-bundle@0.1.6"
    do
      "$MISE" -C / exec "node@$NODE_VERSION" -- pi install "$spec" --no-approve
    done
    # pi install may normalize object-form resources; restore our exact filters.
    cp -p "$ROOT/settings.json" "$AGENT_DIR/settings.json"
  fi
  printf '%s\n' "==> Applying or verifying pinned package patches"
  run_node "$ROOT/scripts/package-patches.mjs" "$PATCH_ACTION" "$AGENT_DIR"
  "$ROOT/doctor.sh"
else
  "$ROOT/doctor.sh" --config-only
fi

CONFIG_ROLLBACK_NEEDED=0
RUNTIME_ROLLBACK_NEEDED=0
PACKAGE_ROLLBACK_NEEDED=0
if [ -n "$RUNTIME_BACKUP" ]; then rm -rf "$RUNTIME_BACKUP"; fi
prune_managed_backups
printf '%s\n' "==> Pi setup complete"
if ! command -v pi >/dev/null 2>&1; then
  printf '%s\n' "Note: activate mise in your shell, then open a new shell before running pi."
fi
