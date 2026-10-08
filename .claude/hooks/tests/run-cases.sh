#!/usr/bin/env bash
# Usage: run-cases.sh [cases.jsonl ...]
# Pipes each case to ../guard-paid-commands.sh as a PreToolUse payload and
# compares the hook's exit code with the case's "want". Never runs a case's
# command. With no arguments it runs every *.jsonl next to this script.
# A row is {"id","want","cmd"} with an optional "env" object, e.g.
# {"DELEGATE":"1"}. GUARD_BASH (default bash) is the shell that runs the hook.
# Needs jq. Runs on bash 3.2 and bash 5.
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
  while IFS= read -r row || [ -n "$row" ]; do
    [ -z "$row" ] && continue
    id=$(printf '%s' "$row" | jq -r .id)
    want=$(printf '%s' "$row" | jq -r .want)
    payload=$(printf '%s' "$row" | jq -c '{tool_name:"Bash",tool_input:{command:.cmd}}')
    envs=()
    while IFS= read -r kv; do
      envs+=("$kv")
    done < <(printf '%s' "$row" | jq -r '(.env // {}) | to_entries[] | "\(.key)=\(.value)"')
    err=$(printf '%s' "$payload" | env -u DELEGATE -u CREDIT_OVERRIDE -u LIVE_API_OK ${envs[@]+"${envs[@]}"} "$GUARD_BASH" "$HOOK" 2>&1 >/dev/null)
    got=$?
    if [ "$got" = "$want" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      printf 'FAIL %s:%s: want %s got %s %s\n' "$name" "$id" "$want" "$got" "$err"
    fi
  done <"$cases"
done
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
