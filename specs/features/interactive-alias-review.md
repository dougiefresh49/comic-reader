# Feature: Interactive Alias Review

## Status: `pending`
## Prerequisite: alias-map.ts backed by `data/alias-map.json` ✅ (done)
## Priority: High — eliminates wasted API calls on mis-named characters before find-voice-sources

---

## Problem

After `clean-voice-descriptions` (step 8), `new-characters.json` may contain:

- Characters that don't exist in `bubbles.json` (stale from a previous run where steps 7–8 ran on old data)
- Characters Gemini mis-named that the user knows should be aliased (e.g. "Winged Monster" → "Goldar", "Green Ranger Shredder" → "Shredder")
- Duplicates that alias normalization didn't catch yet

All of these flow into `find-voice-sources` (step 9) which makes expensive Gemini API calls for each one. There's currently no way to review and correct this list before research begins — the user has to wait until after the damage is done.

---

## Solution

Add a new pipeline step **`review-new-characters`** between steps 8 and 9 that:

1. **Prunes** `new-characters.json` against the actual speakers in `bubbles.json` — removes any character not present in the current issue
2. **Presents** the pruned list in the terminal for review
3. **Lets the user type aliases** interactively before research begins
4. **Persists** new aliases to `data/alias-map.json` (the now-writable JSON file) so they apply to all future issues

---

## Pipeline Position

```
Step 8:  clean-voice-descriptions   → new-characters.json (may have stale/wrong names)
Step 8.5 review-new-characters      ← NEW: prune + interactive alias console
Step 9:  find-voice-sources         ← now receives a clean, confirmed list
```

The step number stays between 8 and 9 in the ingest.ts ordering. Name it `review-new-characters`.

---

## Terminal Flow

```
──────────────────────────────────────────────────────────────
  Review new characters before voice research
  24 characters in bubbles.json  |  19 in new-characters.json
──────────────────────────────────────────────────────────────

  Pruning characters not found in bubbles.json...
  ✗ Unknown Hero — removed (not in bubbles.json)
  ✗ Unknown Voice — removed (not in bubbles.json)

  17 characters remaining after prune.

──────────────────────────────────────────────────────────────
  Reviewing each character (17 total)
──────────────────────────────────────────────────────────────

── 1/17 ──────────────────────────────────────────────────────
  Baxter Stockman  [named]

  [1] New character — research appearances
  [2] Alias to existing character

Choice [1/2]: 1
  ✓ Accepted: "Baxter Stockman"

── 2/17 ──────────────────────────────────────────────────────
  Cyborg Villain  [named]

  [1] New character — research appearances
  [2] Alias to existing character

Choice [1/2]: 2

  Confirmed so far:
   1. Baxter Stockman

  Or type a name:

Map "Cyborg Villain" to [#/name]: Krang
  ✓ Aliased: "Cyborg Villain" → "Krang" (merged with existing Krang entry)

...

── 16/17 ─────────────────────────────────────────────────────
  Winged Monster  [named]

  [1] New character — research appearances
  [2] Alias to existing character

Choice [1/2]: 2

  Confirmed so far:
   1. Baxter Stockman       2. Bulk          3. Director
   4. Female Soldier        5. Ghost Tiger   6. Green Dimension X Ranger
   7. Krang                 8. Skull         9. Squatt
  10. Villain Scientist    11. Green Ranger Shredder

  Or type a name:

Map "Winged Monster" to [#/name]: Goldar
  ✓ Aliased: "Winged Monster" → "Goldar" (saved to alias-map.json)

──────────────────────────────────────────────────────────────
  Final list — 16 characters proceeding to voice research:

   1. Baxter Stockman      [named]   → research appearances
   2. Bulk                 [named]   → research appearances
   3. Director             [named]   → research appearances
   4. Female Soldier       [named]   → research appearances
   5. Ghost Tiger          [named]   → research appearances
   6. Green Dimension X Ranger  [named]  → research appearances
   7. Goldar               [named]   → research appearances  (was: Winged Monster)
   8. Krang                [named]   → merged (was: Cyborg Villain)
  10. Mutated Villain      [named]   → research appearances
  11. Mysterious Enemy     [named]   → research appearances
  12. Putty Foot Soldier   [named]   → research appearances
  13. Shredder             [known]   → skip research (in registry)
  14. Skull                [named]   → research appearances
  15. Squatt               [named]   → research appearances
  16. Villain Scientist    [named]   → research appearances

Proceed? [Y/n]:
```

---

## Alias Behavior

When the user types `OldName=NewName`:

1. Add `"old name" (lowercase)` → `"NewName"` to `data/alias-map.json` and save immediately
2. In the current session's `new-characters.json`:
   - If `NewName` already exists in new-characters.json or known-characters.json: **merge** (remove OldName, keep NewName's entry)
   - If `NewName` doesn't exist yet: **rename** (rename OldName's key to NewName)
3. Re-check `NewName` against the character registry — if now found with a ready voice, move to `known-characters.json`
4. Display the result clearly (merged / renamed / promoted to known)

**Validation:**
- If `=` is missing → warn "Use format: OldName=NewName"
- If `OldName` not in current list → warn "Not found in list"
- Empty input → proceed

---

## Pruning Logic

Before showing the alias prompt, prune `new-characters.json`:

1. Collect all unique speaker names from `bubbles.json` (across all pages, SPEECH bubbles only)
2. Apply current alias-map normalization to both sets
3. Remove any character from `new-characters.json` whose normalized name doesn't appear in the normalized bubbles speaker set
4. Log each removal clearly

This handles the case where steps 7–8 ran on a stale bubbles.json and produced characters that no longer exist.

---

## Persistence

New aliases typed during this step are written to `data/alias-map.json` immediately (not at the end of the session). This means:

- They apply to all future issues/books automatically
- If the pipeline is restarted from this step, the aliases are already in effect
- The alias-map.json file is committed to git, so aliases accumulate over time

---

## `--auto` flag

For non-interactive runs (CI or `--from-step` resume without a terminal), add `--auto` flag to ingest:

```bash
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --auto
```

In auto mode, this step runs the prune only (no alias prompt) and proceeds automatically.

---

## Implementation Steps

1. Create `scripts/review-new-characters.ts`
   - Parse args: `--book`, `--issue`
   - Load bubbles.json → collect speaker set (normalized)
   - Load new-characters.json → prune against speaker set → log removals
   - Load alias-map.json + apply → re-prune after alias normalization
   - Interactive alias loop: readline prompt, parse `OldName=NewName`, update in-memory map + write alias-map.json, update new-characters.json
   - Re-check registry after each alias (move to known-characters if now found)
   - Show final list + Proceed prompt
   - Write updated new-characters.json

2. Add `review-new-characters` to `scripts/ingest.ts` between `clean-voice-descriptions` and `find-voice-sources`

3. Add `"review-new-characters": "tsx --env-file=.env scripts/review-new-characters.ts"` to `package.json`

4. Pass `--auto` flag through ingest arg parsing; skip alias prompt in auto mode (prune only)

---

## Key Files to Read Before Implementing

- `scripts/clean-voice-descriptions.ts` — what new-characters.json looks like (entry format, named field)
- `scripts/find-voice-sources.ts` — what review-new-characters needs to output (same format)
- `scripts/alias-map.ts` — how getCanonicalName works; new step reads/writes data/alias-map.json directly
- `scripts/ingest.ts` — where to insert the new step in the pipeline array
- `data/alias-map.json` — the file this step writes to
- `assets/comics/tmnt-mmpr-iii/issue-3/new-characters.json` — concrete example of what needs pruning

---

## Verification

```bash
# Simulate a dirty state: run from clean-voice-descriptions
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step clean-voice-descriptions

# At review-new-characters prompt:
# - Verify pruned characters are logged and removed
# - Type: Winged Monster=Goldar
# - Verify alias saved to data/alias-map.json
# - Verify new-characters.json updated
# - Proceed → find-voice-sources gets clean list

pnpm typecheck
```
