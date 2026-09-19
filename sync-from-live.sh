#!/usr/bin/env bash
# Capture only the allowlisted live Pi configuration into this repository.
set -euo pipefail
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
MANIFEST="$ROOT/scripts/managed-paths.txt"
HOME_REAL="$(CDPATH= cd -- "$HOME" && pwd -P)"
PI_ROOT="$HOME_REAL/.pi"
AGENT_DIR="$PI_ROOT/agent"
STATE_DIR="$HOME_REAL/.local/state/pi-setup"
TMP=""
ROLLBACK_NEEDED=0
FINISHING=0
SIGNAL_DURING_FINISH=0

usage() {
  printf '%s\n' "Usage: ./sync-from-live.sh"
}

case "${1:-}" in
  "") ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { printf '%s\n' "sync-from-live: macOS only" >&2; exit 1; }
[ ! -L "$PI_ROOT" ] || { printf 'sync-from-live: %s must not be a symlink\n' "$PI_ROOT" >&2; exit 1; }
[ ! -L "$AGENT_DIR" ] || { printf 'sync-from-live: %s must not be a symlink\n' "$AGENT_DIR" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { printf '%s\n' "sync-from-live: rsync is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' "sync-from-live: node is required" >&2; exit 1; }
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
  preserve_tmp=0
  set +e
  if [ "$code" -ne 0 ] && [ "$ROLLBACK_NEEDED" -eq 1 ]; then
    printf '%s\n' "sync-from-live: restoring repository-managed paths after failure" >&2
    restore_repo
    rollback_code=$?
    if [ "$rollback_code" -ne 0 ]; then
      preserve_tmp=1
      printf 'sync-from-live: CRITICAL: rollback was incomplete; before-image preserved at %s/before\n' "$TMP" >&2
    fi
  fi
  if [ "$SIGNAL_DURING_FINISH" -ne 0 ]; then
    preserve_tmp=1
    printf 'sync-from-live: CRITICAL: signal %s arrived during cleanup; before-image preserved at %s/before\n' "$SIGNAL_DURING_FINISH" "$TMP" >&2
  fi
  if [ -n "$TMP" ] && [ "$preserve_tmp" -eq 0 ] && ! rm -rf -- "$TMP"; then
    printf 'sync-from-live: CRITICAL: unable to remove transaction %s\n' "$TMP" >&2
    [ "$code" -ne 0 ] || code=1
  fi
  if ! release_operation_lock; then
    printf '%s\n' 'sync-from-live: CRITICAL: unable to release operation lock' >&2
    [ "$code" -ne 0 ] || code=1
  fi
  if [ "$code" -eq 0 ] && [ "$SIGNAL_DURING_FINISH" -ne 0 ]; then code="$SIGNAL_DURING_FINISH"; fi
  trap - EXIT INT TERM HUP
  exit "$code"
}
trap finish EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM HUP

node "$ROOT/scripts/audit-repo.mjs"

managed_paths=()
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  managed_paths+=("$rel")
done < "$MANIFEST"
if [ -n "$(git -C "$ROOT" status --porcelain -- "${managed_paths[@]}")" ]; then
  printf '%s\n' "sync-from-live: repository-managed paths are already dirty; review or commit them before capture" >&2
  exit 1
fi

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  case "$rel" in
    AGENTS.md|settings.json|zentui.json|scrub-session-secrets.sh|extensions|skills|prompts|agents) ;;
    *) printf 'sync-from-live: unexpected managed path: %s\n' "$rel" >&2; exit 1 ;;
  esac
  src="$AGENT_DIR/$rel"
  [ -e "$src" ] || { printf 'sync-from-live: live path is missing: %s\n' "$rel" >&2; exit 1; }
  [ ! -L "$src" ] || { printf 'sync-from-live: live path is a non-portable symlink: %s\n' "$rel" >&2; exit 1; }
  escaped="$(find "$src" -type l -print -quit 2>/dev/null || true)"
  [ -z "$escaped" ] || { printf 'sync-from-live: live config contains a non-portable symlink: %s\n' "$escaped" >&2; exit 1; }
done < "$MANIFEST"

mkdir -p "$STATE_DIR/sync-transactions"
TMP="$(mktemp -d "$STATE_DIR/sync-transactions/sync.XXXXXX")"
mkdir -p "$TMP/live" "$TMP/before"

copy_path() {
  src="$1"
  dst="$2"
  mkdir -p "$(dirname "$dst")" || return 1
  if [ -d "$src" ]; then
    mkdir -p "$dst" || return 1
    rsync -a --delete "$src/" "$dst/"
  else
    rsync -a "$src" "$dst"
  fi
}

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  copy_path "$AGENT_DIR/$rel" "$TMP/live/$rel"
  copy_path "$ROOT/$rel" "$TMP/before/$rel"
done < "$MANIFEST"

restore_repo() {
  restore_failed=0
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    if ! rm -rf "$ROOT/$rel"; then restore_failed=1; fi
    if ! copy_path "$TMP/before/$rel" "$ROOT/$rel"; then restore_failed=1; fi
  done < "$MANIFEST"
  return "$restore_failed"
}

ROLLBACK_NEEDED=1
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  rm -rf "$ROOT/$rel"
  copy_path "$TMP/live/$rel" "$ROOT/$rel"
done < "$MANIFEST"

node "$ROOT/scripts/audit-repo.mjs"
"$ROOT/doctor.sh" --config-only
git -C "$ROOT" diff --check
ROLLBACK_NEEDED=0

printf '%s\n' "Live managed configuration captured. Review before staging:"
git -C "$ROOT" status --short
