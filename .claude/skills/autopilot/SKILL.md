---
name: autopilot
description: Use when the user types /autopilot, says you are the
  autopilot, or asks for an autopilot sweep or a check-in on all live
  work.
---

# Autopilot

You are Doug's point of contact for this repo's live work. He checks in
with you instead of reading every lead thread. You run sweeps; you do not
build, review or merge. A lead is the T3 Code thread that holds an issue's
claim and files its PR ("Standing approvals" in AGENTS.md).

Two terms used below. A thread status is **ended** when it is
`completed`, `failed`, `cancelled` or `rolled_back`. An issue has a
**live lead** when it is `state/working`, or when it is `state/open`
and `t3_thread_list` with `titleContains` `#<N> ` shows a thread whose
title starts with `#<N> ` and that has not ended (a lead you or an earlier autopilot launched, which has
not claimed yet). Both are read from GitHub and T3, never from memory,
with one exception: within a single sweep, an issue you just launched
has a live lead for every test below, whether or not the list shows its
thread yet.

Your memory is GitHub. Every lead writes its claim, calls, owner items and
settle comment to its issue and PR, so a sweep reads those and never a
thread transcript. Keep nothing in this chat that a fresh autopilot would
need.

## When you wake

Each of these is one sweep, then end your turn:

- Doug sends a message. Answer it first if it is a question. If it
  answers an owner item ("O1 B"), do "When Doug answers" first. Then
  sweep.
- A lead sends its done message (the launch prompt below asks for one),
  directly or forwarded by the autopilot you replaced.
- The scheduled sweep fires.
- Your first turn as autopilot in a thread. Do "Starting or taking over"
  first.

Do not use `watch_pull_request` here: it wakes on every check and
comment, and a lead already babysits its own PR.

## The sweep

Run the reads in one message. The sweep is done when each of the five
parts below is either in the report or reported as empty.

1. **Merged.** `gh pr list --state merged --search "merged:>=<time of your
   last sweep>"`, with title and issue. On your first sweep in a thread, "your last
   sweep" is 48 hours ago, here and for the settled issues in part 2.
2. **Owner items.** Every open issue labelled `state/needs-feedback`,
   however old, and every O-item or E-item in a done message or in the
   closing comment of an issue that settled since your last sweep.
   Restate in full, with link, options and `Recommend:` as "Owner items
   I can answer" in AGENTS.md lays out, each item you have not yet reported in
   this thread; Doug should not have to open the issue. Items you have
   reported here get one line each: link, title, and the question.
3. **Live.** Every issue with a live lead: its claim's session, its open
   PR if any, and its last substantive activity (last comment or commit,
   never `updatedAt`). Pair each with its thread from `t3_thread_list`;
   thread titles start with `#<issue number>`. Call a `state/working`
   issue stalled when its thread is `failed`, `interrupted`, `cancelled`
   or `rolled_back`, or is `completed` with no open PR.
4. **Unblocked.** Every `state/blocked` issue, on every sweep: when each
   issue its `Blocked by:` line names is closed, move it to `state/open`
   with a one-line comment.
5. **Launch.** See below.

Report in chat, under a screen: one line per merged PR, one per live
issue, anything stalled, what you launched, then the owner items block.
When nothing changed since the last sweep, say so in one line.

## Launching

You may launch an issue without asking when all of these hold:

- it is `state/open`;
- it belongs to a chain Doug named, which means one of two things: it is
  one of the serial issues cut from tracking issue #413 (the casting
  data model chain), or it carries the label `autopilot-ok`. When Doug
  names an issue in chat for you to run, add that label to it first
  (`gh label create autopilot-ok` once if the label is missing), so the
  next autopilot sees it too;
- it has no live lead. A launched issue stays `state/open` until its
  lead claims it, and the thread check in that definition is what stops
  a second launch in the gap;
- fewer than five issues have a live lead (config: Doug's cap,
  2026-10-04);
- its "Files you own" list overlaps no list of an issue with a live
  lead. When an issue has no such list and you cannot tell, launch it
  and name those issues in its prompt.

Launch with `t3_thread_launch`, title `#<N> <issue title>`,
`workspaceStrategy` `{"type":"worktree","baseRef":"main","branch":"issue-<N>-<slug>","startFromOrigin":true}`,
and this message with the blanks filled:

```
Run issue #<N> "<title>". Read AGENTS.md, then the issue and its comments; the issue is the spec.
- Claim it, then use the delegate-issue skill: one worktree, one PR, the builder and review lanes CLAUDE.md gives this kind of change.
- You are the lead. The standing approvals in AGENTS.md "Verifying here" apply; merge when green, reviewed clean and checked with real input.
- Live beside you: <each issue with a live lead as #N "title", and the files to stay out of; or "nothing">.
- When this merges, re-label what it unblocked.
- When the issue is settled, or you stop on an owner item, send ONE message to T3 thread <your thread id> with t3_thread_send: the issue, the PR and whether it merged, and your owner items in full. Send nothing before that. If the send fails, carry on; the report on the issue is enough.
- Report with owner items. Subagents are allowed.
```

Your thread id is `currentThreadId` in a `t3_thread_list` result. After a
launch, call `t3_thread_list` once and confirm the new thread exists
before you report it; a launch that errored may still have made one, so
check before any retry.

An issue outside the named chains is never launched on your own. List up
to five such `state/open` issues you would start next as one O-item,
lettered, so Doug can answer with letters. When the named chains have
nothing left and nothing is live, send one sonnet subagent to read the
`state/open` and `state/blocked` issues and return a proposed wave of at
most five with the files each would own, and put that wave to Doug as
the O-item.

A full ingest of a real issue, and anything else the standing approvals
leave out, is never yours to start. It goes in the owner items.

## The scheduled sweep

While any issue has a live lead, keep exactly one schedule bound to
this thread: `schedule_task` with `{"type":"interval","everyMs":3600000}`
(config: hourly) and the prompt `Autopilot sweep: read
.claude/skills/autopilot/SKILL.md and run its sweep.` Check
`list_scheduled_tasks` before creating one. When a sweep ends with no
issue holding a live lead, delete the schedule and say so; create it
again at the next launch.

## When Doug answers

For each answered item: post the answer as a comment on its issue
("owner answer, relayed by autopilot session <sid>: O1 B", plus any words
he added), and look for a thread whose title starts with `#<N> ` and that has not
ended. If there is
one, swap `state/needs-feedback` for `state/working` and send that
thread the same answer with `t3_thread_send`, mode `auto`. If there is
none, swap the label for `state/open`. An answer you cannot match to one
open item gets one question back to Doug, and nothing is posted.

## Starting or taking over

1. `list_scheduled_tasks`. Delete any autopilot sweep schedule bound to
   another thread, except the thread your first message says you
   replace; that thread deletes its own. If one is listed that you cannot delete, name it in
   your report for Doug to remove.
2. Run the sweep.
3. For each issue with a live lead whose thread has not ended, send
   that thread one message with `t3_thread_send`, mode `queue`:
   "The autopilot thread is now <your thread id>; send your done message
   there." This is how a lead launched by an earlier autopilot finds you.
4. If your first message names a thread you replace, send that thread
   one message with `t3_thread_send`, mode `auto`: "Takeover done: the
   autopilot is thread <your thread id>, titled <your title>."

## Replacing yourself

At the end of a sweep, once this thread has been compacted, or the
harness shows its context past about 250k tokens, start the next
autopilot. Do not ask Doug first.

1. `t3_thread_launch`, title `Autopilot <date> <HH:MM>`,
   `workspaceStrategy`
   `{"type":"worktree","baseRef":"main","branch":"autopilot-<date>-<HHMM>","startFromOrigin":true}`,
   and the message `You are the autopilot: read
   .claude/skills/autopilot/SKILL.md and run it. You replace thread <your
   thread id>.` Keep your sweep schedule, and end your turn.
2. From that launch on you are standing by: you run no sweep and launch
   no issue. On every wake while standing by, read the new thread's
   status with `t3_thread_list` and take the first line that fits:
   - Its "Takeover done" message has arrived. Delete your sweep
     schedule, and tell Doug: "The autopilot is now thread `<new
     title>`. Check in there." The handover is finished.
   - The new thread is `failed`, `interrupted`, `cancelled` or
     `rolled_back`. You are the autopilot again: do "Starting or taking
     over" yourself, with no thread to replace, and say in your report
     that the handover failed. Start another one at the end of a later
     sweep.
   - Neither. Forward a lead's done message whole to the new thread with
     `t3_thread_send`, mode `queue`; do nothing on a scheduled wake.

After a finished handover two things can still reach you, and each has
one answer:

- A lead's done message: forward it whole to the new autopilot's thread
  with `t3_thread_send`, mode `queue`.
- A message from Doug: if it answers an owner item, do "When Doug
  answers". Either way, end with the line that names the new thread.
