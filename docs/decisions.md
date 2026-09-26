# Decisions

This is the repo's decision log. One row per call or parked question, newest first. Numbers only go up. An accepted row's text never changes; a change is a new row and the old one becomes `superseded by N`. Statuses are `accepted`, `assumed (reopens when: ...)`, `open`, `unformed`, and `superseded by N`. Agents add `open` rows and the lead accepts them. Standing rules live in AGENTS.md and CLAUDE.md as prose, and earlier owner calls stay there, not here.

| # | date | decision | status |
|---|------|----------|--------|
| 16 | 2026-09-26 | The #56 lane added `src/server/admin/new-characters-resume.ts` outside its Owns to keep `workflow/api` out of the page's dev bundle, and the lead accepted it because no other lane owned that file (PR #127) | accepted |
| 15 | 2026-09-26 | When codex is at or above 90% of its 5-hour window, review rounds for Astra-lane PRs go to opus-5.5 instead (owner call during the #47 wave 1) | accepted |
| 14 | 2026-09-26 | The `main` ruleset requires one approving review, which the owner's own PRs can never get on a single-collaborator repo; #45, #46 and #122 all merged with `--admin`. Drop the review requirement, or record admin merge as the standing path once checks are green? | open |
| 13 | 2026-09-26 | #49 asks for every owner rule exactly once across AGENTS.md and CLAUDE.md, but its own decisions place the no-paid-calls rule in three AGENTS.md sections and the codex computer-use lane in both files; PR #122 followed the decisions. Which home wins for each rule, or is once-per-file the real bar? | open |
| 12 | 2026-09-26 | `pnpm format:check` fails on `main` at 9f8ce03 in 7 committed files plus 3 generated `src/app/.well-known/workflow/**` files; a format-only PR and a `.prettierignore` entry for the generated files are needed before the "all gates clean" bar can be met by any lane. Who files it, and is a `.prettierignore` the right home for the generated routes? | open |
| 11 | 2026-09-26 | AGENTS.md keeps the fleet template header comment verbatim (#49 decision 2), so `grep -c '\[FILL-IN' AGENTS.md` reads 2 not 1; the open-slot check is `grep -c '\[FILL-IN:'`, which reads 1 until #69 fills the prod domain | accepted |
| 10 | 2026-09-25 | Roboflow is on the free Public plan, so all 4 projects (including uploaded comic pages) are public on Universe, and model evaluation is unavailable. Upgrade, accept, or move? | open |
| 9 | 2026-09-25 | Book-part issue ids: Parts I to III share book `tmnt-mmpr-iii`, so Part I `issue-1` collides with Part III `issue-1`. Part-prefixed ids, global numbering 1 to 15, or one book per part? | open |
| 8 | 2026-09-25 | Where clone-source audio lives for restore: local to the owner's Mac only, or copied to the `comic-voice-clips` bucket (0 objects today)? | open |
| 7 | 2026-09-25 | Is the voice-clip-candidates spec superseded by voice-lab handoffs? | open |
| 6 | 2026-09-25 | Does the ElevenLabs slot registry stay in comic-reader's `voices` table, or move to voice-lab so both consumers share one 30-slot account equally? | open |
| 5 | 2026-09-26 | Basic auth is required on production whenever `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, and Supabase Auth follows later in #120 (#52, PR #125). | accepted |
| 4 | 2026-09-25 | Does `specs/features/features.md` retire in favor of GitHub issues, or stay as a design index with no status column? | open |
| 3 | 2026-05-02 | Episode generation and Motion Comic Plus stay paused (too expensive, off the reading goal). | assumed (reopens when: the owner reopens the cinematic lane) |
| 2 | 2026-09-25 | Browser and computer-use verification goes to codex as one delegated round, not multi-step claude-in-chrome. This declines the codex-computer-use skill's "prefer claude-in-chrome for plain web pages" (owner audit 2026-07-15: browser-MCP ping-pong was 12% of usage). | accepted |
| 1 | 2026-09-25 | This log holds parked questions and new calls only; earlier owner calls live as prose in AGENTS.md and CLAUDE.md. | accepted |
