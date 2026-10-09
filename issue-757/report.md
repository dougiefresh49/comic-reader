# Verify #757: characters stop to voices stop (browser, real input)

- Date: 2026-10-09
- Branch: `issue-757-characters-to-voices-flow` (HEAD a143c16), dev server at `http://localhost:3757` (production data)
- Viewport: 1280x830 (`resize_page`)
- Input method: chrome-devtools MCP `click` and `press_key` (CDP pointer and keyboard dispatch), plus `hover` once. No `evaluate_script` was used anywhere. Navigation by URL only where the brief asks for it: the initial auth load, back to `/review/characters` after step 4, and before step 7.
- Book / issue: `tmnt-mmpr-iii` / `issue-1` (no paused run)
- Result: **PASS, 8 of 8.** No Approve, Continue, Run, Request, Confirm, Undo request or Remove was clicked, and nothing in the Faces tab was touched. No paid call was made. Nothing was saved.

## Method

1. Loaded `/admin` once with basic auth in the URL (credentials read from the worktree `.env`, not written here), then opened the plain URLs.
2. Before every click: an a11y snapshot to find the target. After it: `wait_for` on text that appears only on the target page, then a URL read from the snapshot, then a screenshot.
3. Pixel-diffed each navigation before/after pair with `sharp` (the repo's dependency) to rule out identical frames, and diffed the hover pair to confirm the link reacts.
4. Screenshots were first saved into a scratch folder in the worktree (the MCP refuses paths under `/tmp`), then moved to `/tmp/comic-reader-briefs/shots-757/`. The scratch folder is removed, and `git status` is clean.

## Behavior checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Characters stop header: status text plus `Voices →`, no `Approve the cast`, no `Pipeline resumed`, no amber run note | PASS | `app-characters-header.png`, header right (approx. x 965-1265, y 8-40). The right-hand group's exact text is **"Cast of 32. Nothing needs you."** (green), then a bordered link **"Voices →"**. The snapshot has no Approve, no "Pipeline resumed" and no note between the header and the intro paragraph. |
| 2 | Real click on `Voices →` lands on the voices stop; header shows status plus `Editor →`, no `Continue`, no `Pipeline resumed`, no run note | PASS | `app-voices-header.png`. URL `/admin/tmnt-mmpr-iii/issue-1/review/characters/voices`. The right-hand group reads exactly **"1 voice item is not settled: Rocksteady."** (amber), then **"Editor →"**. The breadcrumb gains "Characters / Voices". No Continue or run note. Diff against `app-characters-header.png`: 543,543 px changed, bbox (64,8)-(1263,829). |
| 3 | Real click on breadcrumb `Characters` returns to the characters stop | PASS | `app-characters-back.png`. URL `/admin/tmnt-mmpr-iii/issue-1/review/characters`. Diff against `app-voices-header.png`: 543,544 px, bbox (64,8)-(1263,829). |
| 4 | `Voices →` then `Editor →` (both real clicks) reach the review editor | PASS | `app-editor-from-voices.png`. URL `/admin/tmnt-mmpr-iii/issue-1/review/editor?page=1` (the editor appends `?page=1` itself; the link's href is `/review/editor`). Diff against `app-voices-header.png`: 757,287 px, whole frame. No key was pressed in the editor (it binds A to approve a page). |
| 5 | Pending request in the panel's Voice tab links to the voices stop | PASS | `app-voice-tab-pending.png`, panel right side, the note box at approx. (857,347)-(1263,447). Rocksteady's card reads "Wants a voice-lab clone, made at the voices stop". A real click on the card opened the panel, and a real click on the `Voice` tab showed it. Exact note text: **"Wants a voice-lab clone: Rocksteady (2012). It is made at the voices stop; Rocksteady keeps Rocksteady until then."** next to an `Undo request` button (not clicked). The snapshot lists "voices stop" as `link` with url `/admin/tmnt-mmpr-iii/issue-1/review/characters/voices`. It is underlined. Hover changed it: `app-voice-tab-pending-hover.png` differs from the pre-hover frame by 516 px, bbox (1021,380)-(1094,393), exactly the link text and nothing else. |
| 6 | Real click on `voices stop` in the note lands on the voices stop | PASS | `app-voice-tab-link-landed.png`. URL `/admin/tmnt-mmpr-iii/issue-1/review/characters/voices`. Diff against `app-voice-tab-pending.png`: 703,937 px, bbox (16,0)-(1279,829). |
| 7 | Keyboard: Tab from page start to `Voices →`, Enter navigates | PASS | Fresh load of `/review/characters`: **3 Tabs** (Admin, book link, `Voices →`). The snapshot after Tab 3 shows `link "Voices →" focusable focused`, and `app-characters-tab-focus.png` shows the focus ring on it (788 px differ from `app-characters-back.png`, the ring). Enter took the page to `/review/characters/voices` (`wait_for` "Editor →", URL read from the snapshot). |
| 8 | Console errors on both stops | PASS | Characters stop (fresh load, types error/warn/issue): none. Voices stop (preserved over the last 3 navigations): no errors and no warnings. The only entries are Chrome DevTools "issue" items, "A form field element should have an id or name attribute" (counts 2-4), from the voices stop's `<select>` controls. Everything else was info/log (React DevTools banner, Fast Refresh). |

Not covered by this pass, as expected: the paused-run state (Approve or Continue shown with its cost note). `issue-1` has no paused run, and the brief forbids creating one.

### Privacy check of each screenshot

I opened every image. None shows an `.env` value, a local path, or a clone-source filename. The basic-auth credentials appear in no screenshot, because the address bar is not captured.
- `app-characters-header.png`, `app-characters-back.png`, `app-characters-tab-focus.png`: book title, character names, cover crops. Clean.
- `app-voices-header.png`, `app-voice-tab-link-landed.png`: the same, plus the voice-lab clone label **"Rocksteady (2012)"**. It is a display label, not a filename, but it names which Rocksteady the clone came from. Flagging it so the lead can decide before it goes on the public PR. Earlier #757 screenshots likely show the same label.
- `app-voice-tab-pending.png`, `app-voice-tab-pending-hover.png`: the panel note quoting "Rocksteady (2012)", same as above. Otherwise clean.
- `app-editor-from-voices.png`: the issue 1 cover art and editor chrome. Clean.

## Fixes made

None. I edited nothing under `src/` or anywhere else in the repo.

## Follow-up candidates (issues, not fixes)

1. **Characters stop copy refers to a button that is no longer there.** The "Needs a name" blurb says "Faces block Approve; wiki names do not." while no Approve shows (no paused run). `src/app/admin/[bookId]/[issueId]/review/characters/CharactersScreen.tsx:691`. Probably in #757's own scope (it owns this file), so the lead may want it in this PR rather than a new issue.
2. **The Voice tab note repeats the name when character and voice share it.** "Rocksteady keeps Rocksteady until then." (`{card.name} keeps {card.voice?.name} until then.`), `src/app/admin/[bookId]/[issueId]/review/characters/VoiceTab.tsx:270`. Something like "keeps its current voice (Rocksteady) until then" would read clearer. Also in a #757-owned file.
3. **The voices stop contradicts itself on Rocksteady's archive.** The card says "Rocksteady cannot be archived (no snapshot, no labels): it stays active after the add, or pick another voice to archive". Right below, the Archive select is preset to "Rocksteady (the voice it replaces) (planned)", the hint says "Adds the new voice first, then archives Rocksteady.", and the Run button reads "Run, archive Rocksteady" and is disabled with no stated reason. Sources: `src/app/admin/[bookId]/[issueId]/review/characters/voices/VoicesScreen.tsx` (~line 190, the select options) and `src/lib/voice-requests.ts` (the "cannot be archived" line). This predates #757 as far as I can tell (I did not check git history), so it is a new issue, not this PR.
4. **Chrome a11y issue on the voices stop:** two `<select>` elements have no `id` or `name` ("A form field element should have an id or name attribute"). `VoicesScreen.tsx`. Low priority.
5. **The status text and the next link don't connect.** The voices stop says "1 voice item is not settled: Rocksteady." in amber while `Editor →` sits beside it with no hint that moving on leaves Rocksteady unsettled. This is a judgment call for the lead, not a defect.

## Files

- Screenshots: `/tmp/comic-reader-briefs/shots-757/` (`app-characters-header.png`, `app-voices-header.png`, `app-characters-back.png`, `app-editor-from-voices.png`, `app-voice-tab-pending.png`, `app-voice-tab-pending-hover.png`, `app-voice-tab-link-landed.png`, `app-characters-tab-focus.png`)

## Paused state (forced)

Second pass, same day, at the coordinator's request. The dev server had a scratch edit in both loaders that forces the paused-run state (the coordinator's edit, not mine). Same viewport (1280x830) and auth. Each page was loaded by URL, then reloaded with `ignoreCache: true`. Input: chrome-devtools MCP `hover` only. **Neither Approve the cast nor Continue was clicked.** No file edits, no paid calls, no saves.

| # | Check | Result | Evidence |
|---|---|---|---|
| P1 | Characters stop, paused: header shows status, `Voices →` and `Approve the cast`; amber strip under the header | PASS | `app-characters-paused.png`. The right-hand group reads "Cast of 32. Nothing needs you." / `Voices →` / `Approve the cast` (white, filled). Approve is **enabled** (no `disabled` in the a11y tree). Exact strip text: **"The ingest run is paused at this stop. Approve the cast seeds the cast as shown and resumes the paused run. Gemini then reads every page (paid), the run stops at page review, writes voice descriptions, then pauses at the voices stop if any voice work is open."** The button's description (its `title` tooltip) is the same sentence from "Approve the cast seeds…" on. Hovered for about 2 s. The native tooltip is not in the screenshot, because Chrome draws native tooltips outside the page and CDP captures don't include them; the a11y description is the evidence for the tooltip text. Also changed since pass 1: the "Needs a name" blurb now reads "Faces block the run's Approve; wiki names do not." (follow-up 1 above is addressed in this copy). No "Pipeline resumed" badge. |
| P2 | Voices stop, paused: header shows status, `Editor →` and `Continue`; amber strip | PASS | `app-voices-paused.png`. The right-hand group reads "1 voice item is not settled: Rocksteady." / `Editor →` / `Continue` (greyed). Continue is **disabled** (`disableable disabled` in the a11y tree). Its description (tooltip) is "1 voice item is not settled: Rocksteady.", the blocking reason, not the cost. Exact strip text: **"The ingest run is paused at this stop. Continue resumes the paused run into audio and spends ElevenLabs credits on every bubble that still needs audio."** Hovered for about 2 s; the native tooltip is not captured (same reason as P1). No "Pipeline resumed" badge. Console: no errors or warnings. |

Notes:
- While Continue is disabled, its tooltip gives only the blocking reason. The ElevenLabs cost is still stated in the strip directly beneath it, so this reads as intended, not a defect. Whether the enabled-Continue tooltip carries the cost was not checked: it can't be enabled without settling Rocksteady, which writes production.
- Privacy: I opened both images. Neither shows an `.env` value, a local path, or a filename. `app-voices-paused.png` shows the clone label "Rocksteady (2012)", the same display label flagged in pass 1. The address bar, and so the credentials, is not captured.
- `/tmp` was refused again by the MCP. Both files were saved into a worktree scratch folder, moved to `/tmp/comic-reader-briefs/shots-757/`, and the folder was deleted. `git status` is not clean: four files are modified, `characters/load.ts`, `characters/CharactersScreen.tsx`, `characters/voices/load.ts` and `characters/voices/VoicesScreen.tsx`. That is the coordinator's forced-pause scratch edit and copy change, not mine; I edited no files. Revert the scratch loader edit before commit.

## Third pass: no-run state with final copy

Forced pause reverted by the coordinator. Hard reload (`ignoreCache`) of `/admin/tmnt-mmpr-iii/issue-1/review/characters` at 1280x830. No clicks, no edits.
The header's right-hand group is exactly "Cast of 32. Nothing needs you." then `Voices →`. The snapshot has 0 matches for "Approve the cast", "paused at this stop" or "Pipeline resumed", and no amber strip is visible. The blurb reads "Faces with no character, and wiki names the book does not know. Faces block the run's Approve; wiki names do not." `app-characters-header.png` was overwritten with this state. I opened it: it shows nothing private.
