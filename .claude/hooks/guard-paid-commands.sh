#!/usr/bin/env bash
# PreToolUse Bash guard: blocks paid commands, shell writes to the credit
# sources, and .env reads in a delegate. Rule list: paid-commands.txt, one rule
# per line, shared with the Edit guard.
# Block contract (#85 decision 3): exit 2 with a one-line reason on stderr.
# It only ever reads the command string, never runs it.
#
# The command is walked one segment at a time (split on unquoted ; & && || |
# ( ) and newlines, plus the inside of an `sh -c "..."`, an `env -S "..."` and
# the remote command of an ssh), because the override and the thing it
# overrides have to be in the same segment. Without that,
# `echo LIVE_API_OK=1; pnpm generate-audio` would pass, and so would
# `rg "pnpm generate-audio"`.
#
# LIMIT: the command is lexed the way a shell splits it, with quotes, comments,
# backslash escapes, continued lines, $(...) and heredoc bodies (each body
# line read as a command when a shell can read the body, #671: a shell word or
# su on the line, sudo -s or -i, a quoted shell at command position, a pipe to
# a shell on the line after the body, or a $(...) whose output runs, #694;
# otherwise the body is text, apart from each $(...) under an unquoted
# delimiter), but nothing is expanded: a variable holding the command name,
# backticks and eval are read as plain words. That is a known boundary
# (decisions row 204), not an oversight: this is a seatbelt for a delegate who
# forgets, not a sandbox.

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
# A list that exists but cannot be read loads zero rules, which is no check.
if [ ! -r "$LIST" ]; then
  printf 'Blocked: %s cannot be read, so the paid-command list cannot be checked. Fix its permissions.\n' "$LIST" >&2
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
# A read that failed part way, or a list emptied by mistake, leaves no rule to
# check against; that is not a pass.
[ "$NR_RULES" -gt 0 ] || block "$LIST holds no script: or cmd: rule, so the paid-command list cannot be checked. Restore it from the repo."

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
# `env -S` string, the words after an ssh host, an unquoted $(...), and each
# heredoc body line alone when a shell reads the body. Every body is stepped
# over line by line, so an apostrophe in it cannot swallow the commands after
# it. Read as bytes (LC_ALL=C): every
# character the lexer acts on is ASCII, and macOS awk in a UTF-8 locale stops
# on some multibyte text (a `…` in a heredoc), which would block the command.
segments() {
  printf '%s' "$1" | LC_ALL=C awk '
    function endword(   b) {
      if (inw) { w[nw++] = (wq ? "\034" : "") cur; lp = 0 }
      if (inw && hdnext) { hd[nhd] = cur; hdq[nhd] = wq; hdd[nhd++] = hdnext == 2; hdnext = 0 }
      # An unquoted word that can read a heredoc as commands, anywhere on the
      # physical line (`cat <<EOF | bash`), so the bodies that line opens are
      # lexed as commands (#671). A quoted one counts at command position,
      # past wrappers (`sudo "bash"`), where a shell runs "bash" as bash; as
      # an argument it is text (#694).
      else if (inw) { b = cur; sub(/.*\//, "", b); if (b ~ SH && (!wq || cmdw(w, 0, nw) == nw - 1)) lsh = 1 }
      cur = ""; inw = 0; wq = 0
    }
    # The index in a[lo..hi) of the command a segment runs, past assignments,
    # redirects, and wrapper words with their options and values (-1 for
    # none): `sudo -u bob "bash"` runs bash (#694). command_shape below walks
    # the same way for the paid rules.
    function cmdw(a, lo, hi,   i, b, x, wr) {
      for (i = lo; i < hi; i++) {
        b = a[i]; sub(/^\034/, "", b)
        if (b ~ /^\035/) { i++; continue }
        if (wr != "" && b ~ /^-/) { x = vopt(b, WV[wr]); if ((x && x == length(b)) || b ~ WL) i++; continue }
        if (b ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || (wr != "" && b ~ /^[0-9][0-9.]*[smhd]?$/)) continue
        x = b; sub(/.*\//, "", x)
        if (x ~ /^(env|command|builtin|exec|time|nohup|nice|sudo|xargs|timeout|stdbuf)$/) { wr = x; continue }
        return i
      }
      return -1
    }
    # Where in option word b getopt finds its first letter from v, the
    # letters that take a value (0 for none): `-vp` takes the next word as
    # its value, `-p22` the rest of the word.
    function vopt(b, v,   x) {
      for (x = 2; x <= length(b); x++) if (index(v, substr(b, x, 1))) return x
      return 0
    }
    function queue(str, sh) { sub(/^\034/, "", str); ish[ninner] = sh; inner[ninner++] = str }
    # pipe: the segment ends in a pipe.
    function endseg(pipe,   i, j, line, b, sc, x, v, c) {
      endword()
      if (nw == 0) return
      line = w[0]
      for (i = 1; i < nw; i++) line = line "\037" w[i]
      print line
      # A $(...) whose output a shell runs is lexed in shell context, so a cat
      # heredoc inside it is commands (#694): under eval, or in a segment that
      # pipes into a shell (`echo "$(...)" | bash`). Its queue starts at ss0.
      c = cmdw(w, 0, nw); b = c < 0 ? "" : w[c]; sub(/^\034/, "", b); sub(/.*\//, "", b)
      if (b == "eval") for (x = ss0; x < ninner; x++) ish[x] = 1
      if (b ~ SH) for (x = pp0; x < pp1; x++) ish[x] = 1
      pp0 = pipe ? ss0 : 0; pp1 = pipe ? ninner : 0
      # Any unquoted shell word, so `pnpm exec bash -c` unwraps and a quoted
      # "bash" "-c" handed to printf does not. Its options run up to its first
      # other word: one holding a c (-c, -cl) makes that word the command
      # string, and a -c after it (`bash script.sh -c`) belongs to the script.
      for (i = 0; i < nw; i++) {
        b = w[i]; sub(/.*\//, "", b)
        if (w[i] ~ /^\034/) continue
        if (b ~ /^(ba|z|k|da)?sh$/) for (j = i + 1; j < nw; j++) {
          b = w[j]; sub(/^\034/, "", b)
          if (b ~ /^-[a-zA-Z]*c[a-zA-Z]*$/) sc = 1
          # Options that take the next word as their value (`-o pipefail`,
          # `-eo pipefail`, `+O extglob`, `--rcfile x`) do not end the walk
          # (#671), and neither does an o bundled before or after the c
          # (`-oc pipefail`, #694).
          if (b ~ /^([-+][a-zA-Z]*[oO][a-zA-Z]*|--rcfile|--init-file)$/) { j++; continue }
          if (b !~ /^-/) { if (sc) queue(b, 1); break }
        }
        # env -S splits its string into a command and runs it (#694), when env
        # is a wrapper in front of the command, not an argument (`echo env`).
        else if (b == "env" && (c < 0 || i < c)) for (j = i + 1; j < nw; j++) {
          b = w[j]; sub(/^\034/, "", b)
          if (b ~ /^-[^-]/ && (x = vopt(b, WV["env"]))) {
            v = x < length(b) ? substr(b, x + 1) : w[++j]
            if (substr(b, x, 1) == "S") { queue(v, 0); break }
          } else if (b ~ /^--split-string(=|$)/) { queue(b ~ /=/ ? substr(b, 16) : w[++j], 0); break }
          else if (b ~ /^--(unset|chdir)$/) j++
          else if (b !~ /^-/) break
        }
        # ssh joins the words after its host and a shell on the host runs them
        # (#694), when ssh is the command. Its options that take a value are
        # stepped over to find the host.
        else if (b == "ssh" && i == c) {
          for (j = i + 1; j < nw; j++) {
            b = w[j]; sub(/^\034/, "", b)
            if (b !~ /^-/) break
            if (vopt(b, "BbcDEeFIiJLlmOopQRSWw") == length(b)) j++
          }
          v = ""
          for (j++; j < nw; j++) {
            if (w[j] ~ /^\035/) { j++; continue }
            b = w[j]; sub(/^\034/, "", b); v = v (v == "" ? "" : " ") b
          }
          if (v != "") queue(v, 1)
        }
        # sudo -s, -i, --shell or --login hands a heredoc to a shell (#694);
        # its options end at the command, past the value of each.
        else if (b == "sudo") for (j = i + 1; j < nw; j++) {
          b = w[j]
          if (b ~ /^--(shell|login)$/) lsh = 1
          else if (b ~ WL) j++
          else if (b ~ /^-[^-]/) {
            x = vopt(b, WV["sudo"])
            if (substr(b, 1, x ? x - 1 : length(b)) ~ /[is]/) lsh = 1
            if (x == length(b)) j++
          } else if (b !~ /^-/) break
        }
        sc = 0
      }
      split("", w); nw = 0; ss0 = ninner
    }
    # The $(...) at i, quoted or not, through its matching paren: quotes are
    # respected, a nested "$(" inside quotes is scanned the same way, and a
    # heredoc body is stepped over whole lines to its delimiter. The inside is
    # queued for its own lex; the return is one past the closing paren.
    function subst(s, i, n, top,   j, e, t, dep, dl, dh, k, ln) {
      dep = 1; t = ""; dl = ""
      for (j = i + 2; j <= n && dep > 0; j++) {
        e = substr(s, j, 1)
        if (t == "\047") { if (e == "\047") t = ""; continue }
        if (e == "\\") { j++; continue }
        if (t == "\"" && e == "$" && substr(s, j + 1, 1) == "(") { j = subst(s, j, n, top) - 1; continue }
        if (t == "\"") { if (e == "\"") t = ""; continue }
        if (e == "\047" || e == "\"") t = e
        else if (e == "(") dep++
        else if (e == ")") dep--
        else if (substr(s, j - 1, 4) ~ /^[^<]<<[^<]/ && match(substr(s, j + 2), /^-?[ \t]*[^ \t\n;&|()<>]+/)) {
          dh = substr(s, j + 2, 1) == "-"
          dl = substr(s, j + 2 + dh, RLENGTH - dh); gsub(/[ \t\047"]/, "", dl)
          if (dl !~ /[A-Za-z_]/) dl = ""; else j += 1 + RLENGTH
        } else if (e == "\n" && dl != "") {
          while (j < n) {
            k = index(substr(s, j + 1), "\n")
            ln = k ? substr(s, j + 1, k - 1) : substr(s, j + 1)
            j = k ? j + k : n
            if (dh) sub(/^\t+/, "", ln)
            if (ln == dl) break
          }
          dl = ""
        }
      }
      if (dep && top) bad = 1
      # Shell context carries into a $(...) inside a -c string or shell-fed body.
      ish[ninner] = ctx
      inner[ninner++] = substr(s, i + 2, j - i - 2 - (dep == 0))
      return j
    }
    # sh is the shell context: s came from a -c string or a shell-fed body.
    # A $(...) at command position runs its output, so it gets that context
    # too (#694); endseg gives it to one under eval or piped into a shell.
    function lex(s, top, sh,   n, i, j, c, d, e, q, op, h, t, p, fed, n0, found, bt, x, a) {
      cur = ""; inw = 0; wq = 0; nw = 0; split("", w); q = ""; nhd = 0; hdnext = 0
      ctx = sh; lsh = 0; lp = 0; ss0 = ninner; pp0 = pp1 = 0
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1); d = substr(s, i + 1, 1)
        if (q == "\047") {
          if (c == "\047") q = ""; else cur = cur (c == "\n" ? "\036" : c)
          continue
        }
        if (q == "\"") {
          if (c == "\"") { q = ""; continue }
          if (c == "$" && d == "(") {
            j = subst(s, i, n, top); e = substr(s, i, j - i); gsub(/\n/, "\036", e)
            if (nw == 0 && cur == "") ish[ninner - 1] = 1
            cur = cur e; i = j - 1; continue
          }
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
          j = subst(s, i, n, top); e = substr(s, i, j - i); gsub(/\n/, "\036", e)
          if (nw == 0 && cur == "") ish[ninner - 1] = 1
          cur = cur e; inw = 1; i = j - 1; continue
        }
        if (c == "\n") {
          # endseg, not endword: its sudo -s check sets lsh.
          endseg(); fed = lsh || ctx; lsh = 0
        }
        if (c == "\n" && nhd) {
          # Each heredoc body line up to its delimiter (<<- strips tabs) is
          # queued, a line ending in an unescaped backslash joined to the next.
          # A closed body no shell reads (`cat <<EOF`, a gh --body) is text,
          # so its lines are dropped again; an unclosed one stays (#671).
          endseg()
          for (h = 0; h < nhd; h++) {
            n0 = ninner; found = 0
            while (i < n) {
              e = index(substr(s, i + 1), "\n")
              t = e ? substr(s, i + 1, e - 1) : substr(s, i + 1)
              i = e ? i + e : n
              # Under an unquoted delimiter bash joins a continued line before it
              # compares, so `E\` then `OF` ends the body (#671).
              d = hdq[h] ? t : p t; if (hdd[h]) sub(/^\t+/, "", d)
              if (d == hd[h]) { found = 1; break }
              if (t ~ /(^|[^\\])(\\\\)*\\$/) { p = p substr(t, 1, length(t) - 1); continue }
              ish[ninner] = 1; inner[ninner++] = p t; p = ""
            }
            if (p != "") { ish[ninner] = 1; inner[ninner++] = p }
            p = ""
            # `cat <<EOF |` with a shell on the line after the body: bash
            # carries the pipeline on there, so the last body is fed (#694).
            # Its command is found past wrappers, as cmdw does (`sudo bash`).
            if (lp && h == nhd - 1) {
              t = substr(s, i + 1); sub(/[\n;&|()<>].*/, "", t); gsub(/[\047"]/, "", t)
              sub(/^[ \t]+/, "", t); x = split(t, a, "[ \t]+"); x = cmdw(a, 1, x + 1)
              t = a[x]; sub(/.*\//, "", t); if (x > 0 && t ~ SH) fed = 1
            }
            if (found && !fed) {
              # With an unquoted delimiter, a $(...) in the body still runs
              # (`log: $(cmd)` under cat <<EOF), so each one is queued. The
              # scan reads the joined lines, so `$\` then `(` is still a $(.
              bt = ""; for (x = n0; x < ninner; x++) bt = bt inner[x] "\n"
              ninner = n0
              if (!hdq[h]) for (x = 1; x <= length(bt); x++) {
                if (substr(bt, x, 1) == "\\") x++
                else if (substr(bt, x, 2) == "$(") x = subst(bt, x, length(bt), 0) - 1
              }
            }
          }
          nhd = 0; lp = 0; ss0 = ninner; continue
        }
        if (c ~ /[\n;|()]/ || (c == "&" && d != ">")) {
          x = c == "|" && d != "|" && substr(s, i - 1, 1) != "|"
          endseg(x); lp = x; continue
        }
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
      # A top-level quote or $( still open at the end means the quotes were
      # misread (an ANSI-C $-quote with an escaped quote, quotes inside a
      # quoted $(...)), and
      # whatever came after may be a command: exit 3 so the caller blocks.
      if (q != "" && top) bad = 1
      endseg()
    }
    # Numeric from the start: an unset ninner indexes ish[] as "", not 0.
    # SH: a word that can read a heredoc as commands. WV: per wrapper, the
    # short options that take a value; WL: the long ones, any wrapper.
    BEGIN {
      ninner = 0; SH = "^(sh|bash|zsh|ksh|dash|eval|source|\\.|xargs|ssh|su)$"
      WV["sudo"] = "ugpChDUrtRT"; WV["env"] = "uCPS"; WV["xargs"] = "ILnPdEas"
      WV["stdbuf"] = "ioe"; WV["timeout"] = "sk"; WV["nice"] = "n"
      WL = "^--(user|group|prompt|chdir|host|role|type|other-user|close-from|chroot|command-timeout|delimiter|max-args|max-procs|arg-file|max-chars|process-slot-var|input|output|error|signal|kill-after|unset)$"
    }
    { all = (NR > 1 ? all "\n" : "") $0 }
    END {
      gsub(/[\034\035\036\037]/, "", all)
      lex(all, 1, 0)
      for (k = 0; k < ninner; k++) { s = inner[k]; gsub(/\036/, "\n", s); lex(s, 0, ish[k]) }
      exit bad ? 3 : 0
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
  local i t skip=0 wrap=
  EXE_I=-1
  OVERRIDE=0
  VIA_XARGS=0
  for ((i = 0; i < ${#W[@]}; i++)); do
    t=${W[i]}
    if [ "$skip" = 1 ]; then skip=0 && continue; fi
    case "$t" in
    "$M"* | -u | --unset | -C | --chdir) skip=1 && continue ;;
    -*)
      # An option that takes the next word as its value, for the wrapper it
      # follows: `timeout -s KILL 60` runs no KILL (#671). Per wrapper, since
      # `sudo -s` takes none. Long forms too (#694); `--opt=value` is one word.
      case "$wrap:$t" in
      timeout:-s | timeout:--signal | timeout:-k | timeout:--kill-after | sudo:-[ugpChDUrtRT] | xargs:-[ILnPdEas] | stdbuf:-[ioe]) skip=1 ;;
      sudo:--user | sudo:--group | sudo:--prompt | sudo:--host | sudo:--role | sudo:--type | sudo:--other-user | sudo:--close-from | sudo:--chroot | sudo:--command-timeout) skip=1 ;;
      xargs:--delimiter | xargs:--max-args | xargs:--max-procs | xargs:--arg-file | xargs:--max-chars | xargs:--process-slot-var | stdbuf:--input | stdbuf:--output | stdbuf:--error) skip=1 ;;
      esac
      continue
      ;;
    esac
    if [[ ${t##*/} =~ $WRAPPER ]]; then
      wrap=${t##*/}
      [ "$wrap" = xargs ] && VIA_XARGS=1
      continue
    fi
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
#
# WRITERS counts them, so a lone cp can be told from one beside another writer.
is_write_segment() {
  local i sed=0 inplace=0
  WRITERS=0
  for ((i = 0; i < ${#W[@]}; i++)); do
    [[ ${W[i]} =~ $INPLACE ]] && inplace=1
    cmd_name "$i"
    case "$CN" in
    tee | truncate | patch | dd | install | cp | mv | ed | ex) WRITERS=$((WRITERS + 1)) ;;
    sed | perl) sed=1 ;;
    esac
  done
  [ "$sed" = 1 ] && [ "$inplace" = 1 ] && WRITERS=$((WRITERS + 1))
  [ "$WRITERS" -gt 0 ]
}
INPLACE='^-[a-zA-Z]*i(=|$)'

# Where a cp or install run as the executable writes: its -t directory (TD),
# else its last word that is no option, option value or redirect (DEST), so
# `install x dest -m 644` writes dest (#694).
copy_dest() {
  local i
  DEST= TD=
  for ((i = EXE_I + 1; i < ${#W[@]}; i++)); do
    case "${W[i]}" in
    "$M"* | -m | --mode | -o | --owner | -g | --group | -S | --suffix) i=$((i + 1)) ;;
    -t | --target-directory) TD=${W[i + 1]} && i=$((i + 1)) ;;
    --target-directory=*) TD=${W[i]#*=} ;;
    -t?*) TD=${W[i]#-t} ;;
    -*) ;;
    *) DEST=${W[i]} ;;
    esac
  done
}

# --- per segment ----------------------------------------------------------

READER='(^|[^[:alnum:]_-])(cat|less|more|view|head|tail|bat|strings|xxd|od|hexdump|base64|nl|tac|sort|uniq|tr|rev|wc|cut|paste|column|split|grep|egrep|fgrep|rg|ag|awk|sed|jq|python3?|node|perl|ruby|php|source|open|security)($|[[:space:]/.<>])'

# Captured first, because a process substitution drops awk's exit status: a
# lexer that failed has not cleared the command, so it blocks. Exit 3 is the
# lexer saying it lost track of the quotes.
SEGS=$(segments "$COMMAND" 2>/dev/null)
case $? in
0) ;;
3) block "the command has a quote the guard cannot read past (an unclosed quote, an ANSI-C \$'...' with an escaped quote, or quotes inside a quoted \$(...)), so the paid-command list could not be checked. Rewrite it, for example with the commit message in a file (git commit -F)." ;;
*) block "the command could not be lexed, so the paid-command list could not be checked." ;;
esac

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
  # Where cmd: rules start matching (XO, offsets into TEXT): the executable and
  # each unquoted word after it, so a gh --body that quotes a curl line runs no
  # curl, and `env $(...) curl` or `find -exec curl` still do (#671). Offsets,
  # not a text per word: joining one per word took 3.7 s on 2000 words.
  XO=() off=0
  for ((i = 0; i < ${#W[@]}; i++)); do
    # The executable counts quoted or not: a shell runs "curl" as curl.
    if [ "$EXE_I" -ge 0 ] && [ "$i" -ge "$EXE_I" ]; then
      case "$i:${RW[i]}" in "$EXE_I":*) XO[${#XO[@]}]=$off ;; *:"$Q"*) ;; *) XO[${#XO[@]}]=$off ;; esac
    fi
    t=${W[i]//$M/}
    off=$((off + ${#t} + 1))
  done

  # --- paid commands, unless this segment carries the override -----------

  if [ "$OVERRIDE" = 0 ]; then
    # The .ts file this segment runs: the executable itself, or the first .ts
    # word after a runner (tsx, node, ./node_modules/.bin/tsx) that is the
    # executable or what pnpm exec/dlx, npx or bunx runs. `rg tsx x.ts` and a
    # second .ts handed to the script as an argument are not runs. These words
    # are read with their quotes gone, since a shell runs "tsx" as tsx (#671).
    RUN=
    r=$EXE_I
    CN=
    [ "$r" -ge 0 ] && CN=${W[r]##*/}
    case "$CN" in
    pnpm)
      # pnpm runs a bin, or a .ts file, when no script has that name (#671).
      # Its options that take a value (`-C /tmp/wt`) are stepped over with it,
      # and so is `run`: with no script by that name, pnpm run tsx runs the
      # bin (#694).
      NI=$((r + 1))
      while [[ ${W[NI]} == -* || ${W[NI]} == run || ${W[NI]} == run-script ]]; do
        case "${W[NI]}" in -C | --dir | --filter | -F | --workspace-dir | --loglevel | --reporter | --filter-prod | --test-pattern | --changed-files-ignore-pattern | --workspace-concurrency) NI=$((NI + 1)) ;; esac
        NI=$((NI + 1))
      done
      case "${W[NI]##*/}" in
      exec | dlx) next_word "$NI" && r=$NI ;;
      tsx | node | ts-node | bun | vite-node | deno | *.ts) r=$NI ;;
      esac
      ;;
    npx | bunx) next_word "$r" && r=$NI ;;
    esac
    CN=
    [ "$r" -ge 0 ] && CN=${W[r]##*/}
    case "$CN" in
    *.ts) RUN=${W[r]} ;;
    tsx | node | ts-node | bun | vite-node | deno)
      for ((i = r + 1; i < ${#W[@]}; i++)); do
        case "${W[i]}" in
        --import | -r | --require | --loader | --experimental-loader) i=$((i + 1)) ;;
        -*) ;;
        *.ts) RUN=${W[i]} && break ;;
        esac
      done
      ;;
    esac
    [ -n "$RUN" ] && RUN=$(normalize_path "$RUN")

    # A rule matches when its target does and every condition after `&&`
    # holds. Rules are tried in list order. A cmd: rule needs one start in XO
    # whose text meets every condition; a script: condition matches the start
    # of one word, so the dry run `--labels "/tmp/groups --execute.json"`
    # holds no --execute flag (#671).
    for ((k = 0; k < NR_RULES; k++)); do
      hit=1
      if [ "${R_KIND[k]}" = cmd ]; then
        # Whole TEXT first, the leading ^ dropped: a start can only match if
        # the whole text does, and most segments stop here in one test. That
        # holds while a cmd: pattern has no ^ other than its leading one.
        for ((j = R_FROM[k]; j < R_TO[k]; j++)); do
          re=${PATS[j]#^}
          [[ $TEXT =~ $re ]] || continue 2
        done
        hit=0
        for o in ${XO[@]+"${XO[@]}"}; do
          t=${TEXT:o}
          for ((j = R_FROM[k]; j < R_TO[k]; j++)); do
            re=${PATS[j]}
            [[ $t =~ $re ]] || continue 2
          done
          hit=1 && break
        done
        [ "$hit" = 1 ] && block "${R_REASON[k]}"
        continue
      fi
      if [ "${R_KIND[k]}" = script ]; then
        # A pnpm segment with the script name as a word, so quoting and pnpm
        # options do not hide it, or a direct run of the script's file, matched
        # on the basename so a run from inside scripts/ counts (#694).
        hit=0
        if [ "$EXE" = pnpm ]; then
          for t in "${W[@]}"; do [ "$t" = "${R_NAME[k]}" ] && hit=1 && break; done
        fi
        [ -n "$RUN" ] && [ "${RUN##*/}" = "${R_FILE[k]##*/}" ] && hit=1
      fi
      for ((j = R_FROM[k]; hit == 1 && j < R_TO[k]; j++)); do
        re="^(${PATS[j]})" hit=0
        for t in "${W[@]}"; do [[ $t =~ $re ]] && hit=1 && break; done
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
    # A lone cp or install writes only its destination, so a backup copy of a
    # guarded file is a read (#671). mv removes its source, and xargs appends
    # words after the last one, so those keep every word.
    if is_write_segment; then
      cmd_name "$EXE_I"
      case "$WRITERS:$CN:$VIA_XARGS" in
      1:cp:0 | 1:install:0) copy_dest; WRITES[${#WRITES[@]}]=${TD:-$DEST} ;;
      *) WRITES=("${W[@]}") ;;
      esac
    fi
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
