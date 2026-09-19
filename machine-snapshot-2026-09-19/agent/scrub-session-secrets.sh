#!/usr/bin/env bash
# Redact credentials accidentally printed into pi session transcripts.
#
# Run AFTER quitting Pi. RPC subagents are session-scoped and shut down with
# their parent, so this avoids racing any transcript writer.
#
#   ~/.pi/agent/scrub-session-secrets.sh            # scan default roots
#   ~/.pi/agent/scrub-session-secrets.sh <path...>  # explicit files or dirs
set -euo pipefail
umask 077

# Mirrors the structured credential families in extensions/lib/redact.ts.
# Deliberately excludes its unlabelled AWS-40 heuristic: it cannot distinguish
# credentials from ordinary 40-character data, so do not rewrite archives by shape
# alone. ERE and Perl differ; tests check each supported family in isolation.
PATTERN='sk-ant-(oat|ort)01-[A-Za-z0-9_-]{20,}|sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}|rt\.1\.[A-Za-z0-9_-]{40,}|ctx7sk-[0-9a-fA-F-]{20,}|(^|[^A-Za-z0-9_])(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[0-9A-Z]{16}([^A-Za-z0-9_]|$)|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-proj-[A-Za-z0-9_-]{20,}|sk-svcacct-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|ya29\.[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{20,})|-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----'

HOME_REAL="$(CDPATH= cd -- "$HOME" && pwd -P)"
BACKUP_LIST="$HOME_REAL/.pi/agent/scrub-backups.txt"
LIST_LOCK=""
temporary_files=()

cleanup() {
  code=$?
  trap - EXIT INT TERM HUP
  for temporary in "${temporary_files[@]-}"; do
    [[ -z "$temporary" ]] || rm -f -- "$temporary"
  done
  if [[ -n "$LIST_LOCK" ]]; then rmdir -- "$LIST_LOCK" 2>/dev/null || true; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

reject_newline_path() {
  case "$1" in
    *$'\n'*)
      printf 'scrub-session-secrets: refusing newline-bearing path because the backup list is line-delimited: %q\n' "$1" >&2
      return 1
      ;;
  esac
}

roots=()
if [[ $# -gt 0 ]]; then
  for root in "$@"; do
    reject_newline_path "$root" || exit 1
    roots+=("$root")
  done
else
  # Resolve a symlinked HOME before walking. Prune excluded trees instead of
  # traversing them and filtering only their output.
  roots+=("$HOME_REAL/.pi")
  while IFS= read -r -d '' directory; do roots+=("$directory"); done < <(
    find "$HOME_REAL" -maxdepth 8 \
      \( -path "$HOME_REAL/.pi" -o -type d -name node_modules -o -type d -name Library \) -prune -o \
      -type d -name .pi -print0 2>/dev/null
  )
fi

printf 'Scanning:'
for root in "${roots[@]}"; do printf ' %q' "$root"; done
printf '\n'

candidates=()
append_candidate() {
  candidate="$1"
  reject_newline_path "$candidate" || return 1
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 0
  for existing in "${candidates[@]-}"; do
    [[ -z "$existing" || "$existing" != "$candidate" ]] || return 0
  done
  candidates+=("$candidate")
}

for root in "${roots[@]}"; do
  if [[ -f "$root" && ! -L "$root" ]]; then
    append_candidate "$root" || exit 1
  elif [[ -d "$root" && ! -L "$root" ]]; then
    while IFS= read -r -d '' candidate; do append_candidate "$candidate" || exit 1; done < <(
      find "$root" \
        \( -type d \( -name node_modules -o -name Library \) -prune \) -o \
        -type f ! -name '*.bak' ! -name '*.bak.*' \
        \( -name '*.jsonl' -o -name '*.md' -o -name '*.txt' -o -name '*.output' -o -path '*/rewind/*' \) -print0 2>/dev/null
    )
  fi
done

files=()
for candidate in "${candidates[@]-}"; do
  [[ -n "$candidate" ]] || continue
  if LC_ALL=C grep -Eiq -- "$PATTERN" "$candidate"; then files+=("$candidate"); fi
done

if [[ -z "${files[0]+x}" ]]; then
  echo "Clean: no credential-shaped strings found."
  exit 0
fi

mkdir -p -- "$(dirname "$BACKUP_LIST")"
LIST_LOCK="${BACKUP_LIST}.lock"
if ! mkdir -- "$LIST_LOCK" 2>/dev/null; then
  printf 'scrub-session-secrets: another scrub owns the backup-list lock: %s\n' "$LIST_LOCK" >&2
  exit 1
fi

track_backup() {
  backup="$1"
  list_tmp="$(mktemp "${BACKUP_LIST}.tmp.XXXXXX")"
  temporary_files+=("$list_tmp")
  if [[ -f "$BACKUP_LIST" ]]; then LC_ALL=C awk 'NF && !seen[$0]++' "$BACKUP_LIST" > "$list_tmp"; fi
  if ! grep -Fxq -- "$backup" "$list_tmp" 2>/dev/null; then printf '%s\n' "$backup" >> "$list_tmp"; fi
  chmod 600 "$list_tmp"
  mv -f -- "$list_tmp" "$BACKUP_LIST"
}

scrub_failed=0
for file in "${files[@]}"; do
  transformed="$(mktemp "${file}.scrub.XXXXXX")"
  temporary_files+=("$transformed")
  if ! perl -0777 -pe '
    s/sk-ant-oat01-[A-Za-z0-9_-]{20,}/sk-ant-oat01-REDACTED/g;
    s/sk-ant-ort01-[A-Za-z0-9_-]{20,}/sk-ant-ort01-REDACTED/g;
    s/sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/sk-ant-api-REDACTED/g;
    s/rt\.1\.[A-Za-z0-9_-]{40,}/rt.1.REDACTED/g;
    s/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/JWT.REDACTED/g;
    s/\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/Bearer REDACTED/gi;
    s/ctx7sk-[0-9a-fA-F-]{20,}/ctx7sk-REDACTED/g;
    s/\bgh[pousr]_[A-Za-z0-9]{20,}/gh_REDACTED/g;
    s/\bgithub_pat_[A-Za-z0-9_]{20,}/github_pat_REDACTED/g;
    s/\bA[KS]IA[0-9A-Z]{16}\b/AWSKEY_REDACTED/g;
    s/\bxox[baprs]-[A-Za-z0-9-]{10,}/xox_REDACTED/g;
    s/\bAIza[0-9A-Za-z_-]{35}\b/AIza_REDACTED/g;
    s/\bsk-proj-[A-Za-z0-9_-]{20,}/sk-proj-REDACTED/g;
    s/\bsk-svcacct-[A-Za-z0-9_-]{20,}/sk-svcacct-REDACTED/g;
    s/\bsk_live_[A-Za-z0-9_-]{20,}/sk_live_REDACTED/g;
    s/\bsk-[A-Za-z0-9_-]{32,}/sk-REDACTED/g;
    s/\bya29\.[A-Za-z0-9_-]{20,}/ya29.REDACTED/g;
    s/\bxai-[A-Za-z0-9_-]{20,}/xai-REDACTED/g;
    s/\bhf_[A-Za-z0-9]{20,}/hf_REDACTED/g;
    s/\bnpm_[A-Za-z0-9]{20,}/npm_REDACTED/g;
    s/\bglpat-[A-Za-z0-9_-]{20,}/glpat-REDACTED/g;
    s/\btvly-[A-Za-z0-9_-]{20,}/tvly-REDACTED/g;
    s/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\z)/[PRIVATE_KEY_REDACTED]/gs;
  ' "$file" > "$transformed"; then
    printf 'scrub-session-secrets: unable to transform %q\n' "$file" >&2
    scrub_failed=1
    continue
  fi
  if cmp -s -- "$file" "$transformed"; then
    printf 'scrub-session-secrets: detector/replacer mismatch for %q; source was not changed\n' "$file" >&2
    scrub_failed=1
    continue
  fi
  mode="$(stat -f '%Lp' "$file")"
  chmod "$mode" "$transformed"

  backup="${file}.bak"
  suffix=0
  while [[ -e "$backup" || -L "$backup" ]]; do
    suffix=$((suffix + 1))
    backup="${file}.bak.${suffix}"
  done
  # List the final path before creating secret-bearing backup content. A crash
  # may leave a missing list entry, but never an unlisted plaintext backup.
  track_backup "$backup"
  cp -p -- "$file" "$backup"
  chmod 600 "$backup"
  mv -f -- "$transformed" "$file"
  echo "scrubbed: $file  (backup: $backup)"
done

[[ "$scrub_failed" -eq 0 ]] || exit 1

cat <<'EOF'

Backups still hold the original secrets. The cumulative list includes every
backup from prior runs. Verify the scrub, then delete exactly the listed files:
  while IFS= read -r b; do rm -f -- "$b"; done < ~/.pi/agent/scrub-backups.txt
  rm -f -- ~/.pi/agent/scrub-backups.txt

Rotate anything that was exposed:
  pi auth                          # Anthropic + Codex OAuth
  https://context7.com/dashboard   # CONTEXT7_API_KEY
EOF
