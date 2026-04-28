# Motion Comic Plus

## Status: `pending` — replaces the cinematic episode-generation direction
## Goal: a reading experience that's funner than a static comic and faithful to the book medium
## Budget target: $0 baseline, ~$5 lifetime cap on AI-generated audio (cached forever)

---

## Why this exists

The cinematic-video direction (Phase 3 image-gen + Phase 4 video-gen via Venice) was costed at $95–$380 per issue. That's incompatible with both the project budget and the actual product goal: **make reading fun for kids**, while preserving the comic-book feel.

A six-year-old reading test surfaced two real complaints:
1. Audio felt slow and stilted for action scenes
2. The static page lacks motion that AAA cinemas / Saturday-morning cartoons have trained kids to expect

Motion Comic Plus solves both without leaving the comic format:

- **Panel-by-panel swipe reader** (Kindle parity) for focused reading
- **Subtle motion effects per panel** (energy ripples, smoke, speed lines, camera push) driven by Gemini-tagged effect categories
- **Background music + sound effects** layered with the existing dialogue audio
- **Audio playback speed control** so action scenes can run at 1.2–1.4x

All of it stays in the browser as a live reader; an optional headless-Chromium → MP4 export ships an episode video for sharing.

---

## What stays, what changes

### Stays
- The current ingestion pipeline (Roboflow bubbles, Gemini OCR, ElevenLabs voices) is the foundation
- Bubble-tap-to-play with karaoke highlights remains the primary interaction
- Phase 1 (character setup) and Phase 0 (motion-comic MVP) are complete; the MVP becomes the fallback render mode
- Phase 2 shot-planner code is **not deleted** — it's repurposed for the optional "Hero Shot Cinematic" mode (see below)

### Changes
- `specs/features/episode-generation/04-storyboard.md` and `05-video-clips.md` are **superseded**. They stay on disk for historical context but should not drive new work.
- `specs/features/episode-generation/03-shot-planning.md` becomes a feeder for **Hero Shot Cinematic** (opt-in), not the default path.
- New default render path: `motion-comic-plus`, which uses panel rects + effect tags + audio layers.

### Optional: Hero Shot Cinematic
A `--hero` flag on individual shots in `shot-plan.json` opts that one shot into Venice video generation. Capped at $5/issue via `/video/quote` preflight. This is for the rare moment that genuinely benefits from cinematic motion (a hero reveal, a climactic blow). Default: **off**.

---

## Cost picture

| Component | Source | Cost |
|---|---|---|
| Panel direction (Gemini Vision) | `GEMINI_MEDIUM`, ~24 calls/issue | ~$0.10/issue |
| Effect library | One-time build, then free | $0 |
| Panel-reader UI | One-time build, then free | $0 |
| Background music | Freesound/Pixabay first, ElevenLabs Music gen for gaps | $0–$0.50/issue, cached |
| Sound effects | Freesound first, ElevenLabs SFX gen for gaps | $0–$0.30/issue, cached |
| Audio playback speed | ffmpeg `atempo` filter | $0 |
| MP4 export (optional) | headless Chromium + FFmpeg, screen-record the live reader | $0 |
| Hero shot cinematic (opt-in only) | Venice seedance-2.0 | $0–$5/issue, capped |

**Realistic lifetime AI-audio spend across all books: <$10**, assuming 50 unique SFX and 10 scene moods cached from one generation each. Most books won't add new entries to the cache.

---

## Spec index

| Spec | What it covers | Implement first? |
|---|---|---|
| [01-panel-direction.md](./01-panel-direction.md) | Gemini Vision returns panel rects + effect tags + audio tags. New schema. | ✅ Yes — unblocks everything else |
| [02-panel-reader-ui.md](./02-panel-reader-ui.md) | Kindle-style double-tap-to-enter, swipe-between-panels reader | ✅ Yes — visible UX win |
| [03-effect-library.md](./03-effect-library.md) | The ~15–20 reusable React/CSS/canvas motion effects that Gemini tags map to | After 01 |
| [04-audio-layer.md](./04-audio-layer.md) | Music + SFX sourcing strategy, caching, ElevenLabs/Venice/free-libraries fallback | After 03 |
| [05-mp4-export.md](./05-mp4-export.md) (sketch) | Headless Chromium screen-record → MP4 for shareable episodes | Last, optional |

---

## Status tracker

| Step | Status |
|---|---|
| Spec written | ✅ |
| Schema for `panel-direction.json` defined | ✅ (in 01-panel-direction.md) |
| Migrate plan-shots to use stored gemini-context | ⏳ |
| Build effect library v1 | ⏳ |
| Wire panel-direction → reader UI | ⏳ |
| Audio layer (SFX library + caching) | ⏳ |
| MP4 export | ⏳ (optional) |

---

## Follow-ups for the user

- **Onomatopoeia bubble detection.** Was removed from Roboflow (rapid model couldn't handle multi-class well at the time). If we want SFX bubbles like "BOOM"/"KRAASH" to trigger SFX layer cues, we need to re-add it to detection. The current model supports hand-tweaking and likely handles multi-class better; opening this as a follow-up rather than a blocker because we can also rely on Gemini's bubble type classification (already returns `SFX`) for those that fall inside a detected bubble.
