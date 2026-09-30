#!/usr/bin/env bash
# PreToolUse Bash guard: blocks paid commands, shell writes to the credit
# sources, and .env reads in a delegate. Rule list: paid-commands.txt, one rule
# per line, shared with the Edit guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
# It only ever reads the command string, never runs it.
#
# The command is walked one segment at a time (split on ; & && || | and
# newlines, plus the inside of an `sh -c "..."`), because the override and the
# thing it overrides have to be in the same segment. Without that,
# `echo LIVE_API_OK=1; pnpm generate-audio` would pass, and so would
# `rg "pnpm generate-audio"`.
#
# LIMIT: this matches shell text with patterns, it does not run a shell parser.
# It reads the ordinary ways a command is written. A deliberately mangled
# invocation (a variable holding the command name, an eval) can still get
# through, and that is a known boundary rather than an oversight.

PAYLOAD=$(cat)
COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)
JQ_STATUS=$?
if [ "$JQ_STATUS" -ne 0 ]; then
  # A guard that could not read the command has not cleared it. A payload that
  # is valid JSON with no command is a different thing, and passes below.
  printf 'Blocked: the hook payload was not readable JSON, so the paid-command list could not be checked.\n' >&2
  exit 2
fi
[ -z "$COMMAND" ] && exit 0

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIST="$HOOK_DIR/paid-commands.txt"
REPO_ROOT=$(cd "$HOOK_DIR/../.." && pwd -P)

if [ ! -f "$LIST" ]; then
  printf 'Blocked: %s is missing, so the paid-command list cannot be checked. Restore it from the repo.\n' "$LIST" >&2
  exit 2
fi

block() {
  printf 'Blocked: %s\n' "$1" >&2
  exit 2
}

# --- segment splitting ----------------------------------------------------

# Print one command segment per line. Also unwraps one level of `sh -c "..."`,
# because the outer segment would otherwise hide everything inside it. A
# comment runs to the end of the line, so one is dropped before splitting: a
# `# LIVE_API_OK=1` at the end of a line is not an assignment.
#
# Continued lines are joined first, and before the comment strip, because a
# backslash-newline is not a separator: a shell reads
#   cp replacement.ts \
#     src/lib/models.ts
# as one command, and a wrapped long argument is what a careful delegate
# writes. Splitting first would read it as two harmless ones.
segments() {
  local text
  text=$(printf '%s' "$1" | awk '
    {
      if (held) buf = buf " " $0; else { buf = $0; held = 1 }
      if (buf ~ /\\[ \t]*$/) { sub(/[ \t]*\\[ \t]*$/, "", buf); next }
      print buf
      buf = ""
      held = 0
    }
    END { if (held && buf != "") print buf }
  ')
  text=$(printf '%s\n' "$text" | sed -E 's/(^|[[:space:]])#.*$//')
  printf '%s\n' "$text" | sed -E 's/(;|&&|\|\||\||&|\n)/\n/g'
  printf '%s\n' "$text" |
    grep -oE "(^|[[:space:]])(ba|z|k|da)?sh[[:space:]]+-c[[:space:]]+[\"'][^\"']*[\"']" |
    sed -E "s/^.*-c[[:space:]]+[\"']//; s/[\"']\$//"
}

# The executable a segment runs, and whether the run of assignments in front
# of it named the override. Two lines: the executable, then `override` or
# `no-override`.
#
# `env` is a wrapper rather than a command, so the walk goes through it and
# the assignments it carries: `env NODE_ENV=production pnpm generate-audio`
# runs pnpm, and `env LIVE_API_OK=1 pnpm generate-audio` carries the override
# the way a shell would. Its options are stepped over too, so `env -u NAME`
# does not leave `-u` standing where the executable goes.
command_shape() {
  printf '%s' "$1" | tr -d "\"'<>" | awk '
    { for (i = 1; i <= NF; i++) {
        t = $i
        if (t == "-u" || t == "--unset" || t == "-C" || t == "--chdir") { skips = 1; continue }
        if (skips) { skips = 0; continue }
        if (t ~ /^-/) continue
        if (t == "env") continue
        if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
          if (t == "LIVE_API_OK=1") override = 1
          continue
        }
        exe = t
        break
      } }
    END { print exe; print (override ? "override" : "no-override") }'
}

# A segment runs pnpm when pnpm is the command being run, after any leading
# VAR=value assignments, not when the string merely mentions it.
invokes_pnpm() {
  [ "$(command_shape "$1" | head -n1)" = "pnpm" ]
}

# The override the paid rules name: LIVE_API_OK=1 as an env assignment in
# front of the executable, which is where a shell would read it. Only those
# rules take it; it is not a release from the .env or the guarded-file rules
# below.
#
# So the token has to be an exact LIVE_API_OK=1, and it has to sit in the run
# of leading assignments before the executable, through an `env` wrapper as
# well as in front of it. `LIVE_API_OK=1.0` is a different value, and
# `pnpm generate-audio -- LIVE_API_OK=1` is an argument the command never
# reads as an assignment, so neither one counts.
has_override() {
  [ "$(command_shape "$1" | tail -n1)" = "override" ]
}

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

# Does this path name a guarded file? Compared on the tail, so any worktree
# path reaches the same rule.
guarded_reason() {
  local path reason target rel
  rel=$(normalize_path "$1")
  case "$rel" in
  "$REPO_ROOT"/*) rel=${rel#"$REPO_ROOT"/} ;;
  esac
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
    file:*) ;;
    *) continue ;;
    esac
    target=$(printf '%s' "${line#file:}" | sed -E 's/[[:space:]]*::.*$//')
    reason=${line#*:: }
    case "$rel" in
    "$target") printf '%s' "$reason"; return 0 ;;
    *"/$target") printf '%s' "$reason"; return 0 ;;
    esac
  done <"$LIST"
  return 1
}

# Does this segment write a file? -i is an in-place flag wherever it sits in
# sed's options, and a redirect operator attaches to what follows it, so both
# are looked for anywhere in the segment rather than in one position.
is_write_segment() {
  printf '%s' "$1" | grep -qE '(^|[[:space:];|&(){}])(sed|perl)([[:space:]]|$)' &&
    printf '%s' "$1" | grep -qE '(^|[[:space:]])-[a-zA-Z]*i([=[:space:]]|$)' && return 0
  printf '%s' "$1" | grep -qE '(^|[[:space:];|&(){}])(tee|truncate|patch|dd|install|cp|mv)([[:space:]]|$)|[<>]'
}

# --- per segment ----------------------------------------------------------

while IFS= read -r SEG || [ -n "$SEG" ]; do
  [ -z "$SEG" ] && continue

  # Quoting removed and redirect operators turned into separators, so a token
  # is what a shell would hand to the program: `pnpm "generate-audio"` and
  # `printf x >src/lib/models.ts` both read plainly here. The operators go
  # first and the quotes come off after, because deleting the operator out of
  # `x>src/lib/models.ts` would weld the argument to the destination.
  DEQUOTED=$(printf '%s' "$SEG" | tr '><' '  ' | tr -d "\"'" | tr -s ' ')

  # --- paid commands, unless this segment carries the override -----------

  if ! has_override "$SEG"; then
    # rule 1: script:<name> [&& <ere>] , a pnpm run of a named script
    # rule 2: cmd:<ere> [&& <ere>]    , anything else, matched as written
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
      '' | '#'* | file:* | @from-step:*) continue ;;
      esac
      spec=${line%% ::*}
      reason=${line#*:: }
      case "$spec" in
      script:*)
        target=${spec#script:}
        cond=
        case "$target" in
        *'&&'*)
          cond=${target#*&&}
          target=${target%%&&*}
          ;;
        esac
        target=$(printf '%s' "$target" | sed -E 's/[[:space:]]+$//')
        # A token in the segment, so quoting and pnpm options do not hide it.
        # --from-step values come out first: they name a pipeline step rather
        # than a script being run, and the block below is the rule for those.
        invokes_pnpm "$SEG" || continue
        SCRIPTS=$(printf '%s' "$DEQUOTED" | sed -E 's/--from-step(=|[[:space:]]+)[a-z0-9-]+//g')
        printf '%s' "$SCRIPTS" | grep -qE "(^|[[:space:]])$target([[:space:]]|$)" || continue
        if [ -n "$cond" ]; then
          printf '%s' "$SEG" | grep -qE -- "$(printf '%s' "$cond" | sed -E 's/^[[:space:]]+//')" || continue
        fi
        block "$reason"
        ;;
      cmd:*)
        target=${spec#cmd:}
        cond=
        case "$target" in
        *'&&'*)
          cond=${target#*&&}
          target=${target%%&&*}
          ;;
        esac
        ok=1
        for PART in ${target//&&/$'\n'}; do
          printf '%s' "$SEG" | grep -qE -- "$(printf '%s' "$PART" | sed -E 's/^[[:space:]]+//')" || ok=0
        done
        if [ -n "$cond" ]; then
          printf '%s' "$SEG" | grep -qE -- "$(printf '%s' "$cond" | sed -E 's/^[[:space:]]+//')" || ok=0
        fi
        [ "$ok" = "1" ] && block "$reason"
        ;;
      esac
    done <"$LIST"
  fi

  # --- ingest resumed at or after a paid step ----------------------------
  #
  # `pnpm ingest -- --from-step <step>` re-runs that step and every step after
  # it. The order comes from scripts/ingest.ts at run time, not from a second
  # copy of the list, so the two cannot drift apart. The last --from-step wins,
  # which is what ingest's own parseArgs does with a repeated flag, and it is
  # read from the same dequoted text the script rules read, so a quoted flag
  # cannot hide it.

  LAST=$(printf '%s' "$DEQUOTED" | grep -oE -- "--from-step(=|[[:space:]]*)[a-z0-9][a-z0-9-]*" | tail -n1)
  FROM_STEP=$(printf '%s' "$LAST" | sed -E 's/^--from-step(=|[[:space:]]*)+//')

  if [ -n "$FROM_STEP" ] && ! has_override "$SEG" && invokes_pnpm "$SEG" && printf '%s' "$DEQUOTED" | grep -qE '(^|[[:space:]])ingest([[:space:]]|$)'; then
    INGEST_TS="$REPO_ROOT/scripts/ingest.ts"
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

  # --- a shell write onto a guarded credit source ------------------------

  if [ "${CREDIT_OVERRIDE:-}" != "1" ] && is_write_segment "$SEG"; then
    for TOKEN in $DEQUOTED; do
      if REASON=$(guarded_reason "$TOKEN"); then
        block "$REASON That command writes the file from a shell; edit it with the Edit tool, or start the session with CREDIT_OVERRIDE=1."
      fi
    done
  fi

  # --- .env reads in a delegate session ----------------------------------
  #
  # Copying .env into a worktree is pre-approved and every worktree needs one.
  # Reading it is how a key lands in a transcript. LIVE_API_OK=1 does not
  # release this one; it names paid spend, not key access.

  if [ "${DELEGATE:-}" = "1" ]; then
    READER='(^|[^[:alnum:]_-])(cat|less|more|view|head|tail|bat|strings|xxd|od|hexdump|base64|nl|tac|sort|uniq|tr|rev|wc|cut|paste|column|split|grep|egrep|fgrep|rg|ag|awk|sed|jq|python3?|node|perl|ruby|php|source|open|security)($|[[:space:]/.<>])'
    if printf '%s' "$DEQUOTED" | grep -qE "$READER" && printf '%s' "$DEQUOTED" | grep -qE '(^|[[:space:]])[^[:space:]]*\.env([[:space:]]|$)'; then
      block "a DELEGATE=1 session may copy .env into a worktree but not read it, so keys stay out of the transcript. Run the check against the admin UI, or ask the owner for the value you need."
    fi
  fi
done < <(segments "$COMMAND")

exit 0
