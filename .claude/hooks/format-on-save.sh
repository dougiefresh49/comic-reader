#!/usr/bin/env bash
# Auto-formats .ts and .tsx files with prettier after Write/Edit tool calls.
# Runs async (non-blocking) — Claude's response is not delayed.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Read tool input from stdin
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# Only act on TypeScript files
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  *.ts|*.tsx)
    ;;
  *)
    exit 0
    ;;
esac

# Verify file exists
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Run prettier (suppress output — async hook, user doesn't need to see this)
cd "$PROJECT_DIR" && pnpm prettier --write "$FILE_PATH" --log-level silent 2>/dev/null

exit 0
