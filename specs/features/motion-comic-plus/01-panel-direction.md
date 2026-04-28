# Panel Direction

## Status: `pending`
## Goal: One Gemini Vision call per page returns everything the renderer needs to build a motion comic
## Cost: ~$0.10 per issue (24 GEMINI_MEDIUM calls)

---

## Inputs Gemini already gets / needs

The current `plan-shots` Gemini call sends **only** the page WebP. That's wasteful given:

- We have rich `aiReasoning` per bubble cached at `assets/comics/<book>/<issue>/data/gemini-context/page-NN-gemini-context.json` from the original ingest
- Each bubble's reasoning describes where it sits on the page, which characters are in frame, what's happening — Gemini won't have to re-derive any of this if we feed it back

**Plan:** the new prompt sends:
1. The page WebP image
2. The bubble manifest for the page: `[{ id, type, speaker, emotion, textWithCues, style }, ...]`
3. The previous page's `setting` summary (one sentence) — for scene continuity
4. The cached `aiReasoning` joined into a single context block

---

## Output schema (`panel-direction.json`)

```json
{
  "bookId": "tmnt-mmpr-iii",
  "issueId": "issue-1",
  "generatedAt": "2026-04-28T22:00:00Z",
  "pages": [
    {
      "pageNumber": 3,
      "settingSummary": "Barren desert canyon disrupted by a violent crackling blue energy vortex.",
      "isNewScene": true,
      "panels": [
        {
          "panelId": "p03-01",
          "boundingBox": { "x": 0.05, "y": 0.0,  "w": 0.9,  "h": 0.5 },
          "cinematicDescription": "vertical high-angle dynamic Dutch angle — futuristic armored vehicle caught in a crackling blue energy vortex amidst barren desert canyon walls",
          "effectTags": ["energy_portal_blue", "smoke_billow", "impact_lines_radial", "camera_push_in_slow"],
          "audioTags": {
            "ambience": ["wind_desert", "energy_hum_low"],
            "sfx": ["whoosh_metallic_swirl", "explosion_distant_muffled"],
            "music_mood": "tense_climax"
          },
          "bubbleIds": ["page-03_b01", "page-03_b02", "page-03_b03"],
          "primarySpeaker": "Narrator",
          "estimatedDurationSeconds": 6.0
        },
        { "panelId": "p03-02", "...": "..." }
      ]
    }
  ]
}
```

### Field semantics

| Field | Why |
|---|---|
| `boundingBox` | 0–1 fractions of page dimensions. Drives the panel-swipe reader's pan/zoom. |
| `cinematicDescription` | Only for cataloging / future Hero Shot Cinematic prompts. NOT shown to user. IP-name-free. |
| `effectTags` | Strings keyed to entries in the effect library (spec 03). Renderer composites. |
| `audioTags` | Three layers — ambience loops (low volume), sfx single-shots, music mood. Spec 04 maps tags to actual files. |
| `bubbleIds` | Which bubbles speak inside this panel. Drives audio layer timing alignment. |
| `primarySpeaker` | Used by the reader for highlighting and for dialogue panel framing. |
| `estimatedDurationSeconds` | Sum of bubble durations + 1s of "ambient panel time" before/after. |
| `isNewScene` | True = music can transition. False = continue current bed. |

`shotId` is **gone** — panels are the unit, not shots. The "every speaker change → new shot" rule that produced 190 shots/issue is dropped. Speaker turns within a panel just sequence audio playback within that panel's display window.

---

## Gemini prompt (revised)

```
You are a panel-direction analyst for a motion comic. The page image is attached.

You're also given for context:
  - The bubble manifest for this page (types, speakers, OCR snippets, % positions)
  - Per-bubble reasoning from a prior pass (already paid for) — use this freely
  - One-line summary of the previous page's setting

Your job is to return a JSON object describing the page's panels in a way that drives a web motion-comic renderer. For each visually distinct panel, return:

  - panelId: "p<page>-<NN>" sequential
  - boundingBox: { x, y, w, h } as 0–1 fractions of the page
  - cinematicDescription: one sentence in cinematic vocabulary
       ("low-angle wide shot — neon-lit rooftop in driving rain — two
        armored figures square off — tense"). NEVER use IP/character
        names; describe by visible traits only.
  - effectTags: pick 1–4 from this enum: [
        "energy_portal_blue", "energy_portal_red", "energy_portal_green",
        "smoke_billow", "smoke_drift", "fire_flicker", "embers_rising",
        "impact_lines_radial", "speed_lines_horizontal", "speed_lines_diagonal",
        "panel_shake_hard", "panel_shake_subtle", "camera_push_in_slow",
        "camera_push_in_fast", "camera_pull_back", "camera_pan_horizontal",
        "rim_lighting_glow", "lens_flare_warm", "lens_flare_cool",
        "rain_falling", "snow_falling", "leaves_drifting"
      ]
  - audioTags:
      ambience: pick 0–2 from [
        "wind_desert", "wind_arctic", "city_traffic_distant",
        "rain_steady", "energy_hum_low", "industrial_machinery",
        "forest_birds", "lab_electronics_beep", "ocean_waves"
      ]
      sfx: pick 0–3 from [
        "whoosh_metallic_swirl", "explosion_distant_muffled",
        "explosion_close_punchy", "sword_clang", "punch_impact",
        "footstep_concrete", "glass_shatter", "energy_zap",
        "thunder_distant", "vehicle_engine_rev"
      ]
      music_mood: pick 1 from [
        "tense_climax", "action_chase", "somber_reflective",
        "heroic_triumphant", "menacing_villain", "comedic_light",
        "mystery_ambient", "transition_neutral"
      ]
  - bubbleIds: list bubble ids whose center falls inside the panel's
       boundingBox (use the % positions in the manifest)
  - primarySpeaker: most-frequent speaker across the panel's bubbles,
       or null for narration-only panels
  - estimatedDurationSeconds: 1s lead-in + sum of bubble durations + 1s tail
  - isNewScene (top-level, page-wide): true if THIS page's setting is
       materially different from the previous page

Output strict JSON only, no markdown fences.
```

The enum-constrained `effectTags` and `audioTags` are critical — Gemini doesn't get to invent strings. Every tag we accept maps to a concrete file or component. Anything Gemini hallucinates outside the enum is silently dropped by the renderer. The lists above are **v1 starter sets**; the effect library (spec 03) and audio library (spec 04) define the canonical vocabulary, and we extend the enum as we add capabilities.

---

## Implementation

### File: `scripts/utils/panel-director.ts`

Replaces `scripts/utils/shot-planner.ts` semantically. Old `shot-planner.ts` stays for the optional Hero Shot Cinematic path; `panel-director.ts` is the new default.

```ts
export async function directPanels(args: {
  bookId: string;
  issueId: string;
  bubblesByPage: Record<string, Bubble[]>;
  audioTimestamps: Record<string, AudioTimestamp>;
  geminiContextByPage: Record<number, GeminiContextEntry[]>;
  pageImagesDir: string;
}): Promise<PanelDirection> { ... }
```

### Pipeline integration

New step on `scripts/generate-episode.ts`:
```ts
const STEPS = [
  "setup-series",
  "lock-characters",
  "direct-panels",  // NEW: replaces "plan-shots" as default
  "plan-shots",     // KEPT but now optional, only runs if --hero-shots flag is set
] as const;
```

The user runs:
```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step direct-panels
```

Output lands at `assets/episodes/<book>/<issue>/panel-direction.json`.

### Backfill `page_context` table while we're at it

Small standalone script: `scripts/backfill-page-context.ts` that walks every issue's `data/gemini-context/page-NN-gemini-context.json` and upserts to `page_context`. Restores the DB integrity that the original ingest skipped. **One-time chore.**

---

## Acceptance test

1. Run `direct-panels` against `tmnt-mmpr-iii / issue-1`
2. Open `panel-direction.json` — every page has `panels[]` with non-empty `boundingBox`, `effectTags`, `audioTags`, `bubbleIds`
3. Sum `estimatedDurationSeconds` across panels — within 10% of the original `motion-comic.mp4` runtime (~14 minutes)
4. **No bubble is unmapped:** for each bubble in `bubbles.json`, assert it appears in exactly one panel's `bubbleIds`
5. Page 3 specifically should produce 1–3 panels, not 11
