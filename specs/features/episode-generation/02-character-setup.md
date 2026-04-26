# Phase 1 — Character Setup

## Status: `pending`
## Prerequisites: `data/character-registry.json` populated (character-registry feature done)
## Cost: ~$2–5 one-time per book (seedream reference images), ~$0.10–0.30 per issue (Gemini aesthetic analysis)

---

## Purpose

Two one-time setup tasks that unlock the cinematic pipeline:

1. **Add `visualDescription` to the character registry** — a written description of each character's *visual* appearance (distinct from `voiceDescription` which describes the voice). Used as Venice image prompts.
2. **Lock the series aesthetic** — send comic pages through Gemini Vision to derive a style prompt. Written to `series.json`. All generated images use this aesthetic to stay visually coherent.
3. **Generate seedream reference images** — one reference PNG per character, used as style anchors when conditioning Kling 3.0 for character shots.

These run once per book (not per issue). Re-run only if adding new characters or restyling.

---

## Registry Schema Update

Add `visualDescription` to `AppearanceEntry` in `scripts/types/registry.ts`:

```typescript
export interface AppearanceEntry {
  id: string;
  mediaTitle: string | null;
  year: number | null;
  voiceActor: string | null;
  mediaType: MediaType;
  youtubeSearchTerms: string[];
  notes: string | null;
  visualDescription?: string | null;  // ← NEW: visual appearance for Venice image prompts
  voice: VoiceEntry | null;
}
```

`visualDescription` is stored on the *appearance* (not the character root) because visual style varies by media adaptation. Raphael in the 1990 movie looks different from the 1987 cartoon.

---

## Commands

```bash
# Full setup (aesthetic + references for all characters)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step setup-series
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step lock-characters

# Or as part of the full pipeline (runs automatically if series.json doesn't exist)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1
```

---

## Step: `setup-series`

### Output

`assets/episodes/<book>/series.json`:

```json
{
  "bookId": "tmnt-mmpr-iii",
  "aesthetic": {
    "stylePrompt": "90s Saturday morning cel animation, bold black outlines, flat vibrant primary colors, clean line art, dynamic action poses, comic panel composition",
    "palette": "vibrant primaries, high contrast, limited shadow",
    "lighting": "flat, cartoonish, no photorealism",
    "lens": "dynamic angles, dramatic perspective",
    "negativePrompt": "photorealistic, 3D render, CGI, modern art style, watercolor, sketch"
  },
  "generatedAt": "2026-04-26T00:00:00Z",
  "sourcePages": ["page-01.webp", "page-05.webp", "page-12.webp"]
}
```

### Process

1. Check if `assets/episodes/<book>/series.json` exists — skip if yes (prompt to `--force` to regenerate)
2. Select 3 representative pages from the issue (pages 1, ~⌊n/2⌋, and ~⌊3n/4⌋)
3. Send all 3 page images to Gemini Vision (`GEMINI_HIGH`) with prompt:

```
Analyze the visual style of these comic book pages and produce a style description 
suitable for an AI image generation prompt. Focus on:
- Art style (cel animation, line art weight, shading approach)
- Color palette characteristics
- Lighting and rendering style
- What to avoid (photorealism, wrong art styles)

Return JSON: { stylePrompt, palette, lighting, lens, negativePrompt }
```

4. Write `series.json`

---

## Step: `lock-characters`

### Process

For each character in `data/character-registry.json` where any appearance has `voice.status === "ready"`:

1. **Get or generate `visualDescription`**

   If the appearance already has `visualDescription` in the registry: use it directly.
   
   If not: check if the character is well-known IP (TMNT, Power Rangers). For known IP, generate description automatically using Gemini with the character name + franchise:
   
   ```
   Write a concise visual appearance description for [character] from [franchise] 
   as they appear in [mediaTitle]. Include: species/humanoid type, distinctive costume 
   colors, signature weapon or accessory, body type. 3–4 sentences. 
   This will be used as an AI image generation prompt.
   ```
   
   Model: `GEMINI_MEDIUM` (factual character description, no reasoning needed).
   
   Save the result back to the registry appearance's `visualDescription` field.

2. **Generate seedream reference image**

   If `assets/episodes/<book>/characters/<name>/reference.png` exists: skip (unless `--force`).
   
   Build the image prompt:
   ```
   [appearance.visualDescription], [series.aesthetic.stylePrompt], character portrait, 
   facing forward, plain background, full body visible
   ```
   
   POST to Venice `/image/generate`:
   ```json
   {
     "model": "seedream-v5-lite",
     "prompt": "<built prompt>",
     "negative_prompt": "<series.aesthetic.negativePrompt>",
     "resolution": "1024:1024"
   }
   ```
   
   Save:
   - `assets/episodes/<book>/characters/<name>/reference.png`
   - `assets/episodes/<book>/characters/<name>/reference.provenance.json`:
     ```json
     {
       "model": "seedream-v5-lite",
       "characterName": "Raphael",
       "appearanceId": "raphael-1990-movie",
       "prompt": "...",
       "negativePrompt": "...",
       "generatedAt": "2026-04-26T00:00:00Z"
     }
     ```

3. Log Venice balance after each image generation call.

### Review After `lock-characters`

```
✅ Generated 12 character reference images

Opening character references in Finder...
```

```bash
open assets/episodes/<book>/characters/
```

Finder opens showing all character reference PNGs as thumbnail previews. The pipeline then prompts:

```
Review character references in Finder.
Regenerate specific characters? [enter names comma-separated, or Enter to continue]:
```

If names entered: re-run seedream for those characters only (with `--force` on those entries).

---

## Known Characters for TMNT × MMPR III

For the existing book, `visualDescription` can be pre-populated without Gemini calls. These are well-known IP with unambiguous visual designs. Write these directly into the registry when running `lock-characters`:

| Character | Notes |
|-----------|-------|
| Leonardo | Blue mask, twin katana, blue plastron trim, stoic posture |
| Raphael | Red mask, twin sai, stockier build, aggressive stance |
| Michelangelo | Orange mask, nunchucks, most casual posture |
| Donatello | Purple mask, bo staff, taller and leaner |
| Tommy Oliver (White Ranger) | White ranger suit, gold accents, white helmet, Saba sword |
| Kimberly (Pink Ranger) | Pink ranger suit, pink helmet |
| Billy (Blue Ranger) | Blue ranger suit, blue helmet |
| Zack (Black Ranger) | Black ranger suit, black helmet |
| Trini (Yellow Ranger) | Yellow ranger suit, yellow helmet |
| Jason (Red Ranger) | Red ranger suit, red helmet |
| Zordon | Massive ethereal blue head floating in a column of light |
| Alpha 5 | Short gold and red robot with dome head |
| Shredder | Bladed silver armor, winged helmet, dark cape |
| Bebop | Warthog-human hybrid, mohawk, sunglasses, purple vest |
| Rocksteady | Rhinoceros-human hybrid, army helmet, military vest |

---

## Key Files

- `scripts/types/registry.ts` — add `visualDescription` field
- `data/character-registry.json` — write `visualDescription` + provenance
- `scripts/utils/venice-client.ts` — Venice API calls
- `scripts/utils/models.ts` — Gemini model constants
