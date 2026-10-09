# Verify #743: characters stop, right-side character panel

No forbidden control was clicked. The network log for the whole run holds three GET document loads and no fetch, XHR or POST, so no server action fired.

- Date: 2026-10-08
- Branch and commit: `issue-743-characters-side-panel` at `22e007a feat: characters stop opens a character in a right-side panel, actions grouped by job (#743)`, one commit on top of `origin/main` f8c803d. Changed files: `CharacterPanel.tsx` (new), `CharactersScreen.tsx`, `shared.tsx` (new), all under `review/characters/`.
- Viewport: 1440x900 (chrome-devtools `resize_page`)
- Input method: chrome-devtools MCP `click` on a11y-snapshot uids (CDP mouse events at the element's coordinates) and `press_key` for Escape, PageDown and PageUp. `evaluate_script` was used only to read state (scroll offsets, panel presence, focus) and to set the initial scroll for the two grid shots. It never clicked, filled or dispatched anything.
- Auth: basic auth sent as an `Authorization` header through `emulate` (no credentials in a URL or a screenshot). The header was cleared and the page closed at the end.
- **Overall: PASS.** Every brief check passed. Three findings below are not brief checks and none of them blocks.

## Deviation: where the before shots come from

Production answered 401 to the credentials in the worktree `.env` (curl also returned 401). Production's admin credentials differ from the local ones. Instead of pulling production secrets, I ran `origin/main` (f8c803d, the commit this branch builds on) from a scratch worktree, using `next dev` on port 3001 against the same production Supabase. That is the code production serves, on the same data, but it is not production itself. The scratch worktree is removed.

## Before (main f8c803d, local :3001)

| Step | Result | File |
| --- | --- | --- |
| 1. Grid | "In this issue 29", three columns, full width | `before-grid.png` |
| 2. Click Alpha 5 | Card expands inline at full width and pushes the grid down. Faces are right, Remove from this issue and Close sit top right. Rename, the face count and "Voice: Alpha 5 · Change" sit under the name. The tile with Move, Reject and Show sits below. | `before-card-open.png` |
| 3. Show | Page 12 preview appears inline at the far right of the card with the face box drawn. The tile reads "Shown". | `before-card-show.png` |
| 4. Escape | The whole card closed, preview and all, and the grid returned. | (snapshot) |

## After: Behavior checklist (branch, local :3000)

| # | Check | Result | Evidence and the region that changed |
| --- | --- | --- | --- |
| 1 | Page loads, same scroll as before | PASS | `app-grid.png`. Same layout as `before-grid.png`: three columns, the "In this issue" heading at the top. |
| 2a | A panel opens on the right | PASS | `app-panel-open.png`. A 440px `complementary` region "Alpha 5" at x=1000–1440 with the header "In this issue" and an X. |
| 2b | The grid stays visible beside it, not dimmed or covered | PASS | `app-panel-open.png`. The grid reflows to two columns on the left at full brightness. |
| 2c | Alpha 5's card shows a selected state | PASS | `app-panel-open.png`. Alpha 5's card gets a light border, and the a11y tree reports `expanded`. |
| 2d | Panel order | PASS | Order seen, top to bottom: **identity** (portrait, "Alpha 5", "alpha-5", Rename, "1 face on page 12 · 1 exemplar, all confirmed"); **FACES** ("Faces are right" in the section header; the tile with Move, Reject and Show); **VOICE** (current voice "Alpha 5" and a "Change" button); **MEMBERSHIP** ("Counted in this issue's cast" and a red-outlined "Remove from this issue", on its own shaded band). Note: the four voice choices do not show until you click Change. Main also hides them behind Change, so this is unchanged behavior, not a regression. After Change they appear inside the Voice block (step 6). |
| 3a | Clicking Bebop swaps the panel; the grid stays | PASS | `app-panel-swap.png`. The panel header reads Bebop with "Wiki: Bebop (Mutant Ranger)" and 6 face tiles (pages 18, 19, 19, 19, 20, 21). Bebop's card is selected and Alpha 5's is not. |
| 3b | The panel stays in view while the grid scrolls | PASS | `app-panel-scrolled.png`. After PageDown twice (scrollY 2159) the panel is `position: sticky`, spanning y 47 to 899, with Bebop's faces still showing. After PageUp twice (scrollY 439) it spans y 48 to 900. |
| 4a | Show opens a preview with the face box; the tile reads "Shown" | PASS | `app-show.png`. A centered overlay over a dimmed page shows "Page 18, Bebop" with a yellow box around Bebop's face. The tile button reads "Shown" (`aria-pressed=true`). |
| 4b | Escape closes the preview and the panel stays open | PASS | `app-show-escaped.png`. The overlay is gone, the Bebop panel is still open, the tile is back to "Show", and focus returned to that Show button. Also checked: a second Show reopened the overlay, and its "Close the page" button closed it with the panel still open. A second click on the tile cannot happen while the overlay covers it, so that inline-toggle case does not apply. |
| 5 | Rename opens a field; Escape closes it, the name is unchanged and the panel stays | PASS | `app-rename-open.png`. An input holding "Bebop", focused, with Save and Cancel, replaces the name row in the identity block. `app-rename-escaped.png`: the field is gone, the name is still "Bebop" and the panel is still open. Nothing was typed and Enter was not pressed. |
| 6a | Its voices shows a radio list and a request button inside the Voice block | PASS | `app-voice-its.png` (viewport) and `app-voice-its-block.png` (the Voice block only). Choice row: Keep, Another active voice, Its voices (selected), A new designed voice. Under it: radios "Bebop" and "Bebop (2012), Teenage Mutant Ninja Turtles (2012), archived", a Play button, and "Request this clone" (disabled) with "Made at the voices stop." No radio in that list was clicked, and Play was not clicked. |
| 6b | Keep closes the list | PASS | `app-voice-keep.png`. The Voice block is back to "Bebop" and "Change". In code, Keep only calls `setChanging(false)` (`CharacterPanel.tsx:681`), so it writes nothing. |
| 7a | Escape with nothing inner open closes the panel; the grid returns to full width | PASS | `app-escape-closed.png`. No panel. The grid is three 376px columns, 1152px wide, the same as `app-grid.png`. |
| 7b | The panel's Close button closes it | PASS | `app-close-button.png`. After reopening Alpha 5, a click on the X ("Close") removed the panel. |
| 8 | A role card opens the panel with no Faces block and a Voice block | PASS | `app-role-panel.png`. Narrator panel, header "Role": identity (N tile, "Narrator", "narrator", Rename, "Role, no faces"), then VOICE ("Narrator" and Change), then MEMBERSHIP. There is no FACES section. |
| 9 | Cast before, no sign here | Not testable: section empty | The section heading shows 0 and the text "Nobody carried over without a sign here." Nothing to click. The same holds on main. |
| 10 | Needs a name unknown group card | Not testable: no group card | "Needs a name 5" holds five wiki-name rows (Dimension X Blue, Purple, Red and Orange Ranger, and Shredder Green Ranger), each with "New character" and "Is someone known…". It has no unknown face-group card, so the inline-expand and panel-closes check could not run. |
| 11 | Console | PASS | No errors. Messages: React DevTools info (×3), Fast Refresh logs, and one DevTools issue: "A form field element should have an id or name attribute" (count 1, probably the Rename input). No errors in the `pnpm dev` server log either. |

No before/after pair on a state-changing control was pixel-identical. Every state change above shows a visible region change in its shot.

## Findings (not brief checks; for the lead to triage)

1. **Opening the panel can push the clicked card off-screen.** The grid goes from three columns to two when the panel opens, and the page does not scroll to keep the selected card in view. A Narrator click from a scrolled position left the selected card at y 950–1064 in a 900px viewport (`app-role-panel.png`: Narrator is not visible, and the panel shows "Narrator"). It hits cards low on the page. Alpha 5 and Bebop, near the top, stayed visible.
2. **The preview overlay's close X sits on top of the header's "Approve the cast" button** (`app-show.png`, top right). The X wins the click, so nothing gets approved by accident, but the two overlap visually.
3. **Focus falls to `<body>` after the panel's Close button.** After Escape on the Show overlay, focus does return to the tile. After the panel's X, `document.activeElement` is BODY, not the card that opened the panel. This is an accessibility nit only.

## Could not check

- The before shots against production itself (401 with the local credentials; see Deviation). They come from main f8c803d run locally instead.
- Step 9 and step 10 (both sections had nothing clickable on this issue).
- Every write path (Faces are right, Move, Reject, Remove, Rename save, voice radios, Request, Play). Per the brief none of these were clicked, so "same server actions, same data written" is unverified at the UI layer.

## Screenshot privacy

I opened every image in this folder. All of them show only the app UI and comic art: no URL bar, no `.env` values, no credentials, no local file paths, no filenames of the comic's source scans. Folder: `the verifier's scratch folder`. It also holds `dev.log`, `dev-before.log` and `install-before.log`, the server logs, which are not for publishing.

## Cleanup

Both dev servers are stopped, the scratch worktree `/tmp/cr-before-743` is removed, the temporary auth file is deleted, the browser header is cleared, and `git status` in the branch worktree is clean. Nothing was committed, pushed or posted. No Gemini, ElevenLabs or Roboflow call was made.
