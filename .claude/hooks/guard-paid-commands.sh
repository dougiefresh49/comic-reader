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
# backslash escapes, continued lines, $(...) and heredoc bodies (each body
# line read as a command), but nothing is expanded: a variable holding the
# command name, backticks and eval are read as plain words. That is a known
# boundary (decisions row 204), not an oversight: this is a seatbelt for a
# delegate who forgets, not a sandbox.

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
Q=$'\034' # the mark on a word that had quotes in it, so is no command name

# Words command_shape steps over, compared on the basename: they run the next
# command rather than being it, or are a count (`nice -n 10`, `timeout 30`).
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

# Print one segment per line, words joined by \037, quotes removed, each word
# whole (`NODE_OPTIONS="--import tsx"` is one word). One pass, because quotes,
# comments and continued lines decide what each other mean: a quoted ; is
# text, a `# old \` comment ends at its newline, and a backslash-newline joins
# `cp x \` to its destination. Marks: \035 starts a redirect operator word
# (its target is the next word), \034 a word that had quotes, \036 stands for
# a quoted newline. Lexed again at the end: an unquoted `sh -c` string, an
# unquoted $(...), and each heredoc body line alone, so an apostrophe in a
# body cannot swallow the commands after it.
segments() {
  printf '%s' "$1" | awk '
    function endword() {
      if (inw && hdnext) { hd[nhd] = cur; hdd[nhd++] = hdnext == 2; hdnext = 0 }
      if (inw) w[nw++] = (wq ? "\034" : "") cur
      cur = ""; inw = 0; wq = 0
    }
    function endseg(   i, j, line, b, sc) {
      endword()
      if (nw == 0) return
      line = w[0]
      for (i = 1; i < nw; i++) line = line "\037" w[i]
      print line
      # Any unquoted shell word, so `pnpm exec bash -c` unwraps and a quoted
      # "bash" "-c" handed to printf does not. Its options run up to its first
      # other word: one holding a c (-c, -cl) makes that word the command
      # string, and a -c after it (`bash script.sh -c`) belongs to the script.
      for (i = 0; i < nw; i++) {
        b = w[i]; sub(/.*\//, "", b)
        if (w[i] ~ /^\034/ || b !~ /^(ba|z|k|da)?sh$/) continue
        for (j = i + 1; j < nw; j++) {
          b = w[j]; sub(/^\034/, "", b)
          if (b ~ /^-[a-zA-Z]*c[a-zA-Z]*$/) sc = 1
          if (b !~ /^-/) { if (sc) inner[ninner++] = b; break }
        }
        sc = 0
      }
      split("", w); nw = 0
    }
    function lex(s,   n, i, j, c, d, e, q, op, dep, h, t) {
      cur = ""; inw = 0; wq = 0; nw = 0; split("", w); q = ""; nhd = 0; hdnext = 0
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
        if (c == "\047" || c == "\"") { q = c; inw = 1; wq = 1; continue }
        if (c == " " || c == "\t") { endword(); continue }
        if (c == "#" && !inw) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
        if (c == "$" && d == "(") {
          # Through the matching paren, quotes respected; the word keeps it.
          dep = 1; t = ""
          for (j = i + 2; j <= n && dep > 0; j++) {
            e = substr(s, j, 1)
            if (t == "\047") { if (e == "\047") t = ""; continue }
            if (e == "\\") { j++; continue }
            if (t == "\"") { if (e == "\"") t = ""; continue }
            if (e == "\047" || e == "\"") t = e
            else if (e == "(") dep++
            else if (e == ")") dep--
          }
          inner[ninner++] = substr(s, i + 2, j - i - 2 - (dep == 0))
          e = substr(s, i, j - i); gsub(/\n/, "\036", e)
          cur = cur e; inw = 1; i = j - 1; continue
        }
        if (c == "\n") endword()
        if (c == "\n" && nhd) {
          # Each heredoc body line up to its delimiter (<<- strips tabs) is queued.
          endseg()
          for (h = 0; h < nhd; h++)
            while (i < n) {
              e = index(substr(s, i + 1), "\n")
              t = e ? substr(s, i + 1, e - 1) : substr(s, i + 1)
              i = e ? i + e : n
              d = t; if (hdd[h]) sub(/^\t+/, "", d)
              if (d == hd[h]) break
              inner[ninner++] = t
            }
          nhd = 0; continue
        }
        if (c ~ /[\n;|()]/ || (c == "&" && d != ">")) { endseg(); continue }
        if (c ~ /[<>&]/) {
          # 2> and 2>> name a file descriptor; the digits belong to the operator.
          if (c != "&" && inw && cur ~ /^[0-9]+$/) { op = cur; cur = ""; inw = 0 } else { endword(); op = "" }
          op = op c
          if (c == "&") { op = op d; i++; d = substr(s, i + 1, 1) }
          if (index(op, ">") && (d == ">" || d == "|" || d == "&")) { op = op d; i++ }
          else if (c == "<" && (d == "<" || d == "&" || d == ">")) { op = op d; i++ }
          if (op ~ /<<$/ && substr(s, i + 1, 1) ~ /[-<]/) op = op substr(s, ++i, 1)
          # << and <<- (not the <<< here-string): the next word is a delimiter.
          if (op ~ /<<-?$/ && op !~ /<<</) hdnext = op ~ /-$/ ? 2 : 1
          w[nw++] = "\035" op
          continue
        }
        cur = cur c; inw = 1
      }
      endseg()
    }
    { all = (NR > 1 ? all "\n" : "") $0 }
    END {
      gsub(/[\034\035\036\037]/, "", all)
      lex(all)
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

# CN is word $1 as a command name: its basename, or empty when it had quotes
# in it, because `rg "cp"` and printf 'bash' name no command. NI is the first
# word after $1 that is not an option.
cmd_name() {
  CN=
  [ "$1" -ge 0 ] || return 0
  case "${RW[$1]}" in "$Q"*) ;; *) CN=${RW[$1]##*/} ;; esac
}
next_word() {
  NI=$(($1 + 1))
  while [ "$NI" -lt "${#W[@]}" ] && [[ ${W[NI]} == -* ]]; do NI=$((NI + 1)); done
}

# Does this segment write files by the name of a command in it? Any unquoted
# word counts, wherever it sits (`xargs -I {} cp`, `find -exec cp`, `git mv`),
# and so does sed or perl with an in-place -i anywhere in its options.
# Redirects are checked on their own target in the loop below.
is_write_segment() {
  local i sed=0 inplace=0
  for ((i = 0; i < ${#W[@]}; i++)); do
    [[ ${W[i]} =~ $INPLACE ]] && inplace=1
    cmd_name "$i"
    case "$CN" in
    tee | truncate | patch | dd | install | cp | mv) return 0 ;;
    sed | perl) sed=1 ;;
    esac
  done
  [ "$sed" = 1 ] && [ "$inplace" = 1 ]
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
  RW=($SEG)
  SEG=${SEG//$Q/}
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
    # The .ts file this segment runs: the executable itself, or the first .ts
    # word after a runner (tsx, node, ./node_modules/.bin/tsx) that is the
    # executable or what pnpm exec/dlx, npx or bunx runs. `rg tsx x.ts` and a
    # second .ts handed to the script as an argument are not runs.
    RUN=
    r=$EXE_I
    cmd_name "$r"
    case "$CN" in
    pnpm) next_word "$r" && case "${W[NI]}" in exec | dlx) next_word "$NI" && r=$NI ;; esac ;;
    npx | bunx) next_word "$r" && r=$NI ;;
    esac
    cmd_name "$r"
    case "$CN" in
    *.ts) RUN=${W[r]} ;;
    tsx | node | ts-node | bun | vite-node | deno)
      for ((i = r + 1; i < ${#W[@]}; i++)); do
        case "${W[i]}" in
        --import | -r | --require | --loader) i=$((i + 1)) ;;
        -*) ;;
        *.ts) RUN=${W[i]} && break ;;
        esac
      done
      ;;
    esac
    [ -n "$RUN" ] && RUN=$(normalize_path "$RUN")

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
        case "$RUN" in "${R_FILE[k]}" | */"${R_FILE[k]}") hit=1 ;; esac
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
