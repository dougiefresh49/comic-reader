# Feature: Global Character Registry

## Status: `done`

## Prerequisite: None — build before processing any new issues

## Priority: High — must be in place before adding issue 3 or any new book

---

## Problem

The current voice setup pipeline runs from scratch for every issue:

- Gemini re-researches every character's media appearances even if Raphael was already processed in issue 1
- ElevenLabs voice models are re-created even if the voice ID already exists
- There's no link between a voice ID and which specific appearance it was sourced from
- There's no way for a new comic (e.g. TMNT Saturday Morning Adventures) to reuse the 1987-cartoon voice of Raphael separately from the 1990-movie voice already built for TMNT × MMPR

---

## Schema Design: Voice ID Belongs on the Appearance

The voice ID is co-located with the specific media appearance it was cloned from. A character can have multiple appearances in the registry, each with its own voice ID. This way:

- TMNT × MMPR uses Raphael's 1990 movie voice
- TMNT Saturday Morning Adventures can request Raphael's 1987 cartoon voice
- Both voice models live in the registry, reusable across any future books

**Each book/issue stores a `cast-selections.json`** that records which appearance was chosen for that comic. The existing `castlist.json` (character → voice ID) becomes a derived file generated from the registry + selections — kept for backward compatibility with `generate-audio.ts`.

---

## Registry Schema (`data/character-registry.json`)

```json
{
  "Raphael": {
    "franchise": "TMNT",
    "aliases": ["Raph"],
    "appearances": [
      {
        "id": "raphael-1990-movie",
        "mediaTitle": "TMNT (1990 movie)",
        "year": 1990,
        "voiceActor": "Josh Pais",
        "mediaType": "movie",
        "youtubeSearchTerms": [
          "TMNT 1990 movie Raphael Josh Pais dialogue",
          "Raphael voice clips 1990 film"
        ],
        "notes": "Grittier, sarcastic tone. Most requested.",
        "voice": {
          "voiceId": "RbsOf5RuEmcgV4XgAWDA",
          "voiceType": "ivc",
          "status": "ready",
          "createdAt": "2025-10-15T00:00:00Z",
          "voiceDescription": "A gruff, gritty young male voice with a deep tone. Features a thick Brooklyn/New York accent."
        }
      },
      {
        "id": "raphael-1987-cartoon",
        "mediaTitle": "TMNT (1987 animated series)",
        "year": 1987,
        "voiceActor": "Rob Paulsen",
        "mediaType": "animated_series",
        "youtubeSearchTerms": [
          "TMNT 1987 Raphael Rob Paulsen voice clips",
          "Raphael 80s cartoon dialogue"
        ],
        "notes": "Original series. Lighter, punchline-heavy.",
        "voice": null
      }
    ]
  },
  "Zordon": {
    "franchise": "Power Rangers",
    "aliases": [],
    "appearances": [
      {
        "id": "zordon-voice-design",
        "mediaTitle": null,
        "year": null,
        "voiceActor": null,
        "mediaType": "voice_design",
        "youtubeSearchTerms": [],
        "notes": "Auto-generated from Gemini voice description. No source media.",
        "voice": {
          "voiceId": "NvO7pjO09CWuF87LH2iA",
          "voiceType": "voice_design",
          "status": "ready",
          "createdAt": "2025-10-15T00:00:00Z"
        }
      }
    ]
  }
}
```

**`voiceType` values:**

- `"ivc"` — Instant Voice Clone, built from sourced audio clips
- `"voice_design"` — ElevenLabs Voice Design API, generated from text description

**`voice.voiceDescription`** — the text description used to generate or characterize this voice. Populated from `character-voice-descriptions.json` during migration. Useful for recreating a Voice Design voice if the ElevenLabs model is ever deleted.

**`voice.status` values:**

- `"needs_clips"` — appearance chosen, clips not yet downloaded/staged
- `"needs_model"` — clips ready, voice model not yet created in ElevenLabs
- `"ready"` — voice ID exists and is usable

**Note on PVC:** Professional Voice Clone requires 30+ minutes of clean single-speaker audio. Not used here — IVC is correct for this use case.

---

## Per-Issue Cast Selections (`assets/comics/<book>/issue-<n>/data/cast-selections.json`)

Each issue records which appearance was used for each character. This is the source of truth for the issue's casting decisions.

```json
{
  "Raphael": {
    "appearanceId": "raphael-1990-movie",
    "voiceId": "RbsOf5RuEmcgV4XgAWDA"
  },
  "Leonardo": {
    "appearanceId": "leonardo-1990-movie",
    "voiceId": "1sca4ecJ4XyU7M176Ei0"
  },
  "Zordon": {
    "appearanceId": "zordon-voice-design",
    "voiceId": "NvO7pjO09CWuF87LH2iA"
  }
}
```

**`castlist.json` remains** as a derived file (`character → voiceId`) for backward compatibility with `generate-audio.ts`. It is generated from `cast-selections.json` at the end of Step 10 and should not be edited manually.

---

## Migration Flow for Existing Issues

Existing issues only have `castlist.json` (`character → voiceId`). The registry needs to be backfilled. The `--migrate` command handles this in three steps:

The migration reads from `assets/comics/<book>/issue-<n>/castlist.json`. Before running, copy the existing book-level castlist into each issue folder if it isn't there already:
```bash
cp assets/comics/tmnt-mmpr-iii/castlist.json assets/comics/tmnt-mmpr-iii/issue-1/castlist.json
cp assets/comics/tmnt-mmpr-iii/castlist.json assets/comics/tmnt-mmpr-iii/issue-2/castlist.json
```

### Step 1 — Fetch voice details from ElevenLabs

For each character + voice ID in `castlist.json`, call `GET /v1/voices/{voice_id}` to retrieve:

- `category`: `"cloned"` (IVC) | `"generated"` (Voice Design) | `"premade"` | `"professional"` (PVC)
- `name`: the voice name as saved in ElevenLabs
- `labels`: any metadata tags

This determines `voiceType` without asking the user.

### Step 2 — Handle Voice Design characters automatically

Characters where `category === "generated"`: write directly to registry as `voiceType: "voice_design"` with a single `appearances` entry. No user input needed.

### Step 3 — Prompt for IVC appearance

Characters where `category === "cloned"`: the model was cloned from sourced audio clips. The user needs to identify which appearance.

```
── Raphael (IVC — voice ID: RbsOf5RuEmcgV4XgAWDA) ──────────────────
Fetching media appearances from Gemini...

  1. TMNT (1987 animated series)   Cam Clarke
  2. TMNT (1990 movie)             Josh Pais
  3. TMNT (2003 series)            Frank Frankson
  4. TMNT (2007 movie)             Nolan North
  5. TMNT (2012 Nickelodeon)       Sean Astin
  6. I don't know / skip

Which appearance is this voice based on? [1-6]:
```

If the user picks an option: write the appearance + voice ID to registry, generate an `id` (`raphael-1990-movie`).
If "skip": write character to registry without an appearance link. Voice ID is still stored and usable — it just won't be searchable by appearance later.

Model for appearance research: `GEMINI_MEDIUM` — factual recall and structured output, no deep reasoning needed.

### Step 4 — Generate `cast-selections.json`

After registry is populated, generate `cast-selections.json` for the migrated issue from the choices made in Step 3.

---

## Pipeline Changes (New Issues)

### Step 7 — `generate-character-voice-descriptions`

After building descriptions, check registry. Characters with any `status: "ready"` appearance → mark as "known" and skip to cast selection.

### Step 8 — `clean-voice-descriptions`

After alias normalization, split output into:

- `known-characters.json` — in registry, need cast selection (which appearance to use)
- `new-characters.json` — not in registry, need full voice setup (Steps 9–10)

### Step 9 — `find-voice-sources` (new characters only)

For each character in `new-characters.json`:

1. Check registry for cached appearances — if found, skip Gemini call, show cached list
2. If not cached: call `GEMINI_HIGH`, save appearances to registry (without voice ID — none created yet)
3. Show interactive menu for user to pick preferred appearance or skip (Voice Design)
4. Write selection to registry with `status: "needs_clips"` or `voice_design`

Model: `GEMINI_MEDIUM` — character appearance research is factual recall + structured output, not deep reasoning. Same tier as voice description consolidation.

For characters in `known-characters.json` with multiple appearances:

- Show a cast selection menu: "Raphael has 2 voices — which to use for this book?"
- Default to the most recently used appearance

### Step 10 — `generate-voice-models` (new characters only)

For each character in `new-characters.json` that needs a voice model:

1. If `status: "needs_model"`: create IVC from staged clips, write `voiceId` to registry appearance, update status to `"ready"`
2. If `voice_design`: call Voice Design API, write `voiceId` to registry appearance

After all models created: generate `cast-selections.json` and derive `castlist.json` for the issue.

---

## New Script: `scripts/manage-registry.ts`

```bash
# List all characters and their status
pnpm manage-registry -- --list

# Show full details for one character
pnpm manage-registry -- --character "Raphael"

# Migrate an existing issue into the registry
pnpm manage-registry -- --migrate --book tmnt-mmpr-iii --issue 1

# Re-research appearances for a character (re-runs Gemini)
pnpm manage-registry -- --character "Raphael" --refresh-appearances

# Reset a character's voice model (forces re-creation next ingest run)
pnpm manage-registry -- --character "Raphael" --appearance "raphael-1990-movie" --reset-voice
```

---

## File Locations

```
data/
  character-registry.json          ← global, committed to git

assets/comics/<book>/issue-<n>/
  data/
    cast-selections.json           ← which appearance was chosen for this issue (new)
    castlist.json                  ← derived from cast-selections (kept for generate-audio compatibility)
    new-characters.json            ← intermediate: characters needing full voice setup (gitignored)
    known-characters.json          ← intermediate: characters needing cast selection only (gitignored)
```

Note: ElevenLabs voice IDs are not secrets — they're API resource identifiers. Safe to commit `character-registry.json` to git.

---

## Migration Execution Order

Run this before processing any new issue:

```bash
# Migrate both existing issues
pnpm manage-registry -- --migrate --book tmnt-mmpr-iii --issue 1
pnpm manage-registry -- --migrate --book tmnt-mmpr-iii --issue 2

# Verify
pnpm manage-registry -- --list
# Expect: all 29 characters from castlist.json show in registry with status: "ready"
# Expect: cast-selections.json created for both issues
```

---

## package.json Addition

```json
"manage-registry": "tsx --env-file=.env scripts/manage-registry.ts"
```

---

## Implementation Steps

1. Define types: `CharacterRegistryEntry`, `AppearanceEntry`, `CastSelection` in `scripts/types/registry.ts`
2. Create `data/character-registry.json` (empty `{}`)
3. Create `scripts/manage-registry.ts` — `--list`, `--character`, `--migrate`, `--refresh-appearances`, `--reset-voice`
4. Update `scripts/find-voice-sources.ts` — check registry for cached appearances before Gemini call; save results back; handle cast selection for known multi-voice characters
5. Update `scripts/generate-voice-models.ts` — write new voice IDs to registry appearance; generate `cast-selections.json` + derive `castlist.json`
6. Update `scripts/clean-voice-descriptions.ts` — output `new-characters.json` + `known-characters.json`
7. `scripts/generate-audio.ts`, `scripts/copy-to-public.ts`, `scripts/regenerate-timestamps.ts` — path already fixed to read `castlist.json` from `ISSUE_DIR` (was `COMIC_DIR`). No further changes needed.
8. Add `manage-registry` to `package.json`
9. Run `--migrate` for both existing issues
10. Delete per-issue `source-material.json` files after migration (data now lives in registry)

## Key Files to Read Before Implementing

- `assets/comics/tmnt-mmpr-iii/issue-1/castlist.json` — existing characters to migrate (per-issue)
- `scripts/find-voice-sources.ts` — research flow to modify
- `scripts/generate-voice-models.ts` — voice creation flow to modify (already writes castlist to ISSUE_DIR)
- `scripts/clean-voice-descriptions.ts` — split output into known/new
- `scripts/alias-map.ts` — name normalization used in registry lookups

## Verification

```bash
# Full migration test
pnpm manage-registry -- --migrate --book tmnt-mmpr-iii --issue 1
pnpm manage-registry -- --list
# Expect: 29 characters, all status: "ready", IVC ones linked to an appearance

# New issue dry run — existing characters should skip Steps 9-10
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --dry-run
# Expect: "X characters found in registry (skipping voice setup), Y new characters to process"

pnpm typecheck
```
