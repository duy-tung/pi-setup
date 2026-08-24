#!/usr/bin/env bash
# Shared fail-closed lock for install/capture operations.
PI_SETUP_OPERATION_LOCK=""
PI_SETUP_OPERATION_TOKEN=""

acquire_operation_lock() {
  state_dir="$1"
  mkdir -p "$state_dir" || return 1
  PI_SETUP_OPERATION_LOCK="$state_dir/operation.lock"
  PI_SETUP_OPERATION_TOKEN="$$-$(date -u '+%Y%m%dT%H%M%SZ')"
  if ! mkdir "$PI_SETUP_OPERATION_LOCK" 2>/dev/null; then
    printf 'pi-setup: another install/sync operation owns %s. If no such process is running, remove that exact directory manually.\n' "$PI_SETUP_OPERATION_LOCK" >&2
    return 1
  fi
  printf '%s\n' "$PI_SETUP_OPERATION_TOKEN" > "$PI_SETUP_OPERATION_LOCK/owner"
}

release_operation_lock() {
  [ -n "$PI_SETUP_OPERATION_LOCK" ] || return 0
  owner=""
  [ ! -f "$PI_SETUP_OPERATION_LOCK/owner" ] || owner="$(cat "$PI_SETUP_OPERATION_LOCK/owner" 2>/dev/null || true)"
  if [ "$owner" = "$PI_SETUP_OPERATION_TOKEN" ]; then rm -rf "$PI_SETUP_OPERATION_LOCK"; fi
  PI_SETUP_OPERATION_LOCK=""
  PI_SETUP_OPERATION_TOKEN=""
}
