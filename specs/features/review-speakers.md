# Feature: Review Speakers (post-get-context)

## Status: `pending`
## Priority: High — fixes character naming at the source, reducing alias-map maintenance for all downstream steps

---

## Problem

`get-context` produces speaker names that may be wrong (Gemini invents "Winged Monster" instead of "Goldar"). Every downstream step — voice descriptions, alias normalization, registry lookup, find-voice-sources — inherits those wrong names and requires corrective work.

The right fix is to correct names **in `bubbles.json` directly**, right after `get-context`, before any processing happens.

---

## Solution

New pipeline step **`review-speakers`** (step 4.5) between `get-context` and `sort-bubbles-gemini`.

Collects all unique speaker names from `bubbles.json`, presents each one interactively, and writes corrections back into `bubbles.json` in-place. Every downstream step sees the corrected names automatically — no alias entries needed for per-issue corrections.

---

## Pipeline Position

```
Step 4:   get-context          → bubbles.json (raw names, may be wrong)
Step 4.5  review-speakers      ← NEW: correct names in bubbles.json in-place
Step 5:   sort-bubbles-gemini  → sees correct names
Step 6:   add-bubble-styles
Step 7:   generate-character-voice-descriptions → correct names
Step 8:   clean-voice-descriptions              → correct names
Step 8.5  review-new-characters                 → much simpler, names already correct
Step 9:   find-voice-sources
```

---

## Terminal Flow

```
────────────────────────────────────────────────────────────────
  Review speakers — Mighty Morphin Power Rangers / TMNT III
  Issue 3  |  40 unique speakers  |  24 pages
────────────────────────────────────────────────────────────────
  Known characters (already in registry — auto-accepted):
  ✓ Donatello       ✓ Leonardo      ✓ Michelangelo   ✓ Raphael
  ✓ Shredder        ✓ Lord Zedd     ✓ Zordon          ✓ Red Ranger
  ... (22 total)

  18 unknown speakers to review.
────────────────────────────────────────────────────────────────

── 1/18 ─────────────────────────────────────────────────────
  "Winged Monster"
  Pages: 8, 9  (3 bubbles)
  Sample: "HA HA, FOOL! THEY WON'T MAKE IT IN--"

  [1] Accept
  [2] Edit (type new name)
  [3] Choose from list

Choice [1-3]: 2
New name: Goldar
  ✓ Renamed: "Winged Monster" → "Goldar" (3 bubbles updated)

── 2/18 ─────────────────────────────────────────────────────
  "Villain Green Ranger"
  Pages: 17, 18  (4 bubbles)
  Sample: "ARE WE REALLY GOING BACK TO EARTH? ZOW YAH!"

  [1] Accept
  [2] Edit (type new name)
  [3] Choose from list (1 confirmed: Goldar)

Choice [1-3]: 2
New name: Green Dimension X Ranger
  ✓ Renamed: "Villain Green Ranger" → "Green Dimension X Ranger" (4 bubbles updated)

── 3/18 ─────────────────────────────────────────────────────
  "Kayla"
  Pages: 17, 19, 21  (6 bubbles)
  Sample: "SPEAK FOR YOURSELF, GOALIE MAN."

  [1] Accept
  [2] Edit (type new name)
  [3] Choose from list (2 confirmed: Goldar, Green Dimension X Ranger)

Choice [1-3]: 3

  Confirmed this session:
   1. Goldar
   2. Green Dimension X Ranger

  Known from registry:
   3. Donatello        4. Leonardo        5. Michelangelo
   6. Raphael          7. Shredder        8. Lord Zedd
   ... (22 more — press ? to expand)

  Or type a name:

Map "Kayla" to [#/name]: Kala
  ✓ Renamed: "Kayla" → "Kala" (6 bubbles updated)

── 4/18 ─────────────────────────────────────────────────────
  "Female Soldier"
  Pages: 2  (1 bubble)
  Sample: "SECURE THE PERIMETER!"

  [1] Accept
  [2] Edit (type new name)
  [3] Choose from list (3 confirmed: Goldar, Green Dimension X Ranger, Kala)

Choice [1-3]: 1
  ✓ Accepted: "Female Soldier"

...

────────────────────────────────────────────────────────────────
  Review complete. 18 speakers reviewed.
  Renamed: 4   Accepted: 14
  bubbles.json updated.
────────────────────────────────────────────────────────────────
```

---

## Option 3 — Choose from list

The list has two sections:

1. **Confirmed this session** — speakers already reviewed and accepted/renamed in this run (grows as you progress). Numbered starting at 1.
2. **Known from registry** — characters in `character-registry.json` with a ready voice. Shown collapsed by default (first 8 visible, `?` to expand all).

User can type a number (to select) or a name (free-text, creates a new entry). Press Enter with no input to go back and pick [1] or [2] instead.

---

## Auto-accept logic

Before showing the interactive review, pre-process the speaker list:

- Load `character-registry.json` and `character-roster.json`
- Any speaker whose name (after `getCanonicalName` normalization) matches a registry entry with `status: "ready"` → **auto-accepted**, shown in the "Known characters" header, skipped in the review loop
- Any speaker whose name matches a roster canonical name or alias → **auto-accepted** (already confirmed from a previous issue)

This means on issue 3, the 22 characters already in the registry never appear in the review loop. You only see truly new/unknown names.

---

## Saving corrections

Each rename immediately:
1. Updates all matching bubbles in the in-memory `bubbles.json` cache (all pages, all occurrences)
2. Writes `bubbles.json` to disk

Write on each rename (not at the end) — if the session is interrupted, corrections made so far are preserved and the step can be re-run to review only remaining uncorrected speakers.

**Tracking reviewed speakers:** After the session, write a `data/reviewed-speakers.json` file listing which speaker names were reviewed and what they mapped to. On re-run (e.g. after adding more pages), skip already-reviewed names.

```json
{
  "Winged Monster": "Goldar",
  "Villain Green Ranger": "Green Dimension X Ranger",
  "Kayla": "Kala",
  "Female Soldier": "Female Soldier"
}
```

---

## `--auto` mode

Skip the interactive review entirely. Auto-accept all speakers. Used for non-interactive pipeline runs.

---

## Effect on `alias-map.json`

`review-speakers` corrections are **not** written to `alias-map.json`. They're per-issue, per-run corrections stored in `reviewed-speakers.json`. The alias-map stays as a global persistent shorthand (tommy → Green Ranger) — not a per-issue correction tool.

If the user wants a correction to persist across all future issues (e.g. Gemini will always say "Winged Monster" for Goldar), they can manually add it to `alias-map.json`. But that's optional — the review step handles it each time without growing the alias-map.

---

## Effect on `review-new-characters` (step 8.5)

Once `review-speakers` exists, `review-new-characters` becomes much simpler:
- Names in `new-characters.json` are already correct (fixed upstream)
- The prune step still catches any stale entries
- The per-character menu still lets you alias `new-characters` entries to each other (e.g. two different names that turned out to be the same character)
- But the common case (Gemini got the name totally wrong) is already handled

---

## Implementation Steps

1. Create `scripts/review-speakers.ts`
   - Parse args: `--book`, `--issue`, `--auto`
   - Load `bubbles.json`, `character-registry.json`, `character-roster.json`, `alias-map.json`
   - Collect unique speakers; auto-accept known; collect unknown set for review
   - Load `data/reviewed-speakers.json` if exists — skip already-reviewed names
   - Interactive loop: show each unknown speaker with sample text + page list; [1] Accept / [2] Edit / [3] Choose from list
   - On each decision: rename all occurrences in bubbles cache + write `bubbles.json` + append to `reviewed-speakers.json`
   - Summary on completion

2. Add `review-speakers` to `scripts/ingest.ts` between `get-context` and `sort-bubbles-gemini`

3. Add `"review-speakers": "tsx --env-file=.env scripts/review-speakers.ts"` to `package.json`

4. Add `data/reviewed-speakers.json` pattern to `.gitignore` (it's per-issue intermediate data)

---

## Key Files to Read Before Implementing

- `scripts/get-context.ts` — understand bubbles.json structure (keyed by page filename, array of Bubble objects per page)
- `scripts/utils/registry.ts` — `loadRegistry`, `hasReadyVoice`
- `scripts/utils/roster.ts` — `loadRoster`, `getRosterAliasMap`
- `scripts/alias-map.ts` — `getCanonicalName` for pre-normalization
- `scripts/review-new-characters.ts` — reference for the [1]/[2]/[3] menu pattern and readline loop
- `scripts/ingest.ts` — where to insert the new step
- `assets/comics/tmnt-mmpr-iii/issue-3/bubbles.json` — concrete structure to work with

---

## Verification

```bash
# Run get-context fresh, then review-speakers
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step get-context

# At review-speakers:
# - Known registry characters should be auto-accepted and not appear in loop
# - Type 2 for "Winged Monster", enter "Goldar"
# - Verify bubbles.json updated (all occurrences renamed)
# - Verify reviewed-speakers.json created
# - Re-run from review-speakers — already-reviewed names skipped

pnpm typecheck
```
