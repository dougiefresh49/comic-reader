#!/usr/bin/env bash
# PreToolUse Bash guard: blocks paid commands, shell writes to the credit
# sources, and .env reads in a delegate. Rule list: paid-commands.txt, one rule
# per line, shared with the Edit guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
# It only ever reads the command string, never runs it.
#
# The command is walked one segment at a time (split on unquoted ; & && || |
# ( ) and newlines, plus the inside of an `sh -c "..."`), because the override
# and the thing it overrides have to be in the same segment. Without that,
# `echo LIVE_API_OK=1; pnpm generate-audio` would pass, and so would
# `rg "pnpm generate-audio"`.
#
# LIMIT: the command is lexed the way a shell splits it, with quotes, comments,
# backslash escapes and continued lines, but nothing is expanded: a variable
# holding the command name, $(...), backticks, eval and heredoc bodies are read
# as plain words. That is a known boundary (decisions row 204), not an
# oversight: this is a seatbelt for a delegate who forgets, not a sandbox.

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

# Words are split on \037 below; no word of a command should ever glob.
set -f
M=$'\035' # the mark on a redirect operator word, which no quoted ">" can carry

# Words that run the command after them rather than being it, compared on the
# basename, plus a bare count or duration (`nice -n 10`, `timeout 30`). Both
# executable finders read this one list: command_shape, and the sh -c unwrap
# in segments(), which gets it as awk's `wrap`. No backslashes: awk -v would
# eat them.
WRAPPER='^(env|command|builtin|exec|time|nohup|nice|sudo|xargs|timeout|stdbuf|[{]|!|if|then|elif|else|do|while|until|[0-9][0-9.]*[smhd]?)$'

# --- the rule list, read once ---------------------------------------------
#
# Into arrays, once: re-reading the list with a grep per rule per segment took
# 20 s on a 200-line command, against a 5 s hook timeout. A rule is its `&&`
# parts; a `script:` rule's first part is the script name.
NR_RULES=0 NR_FILES=0 PATS=()
while IFS= read -r line || [ -n "$line" ]; do
  spec=${line%% ::*}
  reason=${line#* ::}
  case "$spec" in
  file:*)
    F_PATH[NR_FILES]=${spec#file:} F_REASON[NR_FILES]=${reason# }
    NR_FILES=$((NR_FILES + 1)) && continue
    ;;
  script:* | cmd:*) R_KIND[NR_RULES]=${spec%%:*} rest=${spec#*:} ;;
  *) continue ;;
  esac
  R_REASON[NR_RULES]=${reason# } R_FROM[NR_RULES]=${#PATS[@]}
  while :; do
    part=${rest%%&&*} && part=${part% }
    PATS[${#PATS[@]}]=${part# }
    case "$rest" in *'&&'*) rest=${rest#*&&} ;; *) break ;; esac
  done
  if [ "${R_KIND[NR_RULES]}" = script ]; then
    R_NAME[NR_RULES]=${PATS[R_FROM[NR_RULES]]}
    R_FILE[NR_RULES]="scripts/${R_NAME[NR_RULES]}.ts"
    R_FROM[NR_RULES]=$((R_FROM[NR_RULES] + 1))
  fi
  R_TO[NR_RULES]=${#PATS[@]} && NR_RULES=$((NR_RULES + 1))
done <"$LIST"

# A `script:` rule also covers a direct run of its file, which is the
# scripts/...ts word in its package.json command (split-voice runs
# scripts/split-voice-clip.ts). Without package.json, scripts/<name>.ts stands.
SCRIPT_FILES=$(jq -r '.scripts // {} | to_entries[]
  | "\(.key)\t\([.value | scan("scripts/[^ \"]+\\.ts")][0] // "")"' \
  "$REPO_ROOT/package.json" 2>/dev/null)
while IFS=$'\t' read -r name file; do
  for ((k = 0; k < NR_RULES; k++)); do
    [ -n "$file" ] && [ "${R_NAME[k]}" = "$name" ] && R_FILE[k]=$file
  done
done <<<"$SCRIPT_FILES"

# --- segment splitting ----------------------------------------------------

# Print one segment per line, its words joined by \037, quotes removed and each
# word whole: `NODE_OPTIONS="--import tsx"` is one word, not a `tsx` standing
# where the executable goes. One pass, because quotes, comments and continued
# lines decide what each other mean: a ; inside a quoted curl header is text;
# a `# old command \` comment ends at its newline and does not swallow the
# next line; a backslash-newline outside one joins a wrapped `cp x \` to its
# destination. A redirect operator is its own word, marked with \035, so its
# target is the next word; a quoted newline is kept as \036. One level of
# `sh -c "..."` is unwrapped by lexing its word again at the end.
segments() {
  printf '%s' "$1" | awk -v wrap="$WRAPPER" '
    function endword() { if (inw) w[nw++] = cur; cur = ""; inw = 0 }
    function endseg(   i, j, line, b, sc) {
      endword()
      if (nw == 0) return
      line = w[0]
      for (i = 1; i < nw; i++) line = line "\037" w[i]
      print line
      # Only when the shell is the executable, found the way command_shape
      # finds it, so a quoted "bash" "-c" handed to printf is just text.
      for (i = 0; depth == 0 && i < nw; i++) {
        if (w[i] ~ /^(\035|-u$|--unset$|-C$|--chdir$)/) { i++; continue }
        b = w[i]; sub(/.*\//, "", b)
        if (w[i] ~ /^(-|[A-Za-z_][A-Za-z0-9_]*=)/ || b ~ wrap) continue
        # The options of the shell run up to its first other word: any of them
        # holding a c (-c, -cl, -lc) makes that word the command string, and
        # a -c after it (`bash script.sh -c`) is an argument to the script.
        for (j = i + 1; b ~ /^(ba|z|k|da)?sh$/ && j < nw; j++) {
          if (w[j] ~ /^-[a-zA-Z]*c[a-zA-Z]*$/) sc = 1
          if (w[j] !~ /^-/) { if (sc) inner[ninner++] = w[j]; break }
        }
        break
      }
      split("", w); nw = 0
    }
    function lex(s,   n, i, c, d, q, op) {
      cur = ""; inw = 0; nw = 0; split("", w); q = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1); d = substr(s, i + 1, 1)
        if (q == "\047") {
          if (c == "\047") q = ""; else cur = cur (c == "\n" ? "\036" : c)
          continue
        }
        if (q == "\"") {
          if (c == "\"") { q = ""; continue }
          if (c == "\\" && d == "\n") { i++; continue }
          if (c == "\\" && d != "" && index("\"\\$`", d)) { cur = cur d; i++; continue }
          cur = cur (c == "\n" ? "\036" : c)
          continue
        }
        if (c == "\\") { i++; if (d != "\n") { cur = cur d; inw = 1 }; continue }
        if (c == "\047" || c == "\"") { q = c; inw = 1; continue }
        if (c == " " || c == "\t") { endword(); continue }
        if (c == "#" && !inw) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
        if (c ~ /[\n;|()]/ || (c == "&" && d != ">")) { endseg(); continue }
        if (c ~ /[<>&]/) {
          # 2> and 2>> name a file descriptor; the digits belong to the operator.
          if (c != "&" && inw && cur ~ /^[0-9]+$/) { op = cur; cur = ""; inw = 0 } else { endword(); op = "" }
          op = op c
          if (c == "&") { op = op d; i++; d = substr(s, i + 1, 1) }
          if (index(op, ">") && (d == ">" || d == "|" || d == "&")) { op = op d; i++ }
          else if (c == "<" && (d == "<" || d == "&" || d == ">")) { op = op d; i++ }
          w[nw++] = "\035" op
          continue
        }
        cur = cur c; inw = 1
      }
      endseg()
    }
    { all = (NR > 1 ? all "\n" : "") $0 }
    END {
      gsub(/[\035\036\037]/, "", all)
      depth = 0; lex(all)
      depth = 1
      for (k = 0; k < ninner; k++) { s = inner[k]; gsub(/\036/, "\n", s); lex(s) }
    }'
}

# The executable a segment runs (its index in W, or -1), and whether the run of
# assignments in front of it named the override (OVERRIDE=1).
#
# `env`, `time`, `sudo` and the rest of WRAPPER run a command rather than
# being one, so the walk goes through them, their options (`env -u NAME`) and
# the assignments they carry, the way a shell would; a redirect and its target
# are stepped over too.
#
# The override has to be an exact LIVE_API_OK=1 in that leading run, which is
# where a shell would read it: `LIVE_API_OK=1.0` is another value, and
# `pnpm generate-audio -- LIVE_API_OK=1` is an argument. Only the paid rules
# take it; it is no release from the .env or guarded-file rules below.
command_shape() {
  local i t skip=0
  EXE_I=-1
  OVERRIDE=0
  for ((i = 0; i < ${#W[@]}; i++)); do
    t=${W[i]}
    if [ "$skip" = 1 ]; then skip=0 && continue; fi
    case "$t" in
    "$M"* | -u | --unset | -C | --chdir) skip=1 && continue ;;
    -*) continue ;;
    esac
    [[ ${t##*/} =~ $WRAPPER ]] && continue
    if [[ $t =~ $ASSIGN ]]; then
      [ "$t" = LIVE_API_OK=1 ] && OVERRIDE=1
      continue
    fi
    EXE_I=$i
    return
  done
}
ASSIGN='^[A-Za-z_][A-Za-z0-9_]*='

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
# path reaches the same rule. Sets REASON. A word that does not even contain a
# guarded file's name is ruled out before the path is normalized.
guarded_reason() {
  local f rel=
  for ((f = 0; f < NR_FILES; f++)); do
    case "$1" in *"${F_PATH[f]##*/}"*) ;; *) continue ;; esac
    [ -n "$rel" ] || rel=$(normalize_path "$1")
    case "$rel" in
    "$REPO_ROOT"/*) rel=${rel#"$REPO_ROOT"/} ;;
    esac
    case "$rel" in
    "${F_PATH[f]}" | *"/${F_PATH[f]}") REASON=${F_REASON[f]} && return 0 ;;
    esac
  done
  return 1
}

# Does this segment write files by the name of the command it runs? Only the
# executable counts, so `rg "cp" src/lib/models.ts` is a search, not a copy;
# `git mv` is the one subcommand that writes. -i is an in-place flag wherever
# it sits in sed's options, so it is looked for in any word. Redirects are
# checked on their own target in the loop below.
is_write_segment() {
  local t i
  case "${EXE##*/}" in
  tee | truncate | patch | dd | install | cp | mv) return 0 ;;
  sed | perl)
    for t in "${W[@]}"; do [[ $t =~ $INPLACE ]] && return 0; done
    ;;
  git)
    for ((i = EXE_I + 1; i < ${#W[@]}; i++)); do
      case "${W[i]}" in -*) ;; *) [ "${W[i]}" = mv ] && return 0 || return 1 ;; esac
    done
    ;;
  esac
  return 1
}
INPLACE='^-[a-zA-Z]*i(=|$)'

# --- per segment ----------------------------------------------------------

READER='(^|[^[:alnum:]_-])(cat|less|more|view|head|tail|bat|strings|xxd|od|hexdump|base64|nl|tac|sort|uniq|tr|rev|wc|cut|paste|column|split|grep|egrep|fgrep|rg|ag|awk|sed|jq|python3?|node|perl|ruby|php|source|open|security)($|[[:space:]/.<>])'

# Captured first, because a process substitution drops awk's exit status: a
# lexer that failed has not cleared the command, so it blocks.
SEGS=$(segments "$COMMAND" 2>/dev/null) || block "the command could not be lexed, so the paid-command list could not be checked."

while IFS= read -r SEG || [ -n "$SEG" ]; do
  [ -z "$SEG" ] && continue
  IFS=$'\037'
  W=($SEG)
  IFS=' '
  # The text form the cmd: rules and the reader check match: words joined by
  # spaces, quotes already gone, a redirect shown as its operator.
  TEXT="${W[*]}"
  IFS=$' \t\n'
  TEXT=${TEXT//$M/}
  TEXT=${TEXT//$'\036'/ }
  command_shape
  EXE=
  [ "$EXE_I" -ge 0 ] && EXE=${W[EXE_I]}

  # --- paid commands, unless this segment carries the override -----------

  if [ "$OVERRIDE" = 0 ]; then
    # A .ts file this segment runs: the executable itself, or a word after a
    # runner (tsx, node --import tsx, ./node_modules/.bin/tsx). `cat` or
    # `git log` on the same file is not a run.
    RUNS=()
    RUNNER=-1
    for ((i = 0; i < ${#W[@]}; i++)); do
      case "${W[i]##*/}" in
      tsx | node | ts-node | bun | vite-node | deno) [ "$RUNNER" -ge 0 ] || RUNNER=$i ;;
      *.ts)
        if [ "$i" = "$EXE_I" ] || { [ "$RUNNER" -ge 0 ] && [ "$RUNNER" -lt "$i" ]; }; then
          RUNS[${#RUNS[@]}]=$(normalize_path "${W[i]}")
        fi
        ;;
      esac
    done

    # A rule matches when its target does and every condition after `&&`
    # matches the text form. Rules are tried in list order.
    for ((k = 0; k < NR_RULES; k++)); do
      hit=1
      if [ "${R_KIND[k]}" = script ]; then
        # A pnpm segment with the script name as a word, so quoting and pnpm
        # options do not hide it, or a direct run of the script's file.
        hit=0
        if [ "$EXE" = pnpm ]; then
          for t in "${W[@]}"; do [ "$t" = "${R_NAME[k]}" ] && hit=1 && break; done
        fi
        for p in "${RUNS[@]}"; do
          case "$p" in "${R_FILE[k]}" | */"${R_FILE[k]}") hit=1 && break ;; esac
        done
      fi
      for ((j = R_FROM[k]; hit == 1 && j < R_TO[k]; j++)); do
        re=${PATS[j]}
        [[ $TEXT =~ $re ]] || hit=0
      done
      [ "$hit" = 1 ] && block "${R_REASON[k]}"
    done
  fi

  # --- a shell write onto a guarded credit source ------------------------
  #
  # A redirect writes only its own target: `2>/dev/null` next to a guarded
  # path is not a write to it, and `<` is a read.

  if [ "${CREDIT_OVERRIDE:-}" != "1" ]; then
    WRITES=()
    for ((i = 0; i < ${#W[@]}; i++)); do
      case "${W[i]}" in "$M"*'>'*) WRITES[${#WRITES[@]}]=${W[i + 1]} ;; esac
    done
    is_write_segment && WRITES=("${W[@]}")
    for TOKEN in "${WRITES[@]}"; do
      if guarded_reason "$TOKEN"; then
        block "$REASON That command writes the file from a shell; edit it with the Edit tool, or start the session with CREDIT_OVERRIDE=1."
      fi
    done
  fi

  # --- .env reads in a delegate session ----------------------------------
  #
  # Copying .env into a worktree is pre-approved and every worktree needs one.
  # Reading it is how a key lands in a transcript. LIVE_API_OK=1 does not
  # release this one; it names paid spend, not key access. `. .env` sources
  # it, which the reader list cannot see in text.

  if [ "${DELEGATE:-}" = "1" ] && { [[ $TEXT =~ $READER ]] || [ "$EXE" = . ]; }; then
    for t in "${W[@]}"; do
      case "$t" in
      *.env) block "a DELEGATE=1 session may copy .env into a worktree but not read it, so keys stay out of the transcript. Run the check against the admin UI, or ask the owner for the value you need." ;;
      esac
    done
  fi
done <<<"$SEGS"

exit 0
