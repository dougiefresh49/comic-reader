#!/usr/bin/env bash
# Usage: edit-guard-cases.sh
# Pipes each case to ../guard-credit-config.sh as a PreToolUse payload and
# compares the hook's exit code with the case's want: 2 blocks, 0 passes. An
# Edit case carries a file_path. An apply_patch case carries no file_path and
# the patch text in a string field, the way codex sends it.
# Each hook call gets 5 s, the hook's timeout in .claude/settings.json: a block
# that comes later is no block in use, so it fails here (exit 142). The two
# 400-file patches are the timing cases (#705). GUARD_BASH (default bash) is
# the shell that runs the hook.
# Needs jq and perl. Runs on bash 3.2 and bash 5.
DIR=$(cd "$(dirname "$0")" && pwd)
HOOK="$DIR/../guard-credit-config.sh"
REPO_ROOT=$(cd "$DIR/../../.." && pwd -P)
GUARD_BASH=${GUARD_BASH:-bash}
pass=0
fail=0

# check <id> <want> <payload>
check() {
  local err got
  err=$(printf '%s' "$3" | env -u DELEGATE -u CREDIT_OVERRIDE -u LIVE_API_OK perl -e 'alarm 5; exec @ARGV or exit 127' "$GUARD_BASH" "$HOOK" 2>&1 >/dev/null)
  got=$?
  if [ "$got" = "$2" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s: want %s got %s %s\n' "$1" "$2" "$got" "$err"
  fi
}

edit() {
  jq -cn --arg f "$1" '{tool_name:"Edit",tool_input:{file_path:$f,old_string:"a",new_string:"b"}}'
}

# The hunks of one patch, one *** Update File header each.
hunks() {
  local out= f
  for f in "$@"; do
    out=$out"*** Update File: $f"$'\n@@\n * comment\n-old line\n+new line\n'
  done
  printf '%s' "$out"
}

patch() {
  jq -cn --arg p "*** Begin Patch"$'\n'"$1"$'\n'"*** End Patch" '{tool_name:"apply_patch",tool_input:{input:$p}}'
}

check edit-relative 2 "$(edit src/lib/models.ts)"
check edit-absolute 2 "$(edit "$REPO_ROOT/src/lib/models.ts")"
check edit-dotdot 2 "$(edit src/lib/../lib/models.ts)"
check edit-unguarded 0 "$(edit README.md)"
check patch-double-slash 2 "$(patch "$(hunks src/lib//models.ts)")"
check patch-unguarded 0 "$(patch "$(hunks src/a.ts)")"

files=()
i=1
while [ "$i" -le 400 ]; do
  files[${#files[@]}]="src/x$i.ts"
  i=$((i + 1))
done
check patch-400-unguarded 0 "$(patch "$(hunks "${files[@]}")")"
check patch-400-guarded-last 2 "$(patch "$(hunks "${files[@]}" src/lib/models.ts)")"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
