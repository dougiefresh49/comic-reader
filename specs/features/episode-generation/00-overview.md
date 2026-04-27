# Episode Generation — Overview

## Status: `pending`

Turn a finished, reviewed comic issue into a watchable video episode using existing pipeline assets (structured dialogue, ElevenLabs audio, character registry) and the Venice.ai API for image and video generation.

---

## Design Principles

1. **Human-gated phases.** The pipeline pauses for review after each major phase. Nothing expensive runs until you approve the previous step's output.
2. **Checkpoint/resume.** Every step is checkpointed. A failed or cancelled run resumes exactly where it left off — no re-spending on completed shots.
3. **No AI calls at review time.** Review is always visual + human. The pipeline generates review artifacts (HTML pages, folder opens) — not AI summaries.
4. **ElevenLabs audio is sacred.** The IVC voice clones stay. Venice TTS is never used.
5. **Separate from `pnpm ingest`.** Episode generation is a deliberate production step on a *finished, reviewed* issue. It never runs automatically as part of ingest.

---

## Two Output Modes

### Motion Comic (fast, free)
Ken Burns animation on the existing WebP comic pages, layered with ElevenLabs audio. No Venice calls. Produces a watchable episode in minutes.

```
pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1
```

### Cinematic Episode (full Venice pipeline)
AI-generated scene panels → video clips → assembled episode. Uses Venice image and video models. Full character-consistent production.

```
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1
```

These are **separate commands**, not modes of the same script. Motion comic is free and fast; generate-episode is deliberate and billed.

---

## Phase Table

| Phase | Spec | Command | Status | Approx Cost |
|-------|------|---------|--------|-------------|
| 0 — Motion Comic MVP | [01-motion-comic-mvp.md](01-motion-comic-mvp.md) | `pnpm motion-comic` | `pending` | ~$0 |
| 1 — Character Setup | [02-character-setup.md](02-character-setup.md) | `pnpm generate-episode -- --only-step lock-characters` | `pending` | ~$2–5 (one-time per book) |
| 2 — Shot Planning | [03-shot-planning.md](03-shot-planning.md) | `pnpm generate-episode -- --only-step plan-shots` | `pending` | ~$0.10–0.30/issue (Gemini Vision) |
| 3 — Storyboard | [04-storyboard.md](04-storyboard.md) | `pnpm generate-episode -- --only-step storyboard` | `pending` | ~$5–15/issue |
| 4 — Video Clips | [05-video-clips.md](05-video-clips.md) | `pnpm generate-episode -- --only-step generate-videos` | `pending` | ~$15–50/issue |
| 5 — Assembly | [06-assembly.md](06-assembly.md) | `pnpm generate-episode -- --only-step assemble-episode` | `pending` | ~$1–5/issue (music optional) |

**Total estimated cost for one full cinematic episode: $25–75.**

---

## Model Decision Matrix

All model ID strings are defined as named exports in `scripts/utils/models.ts`. Never hardcode inline.

| Shot type | Constant | Model ID | Reason |
|-----------|----------|----------|--------|
| Character video (faces) | `VENICE_VIDEO_CHARACTER` | `kling-o3-pro-reference-to-video` | R2V: accepts `reference_image_urls` for character identity. 3–15s. |
| Atmosphere video (no faces) | `VENICE_VIDEO_ATMOSPHERE` | `seedance-2-0-image-to-video` | Best motion for environments/establishing. 1080p. |
| Character reference images | `VENICE_IMAGE_CHAR_REF` | `seedream-v5-lite` | Text-to-image, `"2:3"` portrait. Phase 1. |
| Storyboard panels (all shots) | `VENICE_IMAGE_STORYBOARD` | `seedream-v5-lite` | Same model family → visual consistency with character refs. Phase 3. |
| Single-char shot conditioning | `VENICE_IMAGE_EDIT_CHAR` | `seedream-v5-lite-edit` | Edits reference.png into a scene. `/image/edit` endpoint. Phase 3. |
| Optional background music | — | ElevenLabs (preferred) or Venice | See Phase 5 assembly spec. |

**Model IDs confirmed from `docs/venice-ai/image-models.json` and `docs/venice-ai/video-models.json`.**

---

## Directory Structure

```
assets/episodes/
  <book>/
    series.json                    ← aesthetic lock (palette, style, lighting)
    characters/
      <name>/
        reference.png              ← seedream-v5-lite character reference image
        reference.provenance.json  ← model, timestamp, prompt used

    issue-<n>/
      episode-checkpoint.json      ← step progress (gitignored)
      shot-plan.json               ← Gemini Vision shot descriptors
      review-state.json            ← per-shot approve/reject state
      review-storyboard.html       ← generated review page for panels
      review-videos.html           ← generated review page for video clips
      panels/
        shot-001.png
        shot-001.provenance.json
        ...
      videos/
        shot-001.mp4
        ...
      audio/
        shot-001-dialogue.mp3      ← concatenated ElevenLabs clips for this shot
        ...
      assembled/
        episode-motion-comic.mp4   ← from pnpm motion-comic
        episode-001.mp4            ← from pnpm generate-episode
        episode-001-music.mp3      ← Venice background music (optional)

public/episodes/
  <book>/
    issue-<n>/
      episode-motion-comic.mp4     ← served by Next.js
      episode-001.mp4
```

---

## Environment Variables

Add to `.env`:

```bash
# Venice
VENICE_API_KEY=your_venice_api_key

# Optional overrides (defaults shown)
VENICE_IMAGE_MODEL=seedream-v5-lite
VENICE_ASPECT_RATIO=16:9
VENICE_MAX_VIDEO_DURATION=10        # seconds — snapped to nearest model-supported value
VENICE_GENERATE_MUSIC=false         # set to true to add background music
VENICE_MUSIC_PROMPT=                # override default music prompt for this book
```

---

## New Scripts

| Script | Purpose |
|--------|---------|
| `scripts/motion-comic.ts` | Phase 0 standalone Ken Burns pipeline |
| `scripts/generate-episode.ts` | Phase 1–5 orchestrator (mirrors ingest.ts) |
| `scripts/utils/venice-client.ts` | Venice API HTTP client (auth, retry, balance logging) |
| `scripts/utils/shot-planner.ts` | bubbles.json → shot descriptors |
| `scripts/utils/review-generator.ts` | Generates review HTML files |
| `scripts/utils/ffmpeg-runner.ts` | FFmpeg command wrappers |

---

## `generate-episode.ts` — CLI Interface

```bash
# Full pipeline (phases 1–5 in sequence, pausing for review at each gate)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1

# Resume from a specific step (skips completed steps)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --from-step storyboard

# Run only one step
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step plan-shots

# Dry run — plan shots and estimate cost without spending
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --dry-run

# Mark specific shots for regeneration, then re-run from storyboard
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --reject-shots 3,7,12 --from-step storyboard
```

**Step names** (for `--from-step` and `--only-step`):
- `setup-series`
- `lock-characters`
- `plan-shots`
- `storyboard`
- `generate-videos`
- `assemble-audio`
- `generate-music`
- `assemble-episode`

---

## Cost Monitoring

Every Venice API response includes `x-venice-balance-usd`. `venice-client.ts` logs this after every call:

```
   [Venice] balance: $12.43 remaining
```

Before any Venice spending phase (storyboard, video), the pipeline prints an estimated cost and prompts:

```
💰 Estimated cost for storyboard (23 shots × ~$0.05): ~$1.15
   Current balance: $12.43
   Proceed? [Y/n]
```

---

## Key Files to Read Before Implementing Any Phase

- `scripts/ingest.ts` — checkpoint/resume pattern to replicate
- `scripts/utils/models.ts` — Gemini model constants
- `assets/comics/tmnt-mmpr-iii/issue-1/bubbles.json` — actual bubbles.json format (Record<string, Bubble[]>)
- `data/character-registry.json` — registry structure with voiceDescription
- `scripts/types/registry.ts` — TypeScript types for registry
- `src/types/comic.ts` — Bubble type

---

## package.json Additions

```json
"motion-comic": "tsx --env-file=.env scripts/motion-comic.ts",
"generate-episode": "tsx --env-file=.env scripts/generate-episode.ts"
```
