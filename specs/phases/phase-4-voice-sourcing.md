# Phase 4 — Voice Clip Sourcing Assistant

## Goal
Replace the biggest manual time sink — researching and hunting down character voice clips from old media — with a Gemini-powered research assistant that generates a shortlist of media appearances and YouTube search terms for each character.

## Why
Sourcing voice clips for 10–15 main characters per book (find the show/movie, find a clip, extract just that character's dialogue) takes hours. The legal complexity means we shouldn't automate the actual downloading, but Gemini can do the research leg almost instantly.

---

## New Command

```bash
# Research one character
pnpm find-voice-sources -- --character "Raphael" --franchise "TMNT"

# Research all new characters in a book/issue (characters not yet in source-material.json)
pnpm find-voice-sources -- --book tmnt-mmpr --issue 4
```

---

## New Script: `scripts/find-voice-sources.ts`

### Logic

1. **Load characters**: Read `assets/comics/<book>/issue-<n>/data/character-voice-descriptions.json`
2. **Filter**: Skip characters already in `data/source-material.json` (already have a voice source)
3. **For each new character**: Call Gemini (`GEMINI_HIGH` — needs world knowledge) with a grounded research prompt.

   **Model rule (Phase 1):** Never hardcode model strings. Import from `scripts/utils/models.ts`:
   ```ts
   import { GEMINI_HIGH } from "./utils/models.js";
   // then use: model: GEMINI_HIGH
   ```

   ```
   What animated series, movies, video games, or live-action productions has the character
   "[Character Name]" from "[Franchise]" appeared in with voiced dialogue?
   
   For each appearance, return:
   - mediaTitle: name of the show/movie/game
   - year: release year  
   - voiceActor: name of voice actor
   - mediaType: "animated_series" | "movie" | "video_game" | "live_action"
   - youtubeSearchTerms: 2-3 good search queries to find clips on YouTube
   - notes: any relevant context (e.g., "original voice actor", "reboot", "cameo only")
   
   Return as JSON array.
   ```

4. **Save**: Write `assets/comics/<book>/issue-<n>/data/voice-sourcing-suggestions.json`

5. **Interactive selection**: Display a terminal table for each character:
   ```
   ── Raphael ──────────────────────────────────────────
    1. TMNT (1987 cartoon)       Josh Pais / Cam Clarke   
    2. TMNT (1990 movie)         Josh Pais                ← recommended
    3. TMNT (2003 series)        Frank Frankson           
    4. TMNT (2007 movie)         Nolan North              
    5. TMNT (2012 Nickelodeon)   Sean Astin               
    6. Skip (use auto-generated voice)
   
   Pick a voice for Raphael [1-6]: 
   ```

6. **Write source-material entries**: For chosen appearances, write to `data/source-material.json`:
   ```json
   {
     "Raphael": {
       "youtubeSearchTerms": ["TMNT 1990 movie Raphael voice clips", "Josh Pais Raphael dialogue"],
       "mediaAppearance": "TMNT (1990 movie)",
       "voiceActor": "Josh Pais",
       "status": "needs_clips"
     }
   }
   ```
   
   Note: Status `"needs_clips"` signals to the pipeline (Phase 2, step 9 human-pause) that clips haven't been downloaded yet.

### Why Not Auto-Download?
Copyright. Downloading clips from YouTube programmatically for voice cloning sits in legally murky territory. The user keeps control by:
1. Reviewing Gemini's suggestions
2. Choosing the preferred voice
3. Running `pnpm audio-downloader` manually with the YouTube URL they find

The `find-voice-sources` script just eliminates the research time.

---

## package.json Addition

```json
"find-voice-sources": "tsx --env-file=.env scripts/find-voice-sources.ts"
```

---

## Integration with Phase 2 Pipeline
In `ingest.ts`, step 9 (`find-voice-sources`):
- Checks if all characters have entries in `source-material.json`
- If any are missing, runs `find-voice-sources` automatically
- Pauses after with a human-review prompt: "Voice sources generated. Review `data/source-material.json`, download clips, then press Enter to continue."

---

## Implementation Steps

1. Create `scripts/find-voice-sources.ts`
2. Add `find-voice-sources` to `package.json` scripts
3. Update `data/source-material.json` schema to add `status` and `youtubeSearchTerms` fields
4. Wire into `ingest.ts` step 9 (Phase 2 must be done first)

## Verification
```bash
# Test with a known character
pnpm find-voice-sources -- --character "Raphael" --franchise "TMNT"
# Expect: list of media appearances with accurate voice actor names and search terms
# Spot-check: search one of the generated YouTube terms, verify it surfaces relevant clips
```
