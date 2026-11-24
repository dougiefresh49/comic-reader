<!-- fleet corefile: CLAUDE-base.md
     Copy to a new repo's root as CLAUDE.md next to the instantiated
     AGENTS.md. This layer is main-session/orchestrator concerns only.
     Everything shared lives in AGENTS.md so delegated prompts can shrink
     to "read AGENTS.md, then do issue #N." The model roster is not here: fleet
     rules/model-roster.md loads in every session through ~/.claude/rules,
     and this file holds only this repo's overrides. Run the sync-corefiles
     skill to re-apply the shared sections.
     Instantiated from fleet corefiles @ 8826d40, 2026-11-24 -->

@AGENTS.md

# Claude main-session guidance

Everything above (AGENTS.md) is the shared rulebook. It applies to every
agent, including subagents. What follows is for the orchestrating Claude
session only.

## Model roster overrides

These win over the default roster in `~/.claude/rules/fleet-model-roster.md`,
which loads in every session.

| model         | cost | intelligence | taste | reachable via                                                                        |
| ------------- | ---- | ------------ | ----- | ------------------------------------------------------------------------------------ |
| space-bunny   | 10   | 7?           | ?     | `claude-bunny` (OpenRouter `stealth/space-bunny-alpha`), see below                   |

**space-bunny-alpha** (config from one audition here, row 146 in this
repo's `docs/decisions.md`; the `7?` and `?` are placeholders, not
scores):

- An OpenRouter stealth model, $0 per token while in stealth. It runs
  in the full Claude Code harness through `~/.local/bin/claude-bunny`,
  which sets the OpenRouter env for that one process, so AGENTS.md,
  CLAUDE.md and the hooks all apply. It is not an Agent tool model;
  launch it from Bash in its own worktree like cursor-agent.
- Delegate runs need `--strict-mcp-config`. With a custom
  `ANTHROPIC_BASE_URL` Claude Code loads every MCP tool schema up front,
  and the first #219 run filled its context with 163 Roboflow tools and
  stopped with auto-compact thrashing.
- On #219 (a bounded logic refactor) it built a diff that matched the
  old behavior exactly in 3 minutes, and fixed the review's three nits
  in 1. Treat it as a builder candidate, not a lane: one data point,
  no taste read, and no longer or judgment-heavy run yet.
- Stealth models often log prompts for their maker and can vanish or
  start charging. Its logging policy wasn't on its page. Keep secrets
  out of what it reads beyond the worktree `.env`.

## Session token hygiene

Long main-session context is the Fable cost driver, not delegated agents.
Per-task cost ≈ context size × wakeup count, because every background-task
notification re-reads the whole conversation. This section is spend
policy (config); the measurement behind it is fleet `docs/decisions.md`
row 9.

- During big multi-stage rounds, the main session stops authoring code:
  chunks beyond small surgical edits go to a delegate against a written
  spec (the builder lanes in the default roster; a fresh-context fable
  subagent when the chunk is taste work or a long open-ended run). The
  main session does
  specs, targeted diff review, merges. Ordinary small tasks: author freely.
- Codebase recon goes to composer-2.5 or an Explore subagent (Claude
  Code's read-only search agent type); a wide read across many files,
  docs, or projects that returns facts, not verdicts, fans out to
  haiku-5.5 subagents (the haiku-5.5 roster notes); when finding the
  answer takes judgment, a sonnet-5.5 subagent (the sonnet-5.5 roster
  notes); when the job is finding what's wrong (a bug's root cause, an
  audit), gpt-6.2 Sol through `codex exec` (the gpt-6.2 Sol roster
  notes). Don't pull 2,000-line files into the main context when a
  delegate can return the 20 lines that matter.
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
- Browser and computer-use verification is one delegated round with the whole checklist, audio playback included. Any lane that sends real pointer and keyboard input may run it: codex (the `codex-computer-use` skill), Claude computer use, or a subagent driving a browser MCP (chrome-devtools, claude-in-chrome). Pick the one that is free; codex is not the only lane (owner call 2026-10-04, `docs/decisions.md` row 277). A browser MCP from the main session is fine for one screenshot plus one console read, nothing more. The reason is the 2026-07-15 owner audit: 92% of usage happened above 150k context, browser-MCP ping-pong from the main loop was 12% of it, and one 13-hour session with ~60 wakeups burned 17.7M cache-read tokens.
- Cursor Cloud agents are a further lane for a PR review or a browser check (row 277). The hosted environment for this repo is set up; "Cursor Cloud specific instructions" in AGENTS.md is what the agent reads there. Start one with a PR comment that tags `@cursoragent`, names the model and says where the result goes. Name grok or composer: those cost nothing extra there. It runs apart from this machine, so it does not compete with a local codex or browser-MCP round for the screen; whether two local rounds can share the screen is untested. Its browser use is untried here: if a check fails to run, keep the lane for reviews and say so in the report. The spend and prod-write rules apply to it unchanged. Two comments that work as written:
  - `@cursoragent use grok-4.7 to review this pr and post findings in a comment`
  - `@cursoragent check out this PR, start the dev server, open the app in the browser, click button A, and confirm the blue square shows up. Record a video of the test and post the result as a PR comment.`
- Every delegate brief restates four AGENTS.md rules (config): copy `.env` into the worktree, never set `SKIP_ENV_VALIDATION`, the Spend line (no Gemini, ElevenLabs or Roboflow call unless the task is that spend or the brief hands over a share of the PR's paid-check budget), and `pnpm format:write` before commit.
- Review lanes (config): a Gemini prompt or kid-facing copy goes to the fable `reviewer` agent; pipeline and credit logic go to Astra (`codex-review`).
- DB reads go through Supabase MCP as SELECTs (config). Schema changes are migration files under `supabase/migrations/`, applied by the lead under the standing approvals in AGENTS.md ("Verifying here"), never by a delegate.
- voice-lab boundary: the rule is the "voice-lab" entry in the AGENTS.md glossary.
