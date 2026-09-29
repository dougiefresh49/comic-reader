#!/usr/bin/env bash
# PreToolUse Edit/Write guard: blocks edits to the model-id and voice-settings
# sources, which decide which paid API the pipeline spends against.
# Rule list: paid-commands.txt, the `file:` lines, shared with the Bash guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
#
# The override is CREDIT_OVERRIDE=1 in this hook process's environment, which
# comes from the shell that launched the session
# (`CREDIT_OVERRIDE=1 claude`). An Edit carries no env prefix of its own, so the
# process is the only seam; a switch file is ruled out by decision 2.

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

if [ "${CREDIT_OVERRIDE:-}" = "1" ]; then
  exit 0
fi

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIST="$HOOK_DIR/paid-commands.txt"

if [ ! -f "$LIST" ]; then
  printf 'Blocked: %s is missing, so the guarded-file list cannot be checked. Restore it from the repo.\n' "$LIST" >&2
  exit 2
fi

# Match on the path relative to the repo root, so an absolute path and a
# relative one are the same rule.
REPO_ROOT=$(cd "$HOOK_DIR/../.." && pwd -P)
REL_PATH=$FILE_PATH
case "$REL_PATH" in
"$REPO_ROOT"/*) REL_PATH=${REL_PATH#"$REPO_ROOT"/} ;;
esac
REL_PATH=${REL_PATH#./}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
  file:*) ;;
  *) continue ;;
  esac

  target=${line#file:}
  target=${target%%::*}
  target=$(printf '%s' "$target" | sed -E 's/[[:space:]]+$//')

  if [ "$REL_PATH" = "$target" ] || [ "${REL_PATH%"/$target"}" != "$REL_PATH" ]; then
    printf 'Blocked: %s\n' "${line#*:: }" >&2
    exit 2
  fi
done <"$LIST"

exit 0
