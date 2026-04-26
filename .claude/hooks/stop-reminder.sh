#!/usr/bin/env bash
# After Claude finishes a turn, checks if any scripts/*.ts files were recently modified
# and nudges to run typecheck if so.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Find any scripts/*.ts files modified in the last 5 minutes
RECENTLY_MODIFIED=$(find "$PROJECT_DIR/scripts" -name "*.ts" -newer "$PROJECT_DIR/package.json" -mmin -5 2>/dev/null | head -5)

if [ -n "$RECENTLY_MODIFIED" ]; then
  FILE_LIST=$(echo "$RECENTLY_MODIFIED" | sed "s|$PROJECT_DIR/||g" | tr '\n' ', ' | sed 's/, $//')
  jq -n --arg files "$FILE_LIST" '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: ("Scripts modified this turn: " + $files + ". Run `pnpm typecheck` to verify before running the pipeline.")
    }
  }'
fi

exit 0
