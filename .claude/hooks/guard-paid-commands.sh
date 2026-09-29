#!/usr/bin/env bash
# PreToolUse Bash guard: blocks paid commands, and .env reads in a delegate.
# Rule list: paid-commands.txt, one rule per line, shared with the Edit guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
# It only ever reads the command string, never runs it.

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIST="$HOOK_DIR/paid-commands.txt"

if [ ! -f "$LIST" ]; then
  # A spend guard that cannot read its list fails closed.
  printf 'Blocked: %s is missing, so the paid-command list cannot be checked. Restore it from the repo.\n' "$LIST" >&2
  exit 2
fi

block() {
  printf 'Blocked: %s\n' "$1" >&2
  exit 2
}

# --- paid commands -------------------------------------------------------
#
# The override is per command, an env prefix, never a session switch. If the
# command already carries it, the rule is satisfied and the list is skipped.

if printf '%s' "$COMMAND" | grep -qE '(^|[^[:alnum:]_])LIVE_API_OK=1([^[:alnum:]_]|$)'; then
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
  '' | '#'*) continue ;;
  @from-step:* | file:*) continue ;; # handled below or by the Edit guard
  esac

  pattern=${line%% ::*}
  reason=${line#*:: }
  # A pattern may name several conditions joined by " && "; all must hold.
  matched=1
  OLD_IFS=$IFS
  IFS='&'
  for COND in $pattern; do
    COND=${COND# }
    COND=${COND% }
    [ -z "$COND" ] && continue
    if ! printf '%s' "$COMMAND" | grep -qE "$COND"; then
      matched=0
      break
    fi
  done
  IFS=$OLD_IFS
  if [ "$matched" = "1" ]; then
    block "$reason"
  fi
done <"$LIST"

# --- ingest resumed at or after a paid step ------------------------------
#
# `pnpm ingest -- --from-step <step>` re-runs that step and every step after
# it. The order comes from scripts/ingest.ts at run time, not from a second
# copy of the list, so the two cannot drift apart.

FROM_STEP=$(printf '%s' "$COMMAND" |
  grep -oE -- '--from-step(=|[[:space:]]+)[a-z0-9][a-z0-9-]*' |
  head -n1 | sed -E 's/^--from-step(=|[[:space:]]+)+//')

if [ -n "$FROM_STEP" ] && printf '%s' "$COMMAND" |
  grep -qE '(^|[^[:alnum:]_-])pnpm[[:space:]]+(run[[:space:]]+)?ingest([^[:alnum:]_-]|$)'; then
  INGEST_TS="$HOOK_DIR/../../scripts/ingest.ts"
  THRESHOLD=$(grep -m1 '^@from-step:' "$LIST" | sed -E 's/^@from-step:([a-z0-9-]+).*/\1/')
  ORDER=$(awk '/^const PIPELINE_STEPS/,/^\];/' "$INGEST_TS" 2>/dev/null |
    grep -oE 'id: "[a-z0-9-]+"' | sed -E 's/id: "//; s/"$//' | tr '\n' ' ')

  index_of() {
    local want=$1 i=0
    for id in $ORDER; do
      if [ "$id" = "$want" ]; then
        printf '%s' "$i"
        return 0
      fi
      i=$((i + 1))
    done
    printf '%s' "-1"
  }

  from_index=$(index_of "$FROM_STEP")
  threshold_index=$(index_of "$THRESHOLD")

  # Fail closed. If the order is unreadable, or the step is in neither list,
  # nothing here shows that resuming is free, so it does not run.
  if [ -z "$ORDER" ] || [ "$from_index" = "-1" ] || [ "$threshold_index" = "-1" ]; then
    block "could not read the ingest step order from scripts/ingest.ts, so the cost of --from-step $FROM_STEP is unknown. Run it yourself as LIVE_API_OK=1 pnpm ingest -- ... --from-step $FROM_STEP."
  fi

  if [ "$from_index" -ge "$threshold_index" ]; then
    block "resuming ingest at $FROM_STEP re-runs $THRESHOLD and every step after it, which spends ElevenLabs credits and voice slots. Re-run it as LIVE_API_OK=1 pnpm ingest -- ... --from-step $FROM_STEP only if the task named that spend."
  fi
fi

# --- .env reads in a delegate session ------------------------------------
#
# Copying .env into a worktree is pre-approved and needed by every one. Reading
# it is how a key lands in a transcript, so a session that declared itself a
# delegate (DELEGATE=1) may not. The command is walked one segment at a time so
# `cp a/.env .env && cat .env` cannot smuggle a read past the copy.

if [ "${DELEGATE:-}" = "1" ]; then
  READER='(^|[^[:alnum:]_-])(cat|less|more|view|head|tail|bat|strings|xxd|od|hexdump|base64|nl|tac|sort|uniq|tr|rev|wc|cut|paste|column|split|grep|egrep|fgrep|rg|ag|awk|sed|jq|python3?|node|perl|ruby|php|source|open|security)($|[[:space:]/.])'
  ENVREF='(^|[^[:alnum:]_-])\.env($|[^[:alnum:]_-])'

  OLD_IFS=$IFS
  IFS=$'\n'
  # shellcheck disable=SC2013 # deliberate line splitting
  for SEGMENT in $(printf '%s' "$COMMAND" | sed -E 's/(;|&&|\|\||\|)/\n/g'); do
    if printf '%s' "$SEGMENT" | grep -qE "$READER" && printf '%s' "$SEGMENT" | grep -qE "$ENVREF"; then
      IFS=$OLD_IFS
      block "a DELEGATE=1 session may copy .env into a worktree but not read it, so keys stay out of the transcript. Run the check against the admin UI, or ask the owner for the value you need."
    fi
  done
  IFS=$OLD_IFS
fi

exit 0
