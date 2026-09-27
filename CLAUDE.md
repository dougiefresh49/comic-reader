<!-- fleet corefile: CLAUDE-base.md
     Copy to a new repo's root as CLAUDE.md next to the instantiated
     AGENTS.md. This layer is main-session/orchestrator concerns only.
     Everything shared lives in AGENTS.md so delegated prompts can shrink
     to "read AGENTS.md, then do issue #N." Keep the roster synced with
     the fleet repo's copy when models or budget posture change.
     Instantiated from fleet corefiles @ 4a9e5f8, 2026-09-27 -->

@AGENTS.md

# Claude main-session guidance

Everything above (AGENTS.md) is the shared rulebook. It applies to every
agent, including subagents. What follows is for the orchestrating Claude
session only.

## Model roster

Rankings, higher = better on every column. A high cost score means
cheap for us (subscriptions with generous limits rank high), not pricey.
Intelligence is how hard a problem the model can take unsupervised; taste
covers UI/UX, code quality, API design, and copy.

| model         | cost | intelligence | taste | reachable via                                                                        |
| ------------- | ---- | ------------ | ----- | ------------------------------------------------------------------------------------ |
| composer-2.5  | 8    | 5            | 5     | cursor-agent CLI (`agent`)                                                           |
| grok-4.5      | 8    | 6            | 6     | cursor-agent CLI (`--model cursor-grok-4.5-high`; `-medium`/`-low` for lighter work) |
| grok-4.7      | 7    | 7            | 3     | cursor-agent CLI (`--model grok-4.7-high`); review and audit only, see below         |
| gpt-6 Astra   | 7    | 8            | 5     | codex CLI (the config default, at medium effort)                                     |
| gpt-5.6 Sol   | 7    | 8            | 5     | codex CLI (`codex -m` Sol tier)                                                      |
| gpt-5.6 Terra | 8    | 7            | 5     | codex CLI (`codex -m` Terra tier)                                                    |
| gpt-5.6 Luna  | 8    | 4            | 4     | codex CLI (`codex -m` Luna tier)                                                     |
| sonnet-5      | 5    | 5            | 7     | Agent/Workflow `model: 'sonnet'`                                                     |
| opus-5.5      | 8    | 8            | 7     | Agent/Workflow `model: 'opus'`                                                       |
| fable-5.1     | 2    | 9            | 9     | Agent/Workflow `model: 'fable'`                                                      |

**opus-5.5 vs fable-5.1** (config from outside evidence, not yet
auditioned here: Theo's day-one video "Anthropic Actually Fixed Opus",
2026-09-23, https://www.youtube.com/watch?v=jgGyX7MPPVg, cited by
timestamp. Fleet `docs/decisions.md` row 24 is the call and supersedes
row 6, which benched opus-5):

- opus-5.5 is the default Anthropic subagent for day-to-day work:
  bounded implementation, bug-fix PRs, prose a person reads, three.js
  and web demos. A heavy full day of Theo's cost about 20% of one weekly
  Claude limit (19:29-20:53).
- Run opus-5.5 at medium, high, or xhigh. Low is too weak for its price
  (15:19). Max looped 6.5 hours on one markdown plan (17:32), and on
  Skatebench it spent over 10x xhigh's reasoning tokens for a 1% score
  bump (18:10-19:09). Changing effort mid-session keeps the prompt cache
  on Claude Code v2.1.280+ (12:46).
- fable-5.1 stays the pick for design invention (animation detail,
  layout, marketing pages: 24:37-26:29), long unattended or open-ended
  runs, and auditing a run that already went wrong. A supervising Claude
  Code session auditing a slow three-hour run warned that the worker was
  10% from auto-compact and a crash would lose its work, which Theo
  called nonsense and a discernment gap (34:27-35:45). He also sees
  opus-5.5 get stuck repairing what needs no repair, and expects those
  misses to grow with job length (37:36-38:35).
- Deep review stays with the review lanes below: on Theo's review bench
  fable-5.1 scored 69.7 and opus-5.5 67.5, behind GPT-6 Astra at 83.8
  (21:48).

**fable-5.1 effort, and gpt-6 Astra beside it** (config from outside
evidence, not yet auditioned here: Theo's video "So I was using Fable
wrong...", 2026-09-22, https://www.youtube.com/watch?v=-XWSJM-Ue-o,
cited by timestamp; fleet `docs/decisions.md` row 25):

- Run fable-5.1 at high, xhigh for deep, thorough work. High on a
  simple task stays cheap, while low and medium fail often enough that
  the rerun costs more (05:50-06:49). Drop to low or medium only to keep
  a known rabbit hole shallow (07:44). Theo almost never uses max
  (05:50-06:18); treat it as a rare exception.
- gpt-6 Astra is what `codex` runs when no `-m` is passed, and it
  holds the codex review lane that fleet text called Sol until #86. Theo finds
  it a slightly better reviewer than fable-5.1, has Fable ask it to
  review or test changes, and prefers codex for computer use on macOS
  (25:07-26:07). It is spiky, sometimes better than Fable and sometimes
  far worse, and at the extremes it loops and burns usage (00:50,
  04:31). Route it to verification and to the review lanes below that
  name it, and leave long unattended authoring to Fable. Its roster scores copy gpt-5.6 Sol's
  until we audition it here.

**Briefing opus-5.5** (config from outside evidence, not yet auditioned
here: Theo's video "Getting the most out of Opus 5.5", 2026-09-25,
https://www.youtube.com/watch?v=ejjBbaq9RmY, which walks through Addy
Osmani's Anthropic playbook for the model, cited by timestamp; fleet
`docs/decisions.md` rows 26 and 27):

- The brief names the finish line, the only stops, and the actions
  already approved. On long tasks opus-5.5 pauses to report or to offer
  to continue unless the brief names its stops (18:21-18:56). A brief
  asking for phases 0 to 7 in one pass still stopped after phase 0, and
  kept going only once told to hold every question until phase 7 was
  done (09:36-10:34). One that pre-approved copying the env vars and
  told the model to ask if the move didn't work finished a 17-minute
  setup without stopping (06:26-09:39).
- Say subagents are allowed when the work splits (an audit, a
  migration, a pile of reviews). opus-5.5 holds back from spawning them
  unless told, and sometimes even then (20:28-21:27).
- Design work routed to opus-5.5 lists the styles to leave out. With no
  direction it falls back to a few default styles, and a general "avoid
  generic looks" only swaps one default for another (17:25-17:55).
  Theo rated fable-5.1's designs clearly better than opus-5.5's on the
  "Which AI Made This?" comparison, and reads opus-5.5's strength as
  following design direction, the don'ts most of all (16:30-17:27).

**grok-4.7** (config from outside evidence plus one audition here:
Theo's video "Elon promised this one would be good...", 2026-09-22,
https://www.youtube.com/watch?v=jLgpzgpsWPc, cited by timestamp; fleet
`docs/decisions.md` row 30):

- Review and audit only. On Theo's codebase-audit bench (each model
  lists where T3 Code needs work, fable-5.1 and Astra judge) it scored
  80.7 running in Grok Build, just behind Astra's 83.8 in Codex and
  ahead of fable-5.1's 69.7 (22:08-23:47). He finds it weaker than
  fable-5.1 and Astra at the extremes, but with a higher floor, and
  inquisitive: it digs deeper than models of its class usually do, and
  has found things fable-5.1 and Astra missed (21:40-22:10). Our one
  audition through cursor-agent (`grok-4.7-high`, fleet #100, a small
  roster diff) found every defect Astra found plus four more, in about
  6 minutes to Astra's 2.
- Never for design or anything a person looks at. Theo rates its
  front-end output among the worst he has seen from any model
  (18:25-18:56), and its 3D game from the prompt Astra got was a mess
  (24:39-25:37).
- Not the bulk authoring lane; grok-4.5 keeps that for mechanical
  work (the builder lanes below). 4.7 spends about
  twice the tokens of earlier grok models (15:03-15:33), its worst audit
  run cost almost twice Astra's worst ($19.49 to $11.44) because it kept
  verifying things that didn't matter (23:45-24:14), and one build ran
  over an hour (24:11-24:41). The fast, cheap grok Theo liked was 4.5
  (24:11). His verdict on 4.7 overall: a bit of a flop and a stepping
  stone (25:39-26:44).

How to apply:

- **Budget posture: go ham with every model EXCEPT Fable** (opus-5.5
  included, at the efforts above). Fable weekly usage is the scarce
  resource. It drives the main session and burns fast. Sonnet and opus
  subagents and cursor-agent have headroom; use them liberally. Codex
  too, with one carve-out: as a PR review gate Astra takes only the
  class the review lanes below give it (my call, row 33: review rounds
  in a wave were spending the codex 5-hour window that computer use
  also draws on; my report, not measured). Throttle a
  provider only when the `ai-usage` skill shows it actually near
  capacity, not preemptively. Budgets are per-pool, not per-token. The
  binding constraint is subscription shape (field test: codex burned 8×
  fable's tokens, fable was still the bottleneck).
- Defaults, not limits. You have standing permission to escalate to a
  smarter model without asking when a cheaper model's output misses the bar.
  Judge the output, not the price tag.
- Builder lanes, by how much the builder has to decide (config; owner
  call 2026-09-27, fleet `docs/decisions.md` row 32):
  - The test: could you predict the diff before it is written? Yes is
    mechanical (renames, sweeps, migrations and batch refactors from a
    written list, however many files): composer-2.5 or grok-4.5 via
    cursor-agent.
  - No means the builder decides something (logic, scripts, a fix
    round, a spec with a design choice in it): opus-5.5, as an Agent
    subagent in its own worktree, briefed as above. This is the default
    builder.
  - Copy, skills, corefile prose and design invention are taste work
    and follow the taste line below, not this one.
  - A clear spec does not make work mechanical; every delegated issue
    has one. On the comic-reader wave of 2026-09-27 grok-4.5 met every
    gate on three lanes in about four minutes each, and on the one that
    needed judgment it built the fix brief's four copy-pasted loops and
    hand-written tokenizer without pushing back on the size (comic-reader
    #55, the pair under "Push back on the spec" in AGENTS.md).
  - Long unattended or open-ended lanes stay with fable-5.1.
- User-facing design *invention* needs taste ≥ 7: sonnet-5 minimum,
  fable-5.1 preferred, opus-5.5 as the budget fallback. Faithful
  implementation against a decided, written design artifact (a Figma
  node, a vendored mirror, a spec) is well-specced execution and goes
  through the builder lanes above. No written artifact = invention; the
  taste bar applies.
- Review lanes, by what could go wrong, not by diff size (config, fleet
  `docs/decisions.md` row 33; the evidence is Sol's first round on
  fleet #60, 2026-08-29, finding three real script bugs in a small
  deploy-script diff, and the grok-4.7 audition on fleet #100):
  - Mechanical diffs (renames, path parametrization, dash sweeps, doc
    moves): the scripted check is the gate (`bash -n`, `tsc`, a literal
    grep), plus at most one grok pass via cursor-agent as a second
    reader, `agent --workspace <repo> -p --mode=ask "Review the diff of
    PR #N against issue #N; list only concrete defects with file:line"`
    with `--model grok-4.7-high`.
  - Anything near money or data (credit logic, a credit guard, a lock
    file, code that writes production rows, a guard for any of those):
    Astra (the `codex-review` skill), first review and rounds. This
    line wins over the logic line when a PR fits both; a mechanical
    diff stays on the mechanical gate wherever it lands. Astra's first round on comic-reader
    PR #135 (2026-09-27, a guard for a wrong-row write; the verdict is
    on the PR) found four defects, all then fixed, that the builder's
    gates and the orchestrator's acceptance checks had passed.
  - Every other logic change or script: grok-4.7, the same command,
    for the first review and for every round after a fix.
  - Meaning changes (user-facing text, design, corefile rules,
    prompts): fable, as the `reviewer` agent, once per PR, and that
    read is the first review whatever else the PR touches. The rounds
    after it go to Astra when the PR is also in its class, and
    otherwise to grok-4.7, which checks each fix against fable's
    finding and does not re-grade the prose. Never two frontier reviews
    (fable, Astra) per round.
  - A mechanical PR whose fix changes behavior is a logic PR from the
    next round on.
  - Composer and grok-4.5 never review. grok-4.7 is the only
    cursor-agent review lane. When `ai-usage` shows codex exhausted,
    the Astra class drops to opus-5.5 without asking me: the `reviewer`
    agent with `model: 'opus'`, fresh context, first review and rounds.
    The verdict comment says opus stood in for Astra (my call,
    2026-09-27).
- `unslop` grades prose a person reads and `writing-for-agents` grades
  documents an agent consumes; skills, corefiles, and delegate briefs go
  through `writing-for-agents` before they ship.
- Never use Haiku for judgment, and never accept a haiku subagent's
  self-assessment as evidence, since 7% of its corpus messages open with
  "Perfect!"/"Excellent!" (audit §3, haiku profile: maximal enthusiasm,
  zero calibration). For trivial work: composer-2.5 or gpt-5.6 Luna.
- cursor-agent runs composer/grok by default; any other model through it
  bills the small Cursor `api` pool, not the first-party quota. Fable
  through cursor-agent is the overflow route when the Anthropic Fable
  budget is nearly out and `ai-usage` shows the Cursor `api` pool under
  80% (fleet `docs/decisions.md` row 7). `agent models` lists the
  current ids, never a remembered one; the machine-level `cursor-agent`
  skill has the mechanics.
- Named skills (`ai-usage`, `codex-review`, `cursor-agent`) are installed
  at the machine level on Doug's boxes, not vendored per-repo. If one is
  missing here, say so and use the raw CLI instead of improvising.

## Session token hygiene

Long main-session context is the Fable cost driver, not delegated agents.
Per-task cost ≈ context size × wakeup count, because every background-task
notification re-reads the whole conversation. This section is spend
policy (config); the measurement behind it is fleet `docs/decisions.md`
row 9.

- During big multi-stage rounds, the main session stops authoring code:
  chunks beyond small surgical edits go to a delegate against a written
  spec (the builder lanes in the roster section; a fresh-context fable
  subagent when the chunk is taste work or a long open-ended run). The
  main session does
  specs, targeted diff review, merges. Ordinary small tasks: author freely.
- Codebase recon goes to composer-2.5 or an Explore subagent (Claude
  Code's read-only search agent type). Don't pull
  2,000-line files into the main context when a delegate can return the
  20 lines that matter.
- Batch verification into ONE delegated round with the complete
  checklist; every extra round-trip is a full-context wakeup.
- In a multi-turn main session that passes about 250k tokens, name a good
  compact point once; subagents and delegates never comment on context
  hygiene. Follow-up work discovered mid-task goes to the backlog, not the
  current session: file a GitHub issue (or a backlog line for an idea)
  with enough context to start cold, so the owner can run it in another
  worktree in parallel. Never "compact, then I'll start on B" (fleet
  `docs/decisions.md` row 8).

## Delegation mechanics

- Delegate prompt shape (the field-test exemplar `delegate-spec-task-67.md`,
  zero merge conflicts across 36 PRs): read AGENTS.md → issue #N is the spec → existing
  machinery to reuse → decisions already made → **Files you own / Do NOT
  touch** → gates → commit-but-don't-push. Ownership is decided at spec
  time, not merge time.
- Check CLI availability before delegating (`command -v agent`,
  `command -v codex`); fall back to a Claude subagent if missing, with
  the same worktree isolation when it writes code.
- opus-5.5: the Agent tool with `model: 'opus'` and
  `isolation: 'worktree'`.
- composer/grok: `agent --worktree -p --force "prompt"`; non-`-fast`
  variants only. codex: `codex exec` / `codex review`. The local codex
  config pins the default model (tier slugs drift; check it), pass
  `-c model_reasoning_effort="high"` for deep work; background long runs.
- **Two-deadline rule on any external wait** (field-test E3): arm an ack
  timeout and a completion timeout the moment the wait starts; silence is
  not success. Numbers, fallback, and BAD/GOOD live in the `babysit-pr`
  skill.
- **Every "done" from a delegate is a claim requiring one artifact
  produced by someone other than the builder.** The verifier runs the
  check itself, and the artifact must be one that would look different
  if the claim were false. Accepting the builder's own screenshot or
  log doesn't count (field-test E1/E4: the builder self-attested a
  design match nobody independently checked). Builders over-deliver
  against tight specs; verifiers under-verify unless forced to produce
  artifacts. Keep the verifier separate from the builder for anything
  user-visible.
- Recon goes to the `scout` agent, one independent review goes to the `reviewer` agent (both fleet `agents/`, installed machine-level), and a multi-model panel goes to the `interrogate` skill.

## Repo-specific orchestration

- Delegate only to cursor-agent, codex and Claude models. Never agy/Antigravity (owner call 2026-07-07: flaky headless behavior). Never Haiku, not even for trivial work.
- Browser and computer-use verification goes to codex (the `codex-computer-use` skill) as one delegated round with the whole checklist, audio playback included. claude-in-chrome from the main session is fine for one screenshot plus one console read, nothing more. The reason is the 2026-07-15 owner audit: 92% of usage happened above 150k context, browser-MCP ping-pong from the main loop was 12% of it, and one 13-hour session with ~60 wakeups burned 17.7M cache-read tokens.
- Every delegate brief restates four AGENTS.md rules (config): copy `.env` into the worktree, never set `SKIP_ENV_VALIDATION`, the Spend line (no Gemini, ElevenLabs or Roboflow call unless the task is that spend), and `pnpm format:write` before commit.
- Review lanes (config): a Gemini prompt or kid-facing copy goes to the fable `reviewer` agent; pipeline and credit logic go to Astra (`codex-review`).
- DB reads go through Supabase MCP as SELECTs (config). Schema changes are migration files under `supabase/migrations/`, applied by me or the lead, never by a delegate.
- voice-lab boundary (config): its handoffs arrive under `data/casting/`. Never edit the voice-lab checkout; say what it needs in your report.
