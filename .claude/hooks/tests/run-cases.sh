#!/usr/bin/env bash
# Usage: run-cases.sh [cases.jsonl ...]
# Pipes each case to ../guard-paid-commands.sh as a PreToolUse payload and
# compares the hook's exit code with the case's "want". Never runs a case's
# command. With no arguments it runs every *.jsonl next to this script.
# A row is {"id","want","cmd"} with an optional "env" object, e.g.
# {"DELEGATE":"1"}, and an optional "reason", text the hook's stderr must
# contain. A row that is not that shape fails, and so does a table with no rows.
# Each hook call gets 5 s, the hook's timeout in .claude/settings.json: a block
# that comes later is no block in use, so it fails here (exit 142). The alarm
# kills only the hook's own bash, so a child that never exits (a looping awk)
# hangs the run, and the CI job's timeout-minutes is what stops that. GUARD_BASH (default bash) is the shell that runs the hook.
# Needs jq and perl. Runs on bash 3.2 and bash 5.
DIR=$(cd "$(dirname "$0")" && pwd)
HOOK="$DIR/../guard-paid-commands.sh"
GUARD_BASH=${GUARD_BASH:-bash}
[ $# -eq 0 ] && set -- "$DIR"/*.jsonl
pass=0
fail=0
for cases in "$@"; do
  name=$(basename "$cases")
  if [ ! -r "$cases" ]; then
    fail=$((fail + 1))
    printf 'FAIL %s: cannot read the file\n' "$cases"
    continue
  fi
  rows=0
  while IFS= read -r row || [ -n "$row" ]; do
    [ -z "$row" ] && continue
    rows=$((rows + 1))
    if ! printf '%s' "$row" | jq -e -s 'length == 1 and (.[0] | type == "object" and (.id | type == "string") and (.want | type == "number") and (.cmd | type == "string") and ((has("env") | not) or (.env | type == "object")) and ((has("reason") | not) or (.reason | type == "string" and length > 0)))' >/dev/null 2>&1; then
      fail=$((fail + 1))
      printf 'FAIL %s row %s: not a {"id","want","cmd"} row\n' "$name" "$rows"
      continue
    fi
    id=$(printf '%s' "$row" | jq -r .id)
    want=$(printf '%s' "$row" | jq -r .want)
    reason=$(printf '%s' "$row" | jq -r '.reason // ""')
    payload=$(printf '%s' "$row" | jq -c '{tool_name:"Bash",tool_input:{command:.cmd}}')
    envs=()
    while IFS= read -r kv; do
      envs+=("$kv")
    done < <(printf '%s' "$row" | jq -r '(.env // {}) | to_entries[] | "\(.key)=\(.value)"')
    err=$(printf '%s' "$payload" | env -u DELEGATE -u CREDIT_OVERRIDE -u LIVE_API_OK ${envs[@]+"${envs[@]}"} perl -e 'alarm 5; exec @ARGV or exit 127' "$GUARD_BASH" "$HOOK" 2>&1 >/dev/null)
    got=$?
    if [ "$got" = "$want" ] && case "$err" in *"$reason"*) true ;; *) false ;; esac; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      printf 'FAIL %s:%s: want %s%s got %s %s\n' "$name" "$id" "$want" "${reason:+ with \"$reason\"}" "$got" "$err"
    fi
  done <"$cases"
  if [ "$rows" = 0 ]; then
    fail=$((fail + 1))
    printf 'FAIL %s: no cases\n' "$cases"
  fi
done
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
