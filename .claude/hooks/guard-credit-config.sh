#!/usr/bin/env bash
# PreToolUse guard: blocks edits to the model-id and voice-settings sources,
# which decide which paid API the pipeline spends against. Matched on
# Edit/Write/MultiEdit, and on a codex apply_patch, whose payload names the
# file in the patch text rather than in a file_path field.
# Rule list: paid-commands.txt, the `file:` lines, shared with the Bash guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
#
# The override is CREDIT_OVERRIDE=1 in this hook process's environment, which
# comes from the shell that launched the session (`CREDIT_OVERRIDE=1 claude`).
# An Edit carries no env prefix of its own, so the process is the only seam; a
# switch file is ruled out by decision 2.

PAYLOAD=$(cat)
FILE_PATH=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
JQ_STATUS=$?

if [ "$JQ_STATUS" -ne 0 ]; then
  printf 'Blocked: the hook payload was not readable JSON, so the guarded-file list could not be checked.\n' >&2
  exit 2
fi

if [ -z "$FILE_PATH" ]; then
  # No file_path. A codex apply_patch carries the paths in the patch text, so
  # fall through and check the whole payload for a guarded path.
  :
fi

if [ "${CREDIT_OVERRIDE:-}" = "1" ]; then
  exit 0
fi

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIST="$HOOK_DIR/paid-commands.txt"
REPO_ROOT=$(cd "$HOOK_DIR/../.." && pwd -P)

if [ ! -f "$LIST" ]; then
  printf 'Blocked: %s is missing, so the guarded-file list cannot be checked. Restore it from the repo.\n' "$LIST" >&2
  exit 2
fi

# src/lib//models.ts, src/lib/../lib/models.ts and ./src/lib/models.ts are one
# file, and the guarded list is written the short way.
normalize_path() {
  local p=$1 prev
  p=$(printf '%s' "$p" | sed -E 's|//+|/|g; s|/\./|/|g; s|/$||')
  while :; do
    prev=$p
    p=$(printf '%s' "$p" | sed -E 's|[^/]+/\.\./||')
    [ "$p" = "$prev" ] && break
  done
  printf '%s' "${p#./}"
}

# Match on the path relative to the repo root, so an absolute path and a
# relative one are the same rule.
REL_PATH=$FILE_PATH
case "$REL_PATH" in
"$REPO_ROOT"/*) REL_PATH=${REL_PATH#"$REPO_ROOT"/} ;;
esac
REL_PATH=$(normalize_path "$REL_PATH")

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
  file:*) ;;
  *) continue ;;
  esac

  target=${line#file:}
  target=${target%%::*}
  target=$(printf '%s' "$target" | sed -E 's/[[:space:]]+$//')
  reason=${line#*:: }

  if [ "$REL_PATH" = "$target" ] || [ "${REL_PATH%"/$target"}" != "$REL_PATH" ]; then
    printf 'Blocked: %s\n' "$reason" >&2
    exit 2
  fi

  # No file_path in the payload: a patch names the file in its text. Over-
  # blocking on a mention is the safe direction for a credit guard.
  if [ -z "$FILE_PATH" ] && printf '%s' "$PAYLOAD" | grep -qF "$target"; then
    printf 'Blocked: %s\n' "$reason" >&2
    exit 2
  fi
done <"$LIST"

exit 0
