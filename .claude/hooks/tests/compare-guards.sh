#!/usr/bin/env bash
# Usage: compare-guards.sh <head hook> <main hook> <commands.jsonl> <out file>
# Pipes each command to both guards (never runs them) and writes a row for
# every command where their exit codes differ. Last line of the out file is a
# count summary; rows with no string "cmd" are skipped and counted there.
#
# <commands.jsonl> holds one {"cmd": "..."} row per line. Build it yourself
# from your own transcripts, e.g. every Bash tool_input.command in
# ~/.claude/projects/*/*.jsonl. No corpus is committed here because
# transcripts are private and this repo is public. To keep a disagreement as
# a regression case, scrub it and add it to 292-corpus.jsonl with an id and
# a want. Not run in CI.
#
# perl's alarm is the per-command timeout, because macOS has no `timeout`.
HEAD_HOOK=$1 MAIN_HOOK=$2 CHUNK=$3 OUTF=$4
for f in "$HEAD_HOOK" "$MAIN_HOOK" "$CHUNK"; do
  [ -f "$f" ] && [ -r "$f" ] || { printf 'cannot read %s\n' "$f" >&2; exit 1; }
done
[ -n "$OUTF" ] && : >"$OUTF" || { printf 'cannot write the out file %s\n' "$OUTF" >&2; exit 1; }
total=0 diff=0 skipped=0
while IFS= read -r row || [ -n "$row" ]; do
  [ -z "$row" ] && continue
  if ! printf '%s' "$row" | jq -e '.cmd | type == "string"' >/dev/null 2>&1; then
    skipped=$((skipped + 1))
    continue
  fi
  payload=$(printf '%s' "$row" | jq -c '{tool_name:"Bash",tool_input:{command:.cmd}}')
  h_err=$(printf '%s' "$payload" | env -u DELEGATE -u CREDIT_OVERRIDE perl -e 'alarm 10; exec @ARGV' bash "$HEAD_HOOK" 2>&1 >/dev/null); h=$?
  m_err=$(printf '%s' "$payload" | env -u DELEGATE -u CREDIT_OVERRIDE perl -e 'alarm 10; exec @ARGV' bash "$MAIN_HOOK" 2>&1 >/dev/null); m=$?
  total=$((total + 1))
  if [ "$h" != "$m" ]; then
    diff=$((diff + 1))
    printf '%s' "$row" | jq -c --arg h "$h" --arg m "$m" --arg he "$h_err" --arg me "$m_err" '. + {head: $h, main: $m, head_err: $he, main_err: $me}' >>"$OUTF"
  fi
done <"$CHUNK"
printf '{"summary":true,"total":%s,"diff":%s,"skipped":%s}\n' "$total" "$diff" "$skipped" >>"$OUTF"
[ "$skipped" = 0 ] || printf '%s rows had no string "cmd" and were skipped\n' "$skipped" >&2
[ "$total" != 0 ]
