# Research: Generating Episodes from Comic Issues using Venice.ai

**Date:** 2026-04-26  
**Context:** Exploring how to take the existing comic reader assets (TMNT/MMPR, structured JSON, ElevenLabs audio) and use the Venice.ai ecosystem to generate watchable video episodes from each issue.

---

## 1. The Starting Point: What We Already Have

Unlike the `venice-video-harness` demo (which starts from a creative idea and generates everything), we are starting from a mostly-complete production pipeline. This is a significant advantage.

### Existing Assets Per Issue

| Asset | Location | Status |
|---|---|---|
| Comic page images (WebP) | `assets/comics/[book]/issue-[n]/pages-webp/` | WebP, 1200px wide |
| Full dialogue script | `assets/comics/[book]/issue-[n]/data/bubbles.json` | Structured JSON, all bubbles |
| Speaker + emotion per bubble | `bubbles.json`, per bubble | Character name, emotion, type |
| Voice audio (ElevenLabs) | `assets/comics/[book]/issue-[n]/audio/` | MP3 per bubble |
| Word-level timestamps | `assets/comics/[book]/issue-[n]/data/audio-timestamps.json` | ElevenLabs alignment data |
| Cast list (derived) | `assets/comics/[book]/issue-[n]/data/castlist.json` | Character → ElevenLabs Voice ID |
| Cast selections (source of truth) | `assets/comics/[book]/issue-[n]/data/cast-selections.json` | Character → appearance ID + voice ID |
| **Global character registry** | `data/character-registry.json` | All characters across all books, with voice descriptions and appearance metadata |

### The character registry is a key asset

`data/character-registry.json` is a global file (not per-issue) that persists across all books and issues. It contains:

- Character franchise, aliases
- All known media appearances (actor, year, media type)
- Voice ID and `voiceDescription` per appearance
- `voiceType`: `"ivc"` (Instant Voice Clone) or `"voice_design"`

**This is directly useful for Venice character reference image generation** — the `voiceDescription` field contains written character descriptions that can be adapted into Venice image prompts without additional Gemini calls.

### What `bubbles.json` gives us (per issue)

The core data file is a flat array of all bubbles for the issue:

```json
[
  {
    "id": "p03_b01",
    "box_2d": { "x": 450, "y": 300, "width": 200, "height": 100 },
    "ocr_text": "Cowabunga!",
    "type": "SPEECH",
    "speaker": "Michelangelo",
    "emotion": "excited",
    "style": { "left": "44%", "top": "30%", "width": "20%", "height": "10%" }
  }
]
```

This is functionally a structured screenplay — we have every line of dialogue, who says it, what emotional register they're in, and where on the page it appears. **We do not need Venice to generate or parse a script.**

### The pipeline that produced these assets

Assets go through `pnpm ingest -- --book <id> --issue <n>`, a single orchestrating command with checkpoint/resume support. Relevant stages for episode generation:

- **Stage 2** (`get-context`, `sort-bubbles-gemini`, `add-bubble-styles`) → `bubbles.json`
- **Stage 3** (`find-voice-sources`, `generate-voice-models`) → `castlist.json` + updates `data/character-registry.json`
- **Stage 4** (`generate-audio`) → `audio/*.mp3` + `audio-timestamps.json`

---

## 2. The Venice.ai Ecosystem — How It Works

### 2a. venice-video-harness (the reference implementation)

**Repo:** `https://github.com/jordanurbs/venice-video-harness`

A TypeScript agent-first framework for producing character-consistent, narrative-driven video from a Fountain screenplay. It is the end-to-end reference for what Venice can orchestrate.

#### Architecture (7 modules)

```
Script (Fountain/PDF)
  → Scene Extractor
  → Aesthetic Locker (visual style: palette, lighting, lens)
  → Character Reference Generator (seedream-v5-lite → portrait images)
  → Generation Planner (group shots: single vs multi-shot, max 6 shots/15s)
  → Panel/Image Generator (storyboard with face consistency)
  → Video Generator (panel → video clip per shot)
  → Assembler (FFmpeg: concat + audio + music + color grade)
```

#### Output structure

```
output/
├── series.json
├── characters/
│   └── michelangelo/
│       ├── michelangelo-reference.png
│       └── michelangelo-reference.provenance.json
└── episodes/
    └── 001/
        ├── script.json
        ├── generation-plan.json
        ├── panels/           ← shot-001.png, shot-002.png...
        ├── videos/           ← shot-001.mp4, shot-002.mp4...
        ├── dialogue/         ← character-line-001.mp3...
        ├── edl.json          ← edit decision list
        └── assembled/        ← final-episode.mp4
```

#### Key commands

| Command | Purpose |
|---|---|
| `new-series` | Initialize series state |
| `add-character` | Register a character with description + voice |
| `set-aesthetic` | Lock visual style (palette, lighting, etc.) |
| `lock-character` | Generate reference images for seedance face-consistency |
| `workshop-episode` | Iterative script refinement |
| `approve-script` | Freeze script for production |
| `storyboard-episode` | Generate panel images |
| `generate-videos` | Convert panels to video clips |
| `assemble-episode` | FFmpeg concatenation + music |
| `produce-episode` | Full pipeline in one shot |

#### Character consistency enforcement

This is the harness's most important innovation. Venice's `Seedance 2.0` (the best face-consistent video model) will **refuse to render** if input images weren't generated by `seedream-v5-lite`. The harness handles this with:

1. **Reference images**: All character faces generated once via `seedream-v5-lite`, saved with provenance JSON sidecar
2. **Face laundering**: If you have an image from another source (e.g., a comic panel) that contains a face, you must run it through `seedream-v5-lite-edit` before Seedance will accept it
3. **Gating**: `seedance-preflight.ts` validates all input images before submission

**Bottom line:** If we want cinematic character-consistent video, we need Venice-generated reference images — we cannot use the comic art directly as Seedance input without laundering it first.

### 2b. Venice API (api-docs)

**Base URL:** `https://api.venice.ai/api/v1`

#### Image Generation

```
POST /image/generate
{
  "model": "seedream-v5-lite",
  "prompt": "Teenage mutant ninja turtle, orange mask, nunchucks, ...",
  "resolution": "1024:1024"
}
→ { "images": [base64] }
```

#### Image Editing (multi-edit, reference-aware)

```
POST /images/edit
{
  "model": "flux-2-max-edit",
  "images": [base64_reference, base64_scene],
  "prompt": "Character in this setting, keep face consistent",
  "strength": 0.7
}
```

#### Video Generation (async queue)

```
POST /video/queue
{
  "model": "seedance-2.0",        // or "kling-3.0" for 3+ characters
  "prompt": "Character speaking ...",
  "duration": 6,                  // seconds; must match model's supported values
  "aspect_ratio": "16:9",
  "image_url": "base64_or_url"   // seedream-sourced image for Seedance
}
→ { "queue_id": "uuid", "quote_usd": 0.XX }

GET /video/retrieve?queue_id=uuid
→ { "status": "completed|processing|failed", "video": base64 }
```

#### Text-to-Speech

```
POST /audio/speech
{
  "model": "tts-xai-v1",
  "text": "Cowabunga!",
  "voice": "Rex",    // Eve, Ara, Rex, Sal, Leo
  "format": "mp3"
}
```

**Note:** We already have ElevenLabs IVC voice clones — far higher quality than Venice TTS. We should keep using ElevenLabs for dialogue and use Venice only for image and video generation.

#### Music/Ambient Generation

```
POST /audio/queue
{
  "model": "stable-audio-3",
  "prompt": "Epic 80s action cartoon theme",
  "duration": 300,
  "instrumental": true
}
```

This is a gap we don't currently fill. Venice could generate episode background music.

#### Model Decision Matrix

| Shot type | Characters | Model | Why |
|---|---|---|---|
| Dialogue / close-up | 1–2 | `seedance-2.0` | Best face consistency |
| Action / group | 3+ | `kling-3.0` | No face-count restrictions |
| Establishing / wide | 0–1 | `kling-3.0` | Cinematic quality |
| Title card / atmosphere | 0 | `kling-3.0` | No face constraint |

#### Pricing (approximate)

- Image generation: ~$0.02–0.10 per image
- Video clip (6s): ~$0.50–2.00 per clip
- TTS: ~$0.002–0.01 per request
- Music: ~$0.10–0.50 per clip
- Monitor `x-venice-balance-usd` response header

### 2c. Venice Skills (veniceai/skills)

19 pre-built LLM agent skills. Most relevant:

- `venice-video`: Video generation, upscaling, transcription
- `venice-image-generate`: Text-to-image
- `venice-image-edit`: Background removal, upscaling (inpainting disabled as of 2025-05-19)
- `venice-audio-speech`: TTS
- `venice-audio-music`: Music generation
- `venice-audio-transcription`: Audio-to-text with timestamps
- `venice-characters`: Character discovery and application

These are useful if building an agentic pipeline where Claude drives the workflow.

### 2d. Venice CLI (veniceai/venice-cli)

Privacy-first terminal tool. Useful for manual testing and exploration during development.

```bash
npm install -g veniceai-cli
venice config set api_key YOUR_API_KEY
venice image generate "A turtle in a ninja mask" --model seedream-v5-lite
venice video generate scene.png --model seedance-2.0 --duration 6
venice audio tts "Cowabunga!" --voice Rex --format mp3
venice audio music "80s cartoon action theme" --duration 60
```

---

## 3. The Gap Analysis: What We Have vs. What We Need

```
WE HAVE                                         WE NEED
────────────────────────────────────────────    ────────────────────────────────────
✅ Structured dialogue/script (bubbles.json)    ❌ Character reference images (Venice)
✅ Speaker + emotion per line                   ❌ Scene panels / storyboard images
✅ ElevenLabs IVC voice audio + timestamps      ❌ Video clips per scene/page
✅ Comic page art (WebP)                        ❌ Assembled episode video (FFmpeg)
✅ Global character registry (descriptions)     ❌ Background music/ambience
✅ Per-appearance voice descriptions            
✅ Word-level timestamps (audio-timestamps.json)
```

We are missing the **visual video layer** — Venice handles this. Notably, the global character registry already contains `voiceDescription` fields that can be adapted directly into Venice image generation prompts.

---

## 4. Proposed Integration Architecture

### The Big Question: What is a "Shot"?

This is the most important design decision. Three approaches:

#### Option A — Page as Shot (Simplest, Motion Comic)

Each comic page becomes one video clip. The existing comic art is animated (Ken Burns effect) and the full page's dialogue audio is layered in.

- **Pro:** Preserves the original comic aesthetic. Minimal AI generation cost. Directly uses existing WebP pages from `pages-webp/`.
- **Con:** Not truly "cinematic." Looks like an animated slideshow. Doesn't require Venice video generation at all (just FFmpeg + comic art).
- **Venice usage:** Minimal — possibly just music generation.

#### Option B — Panel as Shot (Middle Ground)

Each detected panel region (derived from bubble coordinates in `bubbles.json`) becomes a separate video clip, animated with slight motion.

- **Pro:** More cinematic cuts, respects the original art, moderate cost.
- **Con:** Need panel boundary detection (could use Roboflow or Gemini). Comic art faces won't pass Seedance face-check without laundering.
- **Venice usage:** `flux-2-max-edit` to launder panels → `seedance-2.0` for character panels, `kling-3.0` for wide shots.

#### Option C — Full AI Cinematic Generation (Ambitious)

Use the comic panels as **visual reference** and regenerate entirely new cinematic scenes using Venice image + video models. The dialogue audio from ElevenLabs is preserved.

- **Pro:** True video production quality. Character-consistent across episodes. Fully scalable.
- **Con:** Highest cost. Requires character reference image generation pass first. Generated scenes may feel stylistically different from the comic art.
- **Venice usage:** Full pipeline — `seedream-v5-lite` for references, `seedance-2.0` / `kling-3.0` for video, `stable-audio-3` for music.

**Recommendation:** Start with **Option A** to validate the pipeline end-to-end cheaply, then build toward **Option C** as a premium episode tier.

---

## 5. Detailed Pipeline for Option C (Full Cinematic)

This adapts the `venice-video-harness` workflow to our existing assets.

### Phase 0: Series Setup (One-Time)

```
1. Read data/character-registry.json → extract all characters with status: "ready"
2. For each character:
   a. Use the existing voiceDescription from their registry appearance entry as the
      base for the Venice image prompt (avoids needing Gemini calls for descriptions)
   b. POST /image/generate (seedream-v5-lite) → save reference.png
   c. Save provenance.json sidecar: { model, timestamp, characterName }
3. Store references in: assets/episodes/[book]/characters/[name]/reference.png
4. Lock aesthetic style: e.g., "80s animated cartoon, cel-shading, vibrant colors"
```

### Phase 1: Script-to-Shots (Per Issue)

```
Input: assets/comics/[book]/issue-[n]/data/bubbles.json

1. Group bubbles into "shots":
   - Consecutive bubbles on the same page with same primary speaker = one shot
   - Page transitions = scene break (establishing shot opportunity)
   - NARRATION/CAPTION type bubbles = voiceover shot (no character face needed)

2. For each shot, build a shot descriptor:
   {
     "shotId": "e01_s003",
     "type": "dialogue",          // or "establishing" | "action" | "narration"
     "characters": ["Michelangelo", "Leonardo"],
     "primarySpeaker": "Michelangelo",
     "emotion": "excited",
     "dialogue": ["Cowabunga!", "What's the plan, Leo?"],
     "audioFiles": ["bubble-001.mp3", "bubble-002.mp3"],
     "sourcePage": "page-03.webp",
     "duration": 4.2              // sum of audio clip durations
   }

3. Cross-reference audio-timestamps.json for accurate per-bubble durations
```

### Phase 2: Image Generation (Storyboard)

```
For each shot:
  If type === "establishing" or characters.length === 0:
    → POST /image/generate (seedream-v5-lite or flux-2-max)
    → Prompt: "[aesthetic style], [location from page context], [mood]"
  
  If type === "dialogue" and characters.length <= 2:
    → POST /images/edit (flux-2-max-edit)
    → Images: [character reference images from Phase 0]
    → Prompt: "[aesthetic], [emotion], [action description]"
  
  If type === "action" and characters.length >= 3:
    → POST /image/generate (seedream-v5-lite)  
    → Prompt: "[aesthetic], [all character descriptions], [action scene]"
  
  → Save shot image to assets/episodes/[book]/issue-[n]/panels/shot-NNN.png
  → Save provenance.json (model used, has_face boolean)
```

### Phase 3: Video Generation

```
For each shot panel:
  → Run seedance-preflight: check provenance.json
    - If has_face AND model !== seedream: launder via seedream-v5-lite-edit first
  
  → Select video model:
    - characters.length <= 2 AND seedream-sourced: POST /video/queue (seedance-2.0)
    - otherwise: POST /video/queue (kling-3.0)
  
  → Params:
    {
      "image_url": base64_of_panel,
      "prompt": "[character action] [emotion] [dialogue excerpt]",
      "duration": min(30, max(2, Math.ceil(shot.duration + 1.5))),
      "aspect_ratio": "16:9"
    }
  
  → Poll GET /video/retrieve?queue_id=... until status === "completed"
  → Save video to assets/episodes/[book]/issue-[n]/videos/shot-NNN.mp4
```

### Phase 4: Audio Assembly

```
We skip Venice TTS — we already have ElevenLabs IVC audio in assets/.../audio/.

For each shot:
  → Build dialogue track: concatenate shot's audio files in bubble order
    (bubble order is already sorted correctly in bubbles.json by sort-bubbles-gemini)
  → Add 0.3s silence between lines

Optional:
  → POST /audio/queue (stable-audio-3) for episode background music
  → Generate: "[show theme], 80s animated cartoon, action, instrumental"
```

### Phase 5: FFmpeg Assembly

```
For each shot:
  ffmpeg -i shot-NNN.mp4 -i shot-NNN-dialogue.mp3 \
    -filter_complex "[0:a]volume=0.3[va];[va][1:a]amix=inputs=2[aout]" \
    -map 0:v -map "[aout]" \
    shot-NNN-mixed.mp4

Final episode:
  ffmpeg -f concat -safe 0 -i shots.txt \
    -i background-music.mp3 \
    -filter_complex "[0:a]volume=1[dia];[1:a]volume=0.15[bg];[dia][bg]amix=inputs=2[aout]" \
    -map 0:v -map "[aout]" \
    assets/episodes/[book]/issue-[n]/episode-001.mp4
```

---

## 6. New Script(s) to Build

Following the project's existing pattern (`pnpm ingest`, checkpoint/resume, `--book`/`--issue` flags):

### `scripts/generate-episode.ts`

```typescript
// Orchestrates the full Venice episode generation pipeline
// Usage: pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1
//        pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --from-step storyboard
//        pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --dry-run

// Steps it runs (each checkpointed):
// 0. lock-characters    — generate seedream reference images from character-registry.json
// 1. plan-shots         — read bubbles.json → group into shot descriptors
// 2. storyboard         — Venice image generation per shot → panels/
// 3. generate-videos    — Venice video queue per panel → videos/
// 4. assemble-audio     — concatenate ElevenLabs MP3s per shot from assets/.../audio/
// 5. generate-music     — Venice stable-audio-3 (optional, flag-gated)
// 6. assemble-episode   — FFmpeg concat + mix → final episode MP4
```

Key: checkpoint/resume follows the same `checkpoint.json` pattern as `ingest.ts`.

### Supporting utilities

- `scripts/utils/venice-client.ts` — HTTP client for Venice API (auth, retry, rate limiting, balance monitoring)
- `scripts/utils/shot-planner.ts` — Groups bubbles from `bubbles.json` into shot descriptors
- `scripts/utils/character-references.ts` — Reads from `data/character-registry.json`, generates seedream images, manages provenance
- `scripts/utils/seedance-preflight.ts` — Validates provenance.json before video queue submission
- `assets/episodes/[book]/` — Output directory (separate from `assets/comics/` pipeline)

---

## 7. Environment Variables to Add

Following the existing `.env` pattern and `src/env.mjs` schema:

```bash
# Venice
VENICE_API_KEY=your_venice_api_key

# Optional controls
VENICE_VIDEO_MODEL=seedance-2.0        # or kling-3.0
VENICE_IMAGE_MODEL=seedream-v5-lite
VENICE_ASPECT_RATIO=16:9
VENICE_MAX_SHOT_DURATION=30            # seconds
VENICE_GENERATE_MUSIC=true
```

---

## 8. Key Technical Constraints to Keep in Mind

1. **Seedance face-source validation** is strict. Any face in a Seedance input image must come from `seedream-v5-lite`. The comic page art will not pass this check — it needs to be either avoided (use Kling for multi-character shots) or laundered through `seedream-v5-lite-edit`.

2. **Duration snapping.** Venice models only support specific duration values (e.g., 2s, 4s, 6s, 8s, 10s). Audio-derived durations from `audio-timestamps.json` must be snapped to the nearest supported value with appropriate padding.

3. **Async video generation.** The `/video/queue` → `/video/retrieve` pattern means we should run shot generation in parallel batches (respect rate limits: ~20 img requests/min, queue jobs don't count the same way).

4. **Provenance tracking.** Every generated image needs a `.provenance.json` sidecar so we know if a face is seedream-safe before queuing Seedance jobs.

5. **Cost monitoring.** Watch `x-venice-balance-usd` response header. A 26-page issue with ~15 shots could cost $15–50 in video generation at current rates. Budget per episode run.

6. **We keep ElevenLabs audio.** The existing IVC voice clones (sourced from the actors' original performances) are far higher quality than Venice TTS and already generated. Audio lives in `assets/comics/[book]/issue-[n]/audio/`.

7. **Bubble sort order matters.** `bubbles.json` is already sorted in reading order by `sort-bubbles-gemini`. Use this order for both shot grouping and audio concatenation — do not re-sort.

8. **Guard assets hook.** The project has a `.claude/hooks/guard-assets.sh` hook. The episode output goes in `assets/episodes/` (separate tree) so it won't conflict with the guarded `assets/comics/` source assets.

---

## 9. Phased Rollout Recommendation

| Phase | Work | Cost | Output |
|---|---|---|---|
| **Phase 0 — Proof of Concept** | Option A: Ken Burns on existing WebP pages (`pages-webp/`) + ElevenLabs audio + FFmpeg assembly | Near $0 | Motion comic MP4 per issue |
| **Phase 1 — Character References** | Generate seedream reference images for all cast characters using registry `voiceDescription` fields | ~$2–5 | Per-character reference library in `assets/episodes/[book]/characters/` |
| **Phase 2 — Cinematic Storyboard** | Generate AI panels per shot using references | ~$5–15/issue | Storyboard image set in `panels/` |
| **Phase 3 — Video Generation** | Convert panels to video clips via Seedance/Kling | ~$15–50/issue | Shot video library in `videos/` |
| **Phase 4 — Music + Polish** | Venice music generation + FFmpeg final assembly with mixing | ~$1–5/issue | Final `episode-001.mp4` |

**Total estimated cost for one full cinematic episode:** $25–70.

---

## 10. Open Questions

1. **Scene boundaries.** How do we decide where scenes break within an issue? Page transitions are obvious, but mid-page scene changes (location shifts) need either Gemini analysis or manual tagging in `bubbles.json`.

2. **Aesthetic definition.** What visual style prompt defines the "TMNT/MMPR" aesthetic for Venice? This needs to be locked once (like the harness's `set-aesthetic` command) so all generated images are visually coherent. Likely stored in a per-book `series.json` in `assets/episodes/[book]/`.

3. **Panel vs. full-page shots.** Do we generate one shot per page (matching the page count), or do we detect individual panels and generate one shot per panel? The latter is more cinematic but requires panel boundary detection (Roboflow or Gemini).

4. **Character description prompts.** The `voiceDescription` in the character registry describes the *voice*, not the visual appearance. We'll need to either (a) write visual descriptions per character manually, or (b) auto-generate them by sending the character's comic page panels through Gemini with a visual description prompt.

5. **Where do episodes live (public)?** The current public asset structure is `public/comics/[book]/[issue]/`. Episodes would likely go in `public/episodes/[book]/[issue]/episode.mp4` or be served from S3/Vercel Blob (which is already a noted prerequisite for Review UI Phase B — these needs overlap).

6. **Web player.** Does the Next.js app need a new route/component for episode playback (`/episode/[bookId]/[issueId]`), or is a downloaded MP4 sufficient for the MVP? A simple `<video>` element with episode link on the issue page could be a fast first step.

7. **`generate-episode` is intentionally a separate command from `pnpm ingest`.** Episode generation is a deliberate production step that should only run after the full review process is complete (Review UI corrections applied, audio verified, etc.). Folding it into `ingest` — even behind a flag — would blur that boundary. The two pipelines are distinct: `ingest` prepares a comic for the reader; `generate-episode` turns a finished, reviewed issue into a video.
