#!/usr/bin/env bash
# Blocks destructive bash commands targeting source asset directories.
# assets/ and public/comics/ contain irreplaceable files — source pages and generated audio/images.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block rm -rf (or rm -r) targeting assets or public/comics
# Allow "git rm --cached" (index-only removal, keeps files on disk)
if echo "$COMMAND" | grep -q 'git rm.*--cached'; then
  exit 0
fi
if echo "$COMMAND" | grep -qE 'rm\s+-[rf]{1,3}\s+.*assets/' || \
   echo "$COMMAND" | grep -qE 'rm\s+-[rf]{1,3}\s+.*public/comics/'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked: destructive operation on source assets directory. assets/ and public/comics/ contain irreplaceable comic source files and generated audio. Delete files manually if intentional."
    }
  }'
  exit 0
fi

# Block accidental overwrite of checkpoint files outside of ingest.ts
if echo "$COMMAND" | grep -qE 'rm.*checkpoint\.json|truncate.*checkpoint\.json'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked: manual deletion of checkpoint.json. Use pnpm ingest -- --book <name> --issue <n> --reset to clear pipeline state cleanly."
    }
  }'
  exit 0
fi

exit 0
