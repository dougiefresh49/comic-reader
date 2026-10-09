# Round 2: Contact sheet

**One line.** Today's characters page, redrawn: a contact sheet of faces grouped by lines, one side panel where every voice is a clickable pick, and one Review button at the end that lists what will happen.

## Doug's keep/change list, item by item

- **Base: a grid of face cards, click for a side panel.** 32 cards in five groups (Leads 10+, Supporting 3–9, One-offs 1–2, No lines, Roles), A's grouping by lines. A card is a drawn face, the name once, a line count in the corner, and one voice chip: kind + slot number for its own voice (`designed 8`), `as Krang` for a stand-in, the library name, `no voice`, `sitting out`. Clicking opens the docked panel (Voice and Faces tabs); clicking another card switches it.
- **Voice choices in the panel, every one clickable.** The Voices list is the character's own active voice, its archived voices (Green Ranger's Tommy 1993, the lab's clones for Pink Ranger and Rocksteady, tagged `lab pick`), an accepted design, a dashed `Design a voice` row, and an `Another voice` expander (stand-ins and library). One click makes the row the pick; clicking the current voice again reverts. Play buttons sit in every row and never touch a move.
- **Green Ranger in one step.** Click Tommy 1993: it is the pick, takes a free slot, the card turns amber, the strip shows `29/30 +1`. No bench, no drag needed.
- **Slot with no free slot.** An inline `Slot` box appears under the pick: `Free · n` or `Swap out`. Swap lists every unprotected voice in the account (its own voice first, then this book's, then other projects' by name), each with a backup dot; the four v2 voices and pinned voices are listed last, locked, with the reason on hover. Under the chosen voice: `Back up first` ticked by default, or `Archive anyway · no backup · lost` when nothing can be backed up. Picking a voice someone else speaks says `leaves X silent`.
- **Design a voice** is A's sheet with the notes cut to one line each: Draft from the description, edit, preview text, three takes with play, `Keep` or `This run only`, Accept. Nothing is saved until Confirm; the accepted take is a `new` row in the panel and needs a slot like any restore.
- **Add a character** from the header `+ Add` or the dashed `Add` card: a search over the book's earlier cast (Krang, April, Casey, Goldar, Bulk, Skull; the ones with an archived voice say so) or `New: <name>`. The new card opens its panel straight away, so an archived voice is one more click.
- **Slots stay visible, quiet.** 30 segments in the header: this book, other projects (striped when pinned), locked v2, free, amber for new at confirm, red dashed for freed. Hover gives the owner and backup state; click opens a card with `Free this slot` (backup on by default) or `Keep it`. Drag a character card onto a segment to give it that slot (occupied and unlocked = swap out); drag a segment onto `free the slot` to free it. Every drag has a click path.
- **Sit out this run** is in the card's hover menu, the panel footer, and the review's blocker line (`Sit out Rezar`).
- **Review & confirm at the end.** `Review · n` opens the only list of moves, in run order: archives (with their backup tick), restores and creates (slot, credits), stand-in casts, sit-outs, removals, renames, adds, faces. Each line has ✕. Blockers: an archive with no backup not ticked, a pick with no slot, a speaking character with no voice (with Sit out buttons). Confirm runs the list, then the strip is the account.

## What changed from A, and why

Dropped: the three-column board, the bench, the always-on Moves rail, the per-row chips, the face tray and sit-out tray. The grid is the whole page; Faces is a header button; sit-outs stay in their group, dimmed. Text: A's hints, notes and footer sentences are gone, so the page has no instruction sentence. Doug's "name twice" is fixed at the source: an own voice shows its kind and slot, never the character's name again.

## Data and actions versus planVoiceWork / carryOut

Carried over from A: a staged move list (`casting_moves` or `casting_tasks` widened: `seq, kind, voice_uuid, replaces_voice_uuid, character_id, backup, lossy_ok, run_only, design_prompt, preview_text, generated_voice_id, take`); `castlist.sit_out` apart from `no_audio`; `voices.run_only`; `voices.owner` plus a cached ElevenLabs inventory for other projects' slots; Draft reads `voices.description`. `playSample`, `nameGroup`, `rejectGroup`, `confirmFaces`, `addCharacter`, `removeCharacter`, `renameCharacter` reused as they are.

Changed by the end-of-flow review: no `slot_hint` column (a slot is `free` or `replaces_voice_uuid`; the drag onto a numbered segment is only a preference the plan may honour). `planMoves` runs once when Review opens, not on every drag, and returns the blockers shown there; `runMoves` is Confirm, one claim per line, archives before adds. `snapshot` runs inside Confirm for every archive with `backup` true, which is why "cannot be archived, no backup" becomes a tick instead of a dead end. The month's add/edit count is shown only in the review.

## Main-screen word count

180 words on the main screen at load (header plus grid, panel closed), 63 of them bare numbers (line counts, slot numbers, group counts) and 55 of them character names. No sentence of instructions anywhere on it; every label is one to three words.
