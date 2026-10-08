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

# check <id> <want> <payload> [VAR=value ...]
check() {
  local err got
  err=$(printf '%s' "$3" | env -u DELEGATE -u CREDIT_OVERRIDE -u LIVE_API_OK "${@:4}" perl -e 'alarm 5; exec @ARGV or exit 127' "$GUARD_BASH" "$HOOK" 2>&1 >/dev/null)
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

# On stdin, not --arg: Linux caps one argument at 128 KiB.
patch() {
  printf '*** Begin Patch\n%s\n*** End Patch' "$1" | jq -Rsc '{tool_name:"apply_patch",tool_input:{input:.}}'
}

check edit-relative 2 "$(edit src/lib/models.ts)"
check edit-absolute 2 "$(edit "$REPO_ROOT/src/lib/models.ts")"
check edit-dotdot 2 "$(edit src/lib/../lib/models.ts)"
check edit-unguarded 0 "$(edit README.md)"
check patch-double-slash 2 "$(patch "$(hunks src/lib//models.ts)")"
check patch-unguarded 0 "$(patch "$(hunks src/a.ts)")"
check patch-dotdot 2 "$(patch "$(hunks src/lib/../lib/voice-settings.ts)")"
check patch-absolute 2 "$(patch "$(hunks "$REPO_ROOT/src/lib/tts-request.ts")")"
check patch-body-token 2 "$(patch "$(hunks src/a.ts)"$'\n'"+see x/../src/lib/tts-request.ts")"
# The grep's output decides the check, so the session's GREP_OPTIONS must not
# reach it.
check patch-grep-color 2 "$(patch "$(hunks src/lib/models.ts)")" GREP_OPTIONS=--color=always
check patch-grep-invert 2 "$(patch "$(hunks src/lib/models.ts)")" GREP_OPTIONS=-v
# A patch token gets the suffix match an Edit path gets (#721): a path into
# another checkout, and the second half of a repo root holding a space.
check patch-other-checkout 2 "$(patch "$(hunks /tmp/other-checkout/src/lib/models.ts)")"
check patch-root-with-space 2 "$(patch "$(hunks "/tmp/my repo/src/lib/models.ts")")"
check patch-same-name-elsewhere 0 "$(patch "$(hunks src/other/models.ts xsrc/lib/models.ts)")"
# A CRLF header: the \r survives jq and must not keep the token from matching.
check patch-crlf-header 2 "$(patch $'*** Update File: src/lib/models.ts\r\n@@\r\n-old line\r\n+new line\r')"
# A \r mid-path is a character of the path, not a split: main blocked this.
check patch-cr-mid-path 2 "$(patch "$(hunks $'src/lib\r/../lib/models.ts')")"

files=()
i=1
while [ "$i" -le 400 ]; do
  files[${#files[@]}]="src/x$i.ts"
  i=$((i + 1))
done
check patch-400-unguarded 0 "$(patch "$(hunks "${files[@]}")")"
check patch-400-guarded-last 2 "$(patch "$(hunks "${files[@]}" src/lib/models.ts)")"

# One 40 KB token before the guarded header: bash 3.2's ${p//x/y} is
# quadratic in it.
long=$(printf 'a/%.0s' $(seq 20000))
models=$(hunks src/lib/models.ts)
check long-token-double-slash 2 "$(patch "+$long//"$'\n'"$models")"
check long-token-dot 2 "$(patch "+$long/./"$'\n'"$models")"
check long-token-with-name 2 "$(patch "+$long//src/lib/models.ts"$'\n'"$models")"
# A long run of `..` costs depth times pops on bash 3.2: 75k deep, 30k pops.
deep=$(printf 'x/%.0s' $(seq 75000))$(printf 'y/../%.0s' $(seq 30000))
check long-token-dotdot 2 "$(patch "+${deep}src/lib/models.ts"$'\n'"$models")"

# About 100k tokens before the guarded header: 8192 lines of 12 words.
body=$'+w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12\n'
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do body=$body$body; done
check patch-100k-tokens 2 "$(patch "*** Add File: src/big.ts"$'\n'"$body$models")"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
