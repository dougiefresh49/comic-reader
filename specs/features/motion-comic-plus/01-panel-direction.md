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

## DB schema

The browser reader needs panels at runtime, so they live in the DB with the `panel-direction.json` file kept as a debug artifact only.

### New table `panels`

```sql
CREATE TABLE panels (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id                     text NOT NULL,
  issue_id                    text NOT NULL,
  page_number                 int  NOT NULL,
  panel_id                    text NOT NULL,           -- "p03-01" stable within issue
  sort_order                  int  NOT NULL,           -- panel order within page
  bounding_box                jsonb NOT NULL,          -- {x, y, w, h} as 0..1
  cinematic_description       text,
  effect_tags                 text[] NOT NULL DEFAULT '{}',
  audio_tags                  jsonb NOT NULL DEFAULT '{}',
  primary_speaker             text,
  estimated_duration_seconds  real,
  is_new_scene                boolean NOT NULL DEFAULT false,
  source                      text NOT NULL DEFAULT 'gemini',  -- 'gemini' | 'roboflow' | 'manual'
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, issue_id, panel_id),
  FOREIGN KEY (book_id, issue_id) REFERENCES issues(book_id, id)
);

CREATE INDEX panels_page_idx ON panels(book_id, issue_id, page_number, sort_order);
```

Note: the denormalized `bubble_ids text[]` from the JSON output isn't stored on `panels`. Instead, each bubble gets a foreign key pointing at its panel — see below.

### Bubble ↔ panel relationship

Use a foreign key on `bubbles`, not a junction table. A bubble belongs to **one** panel; a panel has **many** bubbles. (1-to-N normalization.)

```sql
ALTER TABLE bubbles
  ADD COLUMN panel_id uuid REFERENCES panels(id) ON DELETE SET NULL;

CREATE INDEX bubbles_panel_idx ON bubbles(panel_id);
```

Why a FK and not the array on panels:
- The "drag a bubble to a different panel" UI mutates bubbles.panel_id with a single UPDATE — no array splice / re-write.
- Joining bubbles → panel is trivial (`SELECT b.*, p.* FROM bubbles b JOIN panels p ON b.panel_id = p.id`).
- `ON DELETE SET NULL` so deleting a panel doesn't cascade-delete bubbles; they just become "unassigned" and the manual review UI can reassign them.

If `bubbles.panel_id` is NULL, that's the "needs assignment" state — the renderer skips effects for unassigned bubbles, and the panel-review UI surfaces them prominently.

### Reads from the live app

```ts
// src/server/pages/queries.ts
export async function getPanelsForPage(bookId, issueId, pageNumber) {
  const { data } = await supabase
    .from("panels")
    .select("*, bubbles(id, legacy_id, sort_order)")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");
  return data;
}
```

The Supabase client foreign-key embedding does the join for free.

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

## Manual panel review (browser)

The Gemini panel detection won't be perfect — bounding boxes will sometimes overlap, miss, or assign a bubble to the wrong panel (especially when a speech tail crosses a panel edge). The review UI needs a panel-editing mode alongside the existing bubble-editing mode.

### Mode toggle in the review sidebar

```
┌─────────────────────────────┐
│ Review: TMNT × MMPR III #1  │
│ Page 3 of 24                │
│                             │
│ [ Bubbles ]  [ Panels ]    │   ← toggle, persists per-session
│                             │
│ ...mode-specific UI...      │
└─────────────────────────────┘
```

Bubble mode is what ships today. Panel mode shows:

- A panels list (sortable, reorderable per page) with per-panel cards showing: bbox preview, cinematic description, effect tags, audio tags, count of assigned bubbles
- The full-page image is overlaid with **panel rectangles** (semi-transparent fills, distinct color per panel) instead of bubble overlays
- Drag a panel edge to resize the bbox; drag inside to reposition; double-click to enter "edit panel" form
- Bubbles still render but as small dots colored by their assigned panel, so you can spot bubbles whose dot color disagrees with the surrounding panel
- Click a bubble dot to either reassign to the active panel (one click) or pop a "move to panel ▾" picker

### Operations

| Action | Effect | Storage |
|---|---|---|
| Resize / reposition panel rect | Update `panels.bounding_box` for that panel | DB write on save (or on Apply to DB) |
| Reassign a bubble to another panel | Update `bubbles.panel_id` for that bubble | DB write on save |
| Edit cinematic description / effect tags / audio tags | Form fields on the panel card | DB write |
| Add a panel | "+ Panel" button → drag a new rect → fill form | INSERT into panels with `source = 'manual'` |
| Delete a panel | Trash icon on card → confirms → soft delete | DELETE; bubbles' panel_id → NULL via FK |
| Reorder panels | Drag handle on cards | Update `sort_order` |

The "Apply to DB" pattern from the bubble review extends naturally — IndexedDB-backed local edit buffer, batched POST to a server action. New endpoint: `/api/admin/apply-panel-fixes`.

### Why we want this even if Gemini is good

1. Bubbles that spill across panel borders need explicit assignment
2. Splash pages and full-page art are ambiguous — a human picks "treat as one big panel" vs "split into N visual beats"
3. Effect / audio tags will sometimes need overrides ("this isn't really a portal scene")
4. Building this once gives us the hand-tweak escape hatch for everything in the schema, including effect / audio drift over time

### Roboflow fallback for panel detection

If Gemini's panel detection turns out poor on real pages, swap in the Roboflow workflow at `https://detect.roboflow.com/infer/workflows/fresh-space/find-comic-panel-v1`. The workflow returns rectangle bounding boxes; we map those to the same `panels` table (with `source = 'roboflow'`).

The `source` column lets the reviewer's UI flag where a panel came from. Mixed-source pages (some panels from Roboflow, some from manual edits, some from Gemini) are fine — they're all just rows.

A standalone `scripts/train-panel-detection.ts` exists to feed page WebPs to the workflow for training data accumulation. Once Roboflow's confidence is high enough, we'd add a `direct-panels --source roboflow` switch to use it instead of Gemini.

---

## Acceptance test

1. Run `direct-panels` against `tmnt-mmpr-iii / issue-1`
2. Open `panel-direction.json` — every page has `panels[]` with non-empty `boundingBox`, `effectTags`, `audioTags`, `bubbleIds`
3. Sum `estimatedDurationSeconds` across panels — within 10% of the original `motion-comic.mp4` runtime (~14 minutes)
4. **No bubble is unmapped:** for each bubble in `bubbles.json`, assert it appears in exactly one panel's `bubbleIds`
5. Page 3 specifically should produce 1–3 panels, not 11
