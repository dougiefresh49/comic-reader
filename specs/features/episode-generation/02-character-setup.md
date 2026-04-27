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
# Run individual steps
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step setup-series
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step lock-characters

# Force re-run even if output already exists
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step setup-series --force

# Or as part of the full pipeline (runs automatically if series.json doesn't exist)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1
```

---

## `generate-episode` Script Structure

**New file:** `scripts/generate-episode.ts`

This is the entry point for all cinematic episode pipeline steps (Phases 1–5). It's a dispatcher — parses args, then calls the appropriate step function.

### Args

| Flag | Required | Description |
|------|----------|-------------|
| `--book <name>` | Yes | Book identifier |
| `--issue <n>` | Yes | Issue number (normalized to `issue-N`) |
| `--only-step <step>` | No | Run only this step and exit |
| `--force` | No | Skip existence checks, re-generate even if output exists |
| `--help` / `-h` | No | Show usage |

### Step Registry (Phase 1 only — expand in later phases)

```ts
const STEPS = ["setup-series", "lock-characters"] as const;
type Step = typeof STEPS[number];
```

### Checkpoint File

Book-level steps (setup-series, lock-characters) use:
```
assets/episodes/<book>/episode-checkpoint.json
```

Issue-level steps (shot planning, storyboard, video, assembly — future phases) use:
```
assets/episodes/<book>/issue-<n>/episode-checkpoint.json
```

Checkpoint schema:
```json
{
  "completedSteps": ["setup-series", "lock-characters"],
  "lastRunAt": "2026-04-27T00:00:00Z"
}
```

When `--only-step` is provided: run that step and update the checkpoint, then exit.  
Without `--only-step`: run all steps not yet in `completedSteps`, in order.  
With `--force`: run the step regardless of checkpoint state (do not clear other steps).

### package.json entry

```json
"generate-episode": "tsx --env-file=.env scripts/generate-episode.ts"
```

---

## Venice API

### Base URL + Auth

```
Base URL: https://api.venice.ai/api/v1
Auth header: Authorization: Bearer <VENICE_API_KEY>
```

### `scripts/utils/venice-client.ts`

Create this utility. It handles all Venice API calls for the episode pipeline.

```ts
const VENICE_BASE = "https://api.venice.ai/api/v1";

// Generate a single image — returns raw PNG buffer
export async function generateImage(params: {
  model: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  seed?: number;
  format?: "png" | "jpeg" | "webp";
}): Promise<Buffer>

// Get current USD balance
export async function getBalance(): Promise<number>

// List available models (optional — for agent to verify model IDs)
export async function listModels(type?: "image" | "video" | "text"): Promise<VeniceModel[]>
```

### Image Generation (`POST /image/generate`)

Request:
```json
{
  "model": "seedream-v5-lite",
  "prompt": "...",
  "negative_prompt": "...",
  "aspect_ratio": "2:3",
  "format": "png",
  "hide_watermark": true
}
```

Response:
```json
{
  "images": ["<base64-encoded-png-string>"]
}
```

Decode `images[0]` from base64 to a `Buffer` and write to disk with `fs.writeFile`.

**Sizing note:** `seedream-v5-lite` uses `aspect_ratio`, not `width`/`height` (confirmed from `docs/venice-ai/image-models.json` — it has no `widthHeightDivisor` constraint, only `aspectRatios`). Use `"aspect_ratio": "2:3"` for portrait character references. Do not pass `width` or `height` — the API will ignore or reject them.

**Rate limit:** 20 image requests/minute. Add a 3-second delay between image generation calls to stay safely under this. No retry logic needed for Phase 1 (small batch).

### Balance Check (`GET /api_keys/rate_limits`)

```json
{
  "data": {
    "balances": {
      "USD": 50.23
    }
  }
}
```

Log after each image generation:
```
   💰 Balance remaining: $47.83 USD
```

---

## Venice Model Constants

All Venice model ID strings live in `scripts/utils/models.ts` alongside the Gemini constants. Never hardcode them inline.

Add these exports in Phase 1. Model IDs are confirmed from `docs/venice-ai/image-models.json` and `docs/venice-ai/video-models.json`.

```ts
// ─── Venice image models ────────────────────────────────────────────────────
// Phase 1 — character reference images (text-to-image)
// $0.05/image | aspectRatios only (no width/height) | 10k char prompt limit
export const VENICE_IMAGE_CHAR_REF = "seedream-v5-lite";

// Phase 3 — storyboard panels: establishing/multi-character shots (text-to-image)
// $0.05/image | aspectRatios only | same model family as char ref → visual consistency
export const VENICE_IMAGE_STORYBOARD = "seedream-v5-lite";

// Phase 3 — storyboard panels: single-character shots (image editing)
// Edits reference.png into scene context. POST /image/edit, returns binary PNG.
// No width/height or negative_prompt. Use aspect_ratio instead.
export const VENICE_IMAGE_EDIT_CHAR = "seedream-v5-lite-edit";

// ─── Venice video models ─────────────────────────────────────────────────────
// Phase 4 — character shots: stable identity using reference.png as anchor
// cinematic | audio | 3–15s | reference-to-video (passes reference image for identity)
export const VENICE_VIDEO_CHARACTER = "kling-o3-pro-reference-to-video";

// Phase 4 — atmosphere/establishing shots: no character identity needed
// cinematic | photorealistic | audio | 1080p | up to 15s | image-to-video
export const VENICE_VIDEO_ATMOSPHERE = "seedance-2-0-image-to-video";
```

**Model capability notes:**
- `seedream-v5-lite` — text-to-image. Accepts `aspect_ratio` only (no `width`/`height`). `$0.05/image`. 20 req/min rate limit. Use `"2:3"` for portrait character refs, `"16:9"` for storyboard panels.
- `seedream-v5-lite-edit` — image edit via `POST /image/edit`. Takes **one** input image, returns **binary PNG** directly. No `negative_prompt`. No `width`/`height` — use `aspect_ratio`. Use to place a character reference image into a new scene.
- `kling-o3-pro-reference-to-video` — video R2V (reference-to-video). Takes `image_url` (panel) + `reference_image_urls` (up to 9 character references) for stable character identity. 3–15s clips, audio configurable. `POST /video/queue` + poll `POST /video/retrieve`.
- `seedance-2-0-image-to-video` — image-to-video. Cinematic + photorealistic, 1080p, durations: 4/5/8/10/12/15s. No reference images. Use for atmosphere/establishing shots.

**Video API note:** Video generation uses `POST /video/generate` (not the same as image generation). The video endpoint is async — it returns a job ID and you poll `GET /video/{id}` for completion. This is a Phase 4 concern; Phase 1 only uses image generation.

**Reference docs:** `docs/venice-ai/image-models.json`, `docs/venice-ai/video-models.json`, `docs/venice-ai/video-models-descriptions.json`

---

## Environment Variables

### `src/env.mjs`

Add `VENICE_API_KEY` to the server schema and `runtimeEnv`:

```js
server: {
  // ... existing keys ...
  VENICE_API_KEY: z.string(),
},
runtimeEnv: {
  // ... existing ...
  VENICE_API_KEY: process.env.VENICE_API_KEY,
},
```

The `.env` file already has `VENICE_API_KEY=` added. The agent must update `src/env.mjs` to register it.

**Note:** `generate-episode.ts` imports env via `~/env.mjs` (same pattern as other scripts). Do not use `process.env.VENICE_API_KEY` directly.

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
  "generatedAt": "2026-04-27T00:00:00Z",
  "sourcePages": ["page-01.webp", "page-05.webp", "page-12.webp"]
}
```

### Process

1. Check if `assets/episodes/<book>/series.json` exists — skip if yes (unless `--force`)
2. Select 3 representative pages from `assets/comics/<book>/<issue>/pages-webp/`: pages 1, `⌊n/2⌋`, and `⌊3n/4⌋`
3. Send all 3 page images to Gemini Vision (`GEMINI_HIGH`) with prompt:

```
Analyze the visual style of these comic book pages and produce a style description
suitable for an AI image generation prompt. Focus on:
- Art style (cel animation, line art weight, shading approach)
- Color palette characteristics
- Lighting and rendering style
- What to avoid (photorealism, wrong art styles)

Return JSON only (no markdown): { "stylePrompt": "...", "palette": "...", "lighting": "...", "lens": "...", "negativePrompt": "..." }
```

4. Write `series.json`

---

## Step: `lock-characters`

### Process

Requires `series.json` to exist (run `setup-series` first).

For each character in `data/character-registry.json` where any appearance has `voice.status === "ready"`:

1. **Get or generate `visualDescription`**

   If the appearance already has `visualDescription` in the registry: use it directly.

   If not: check if the character is well-known IP (TMNT, Power Rangers). For known IP, generate description automatically using Gemini:

   ```
   Write a concise visual appearance description for [character] from [franchise]
   as they appear in [mediaTitle]. Include: species/humanoid type, distinctive costume
   colors, signature weapon or accessory, body type. 3–4 sentences.
   This will be used as an AI image generation prompt.
   ```

   Model: `GEMINI_MEDIUM` (factual character description, no reasoning needed).

   Save the result back to the registry appearance's `visualDescription` field immediately after generation.

2. **Generate seedream reference image**

   Skip if `assets/episodes/<book>/characters/<canonicalName>/reference.png` exists and `--force` is not set.

   Build the image prompt:
   ```
   [appearance.visualDescription], [series.aesthetic.stylePrompt], character portrait,
   facing forward, plain background, full body visible
   ```

   Call `generateImage()` from `venice-client.ts`:
   ```ts
   {
     model: VENICE_IMAGE_CHAR_REF,       // "seedream-v5-lite" from models.ts
     prompt: builtPrompt,
     negativePrompt: series.aesthetic.negativePrompt,
     aspectRatio: "2:3",                 // portrait — seedream-v5-lite uses aspectRatio, not width/height
     format: "png",
   }
   ```

   Save:
   - `assets/episodes/<book>/characters/<canonicalName>/reference.png`
   - `assets/episodes/<book>/characters/<canonicalName>/reference.provenance.json`:
     ```json
     {
       "model": "seedream-v5-lite",      // VENICE_IMAGE_CHAR_REF value at generation time
       "characterName": "Raphael",
       "appearanceId": "raphael-1990-movie",
       "prompt": "...",
       "negativePrompt": "...",
       "generatedAt": "2026-04-27T00:00:00Z"
     }
     ```

   Log balance after each call. Add a 3-second delay between requests (image rate limit: 20/min).

3. **Progress logging:**
   ```
   [1/15] Raphael... visualDescription exists ✓
          Generating reference image... ✓  ($0.12)  💰 $47.71 remaining
   [2/15] Leonardo... visualDescription exists ✓
          Generating reference image... ✓  ($0.12)  💰 $47.59 remaining
   [3/15] Zordon... generating visualDescription...  ✓
          Generating reference image... ✓  ($0.12)  💰 $47.47 remaining
   ```

### Review After `lock-characters`

```
✅ Generated 15 character reference images

Opening character references in Finder...
```

```bash
open assets/episodes/<book>/characters/
```

Then prompt:

```
Review character references in Finder.
Regenerate specific characters? [enter names comma-separated, or Enter to continue]:
```

If names entered: re-run seedream for only those characters (respects `--force` behavior on those entries only). After regeneration, open Finder again and prompt once more. Repeat until user presses Enter.

---

## Known Characters for TMNT × MMPR III

For the existing book, `visualDescription` can be pre-populated without Gemini calls. These are well-known IP with unambiguous visual designs. Write these directly into the registry during `lock-characters`:

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

These should be hardcoded in `lock-characters` as fallback descriptions when `visualDescription` is not yet set and the character name matches one of the above — no Gemini call needed.

---

## Implementation Steps

1. Add `VENICE_API_KEY` to `src/env.mjs` (server schema + runtimeEnv)
2. Add `visualDescription?: string | null` to `AppearanceEntry` in `scripts/types/registry.ts`
3. Add Venice model constants to `scripts/utils/models.ts` — `VENICE_IMAGE_CHAR_REF`, `VENICE_IMAGE_STORYBOARD`, `VENICE_VIDEO_CHARACTER`, `VENICE_VIDEO_ATMOSPHERE` (see **Venice Model Constants** section above for exact values and comments)
4. Create `scripts/utils/venice-client.ts` — `generateImage()`, `getBalance()`, `listModels()`
   - Import model constants from `scripts/utils/models.ts`; do not hardcode model ID strings
   - `seedream-v5-lite` uses `aspect_ratio` not `width`/`height` — see Venice Model Constants section
5. Create `scripts/generate-episode.ts` — arg parsing, step dispatcher, checkpoint read/write
6. Implement `setup-series` step function (inline in generate-episode.ts or as a separate module)
7. Implement `lock-characters` step function — visualDescription generation, seedream calls, review prompt
8. Add `generate-episode` to `package.json`
9. Update `specs/features/features.md` — set Character Setup status to `done`

---

## Key Files to Read Before Implementing

- `scripts/types/registry.ts` — current AppearanceEntry type (add visualDescription here)
- `data/character-registry.json` — real data to understand character/appearance structure
- `scripts/utils/registry.ts` — loadRegistry, saveRegistry helpers to reuse
- `scripts/utils/models.ts` — GEMINI_MEDIUM, GEMINI_HIGH constants; add Venice constants here too
- `src/env.mjs` — env schema pattern to follow when adding VENICE_API_KEY
- `scripts/motion-comic.ts` — reference for script structure, arg parsing, and progress logging patterns
- `scripts/get-context.ts` — reference for Gemini Vision image input pattern (sending page images)
- `docs/venice-ai/image-models.json` — confirmed model IDs, constraints (aspect_ratio vs width/height), pricing
- `docs/venice-ai/video-models.json` — confirmed video model IDs and capabilities
- `docs/venice-ai/video-models-descriptions.json` — human-readable descriptions of each video model
