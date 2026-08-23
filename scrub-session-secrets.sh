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

# Mirrors REDACTIONS in extensions/lib/redact.ts — this script is the backstop
# for output the guard never saw (user-run /bash), so a family the guard knows
# but this list does not is a family with no coverage at all on that path.
PATTERN='sk-ant-(oat|ort)01-[A-Za-z0-9_-]{10,}|sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}|rt\.1\.[A-Za-z0-9_-]{40,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|ctx7sk-[0-9a-fA-F-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-proj-[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY'

roots=()
if [[ $# -gt 0 ]]; then
  roots=("$@")
else
  # RPC v2 sessions live under ~/.pi. Keep scanning project .pi directories as
  # well because legacy tmux-era subagent transcripts may still exist there.
  roots+=("$HOME/.pi")
  while IFS= read -r d; do roots+=("$d"); done < <(
    find "$HOME" -maxdepth 8 -type d -name ".pi" \
      -not -path "$HOME/.pi" \
      -not -path "*/node_modules/*" \
      -not -path "*/Library/*" 2>/dev/null
  )
fi

echo "Scanning: ${roots[*]}"
files=()
while IFS= read -r f; do files+=("$f"); done < <(
  grep -rlE "$PATTERN" --include='*.jsonl' --include='*.md' --include='*.txt' \
    "${roots[@]}" 2>/dev/null | grep -v '\.bak$' || true
)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "Clean: no credential-shaped strings found."
  exit 0
fi

backups=()
for f in "${files[@]}"; do
  cp -p "$f" "$f.bak"
  chmod 600 "$f.bak"
  backups+=("$f.bak")
  # -0777: whole-file mode, so the PEM block rule can span lines.
  perl -0777 -pi -e '
    s/sk-ant-oat01-[A-Za-z0-9_-]+/sk-ant-oat01-REDACTED/g;
    s/sk-ant-ort01-[A-Za-z0-9_-]+/sk-ant-ort01-REDACTED/g;
    s/sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/sk-ant-api-REDACTED/g;
    s/rt\.1\.[A-Za-z0-9_-]{40,}/rt.1.REDACTED/g;
    s/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/JWT.REDACTED/g;
    s/ctx7sk-[0-9a-fA-F-]{20,}/ctx7sk-REDACTED/g;
    s/\bgh[pousr]_[A-Za-z0-9]{20,}/gh_REDACTED/g;
    s/\bgithub_pat_[A-Za-z0-9_]{20,}/github_pat_REDACTED/g;
    s/\bA[KS]IA[0-9A-Z]{16}\b/AWSKEY_REDACTED/g;
    s/\bxox[baprs]-[A-Za-z0-9-]{10,}/xox_REDACTED/g;
    s/\bAIza[0-9A-Za-z_-]{35}\b/AIza_REDACTED/g;
    s/\bsk-proj-[A-Za-z0-9_-]{20,}/sk-proj-REDACTED/g;
    s/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/[PRIVATE_KEY_REDACTED]/gs;
  ' "$f"
  echo "scrubbed: $f  (backup: $f.bak)"
done

printf '%s\n' "${backups[@]}" > "$HOME/.pi/agent/scrub-backups.txt"
chmod 600 "$HOME/.pi/agent/scrub-backups.txt"

cat <<'EOF'

Backups still hold the original secrets. Verify the scrub, then delete exactly
what was created (the list covers .jsonl, .md and .txt alike):
  while IFS= read -r b; do rm -f "$b"; done < ~/.pi/agent/scrub-backups.txt
  rm ~/.pi/agent/scrub-backups.txt

Rotate anything that was exposed:
  pi auth                          # Anthropic + Codex OAuth
  https://context7.com/dashboard   # CONTEXT7_API_KEY
EOF
