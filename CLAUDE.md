# Comic Reader

Personal "Audible + Kindle for comics" app. Kids learning to read get an interactive comic viewer where tapping a speech bubble plays the character's voice and highlights words in sync (karaoke-style). Not for sale — family use only.

Currently live with 2 TMNT x MMPR issues. Goal is to make adding new books fast enough to do regularly.

---

## Tech Stack

- **Frontend**: Next.js 15 App Router, React 19, Tailwind CSS
- **Bubble detection**: Roboflow rapid model (bounding boxes)
- **OCR + Context**: Google Gemini (`@google/genai`)
- **Voice**: ElevenLabs (PVC for main characters, Voice Design for minor/auto characters)
- **Image processing**: `sharp` (JPEG → WebP)
- **Downloads**: `youtube-dl-exec`
- **Deployed**: Vercel (known issue: images in `public/` will need S3/Blob migration)

---

## Pipeline Flow

Each book+issue goes through these steps in order. Run via `pnpm ingest -- --book <name> --issue <n>` (after Phase 2).

| Step | Script | What it does |
|------|--------|-------------|
| 1 | validate-inputs | Check assets dir + pages exist |
| 2 | generate-pages-metadata | Extract page dimensions → `pages.json` |
| 3 | convert-pages-to-webp | JPEG pages → WebP → `pages-webp/` |
| 4 | get-context | Roboflow bounding boxes + Gemini OCR + speaker/emotion context → `bubbles.json` |
| 5 | sort-bubbles-gemini | AI reorders bubbles for correct reading order |
| 6 | add-bubble-styles | Calculate % coordinates for responsive positioning |
| 7 | generate-character-voice-descriptions | Gemini consolidates voice descriptions per character |
| 8 | clean-voice-descriptions | Normalize character names via alias-map → `source-material.json` |
| 9 | find-voice-sources | *(Phase 4)* Gemini researches media appearances → user picks voice |
| 10 | generate-voice-models | ElevenLabs creates voice models from clips → `castlist.json` |
| 11 | generate-audio | ElevenLabs TTS for every bubble → `audio/` + `audio-timestamps.json` |
| 12 | copy-to-public | Stage WebP + audio → `public/comics/` for Next.js serving |
| 13 | generate-manifest | Final `manifest.json` + `src/data/manifest.ts` |

**Manual scripts** (run as needed, not part of main pipeline):
- `repair-cues` — fix ElevenLabs textWithCues formatting after bulk generation
- `backfill-context` — add missing aiReasoning fields to existing bubbles.json
- `regenerate-timestamps` — re-fetch timestamps without re-generating audio
- `apply-fixes` — apply corrections from the web review interface

---

## Gemini Model Tiers

After Phase 1, all model strings live in `scripts/utils/models.ts`.

| Export | Model | Use when |
|--------|-------|---------|
| `GEMINI_HIGH` | `gemini-3.1-pro-preview` | Page-level context: speaker ID, emotion, narrative context — needs reasoning |
| `GEMINI_MEDIUM` | `gemini-3-flash-preview` | Vision tasks: OCR, reading order sorting, voice description consolidation |
| `GEMINI_FAST` | `gemini-3.1-flash-lite-preview` | Rule-based tasks: cue formatting fixes, simple validation — no reasoning needed |

Never hardcode model strings inline. Always import from `scripts/utils/models.ts`.

---

## Directory Layout

```
assets/comics/<book>/issue-<n>/
  pages/                    ← INPUT: source JPEGs (not in public)
  pages-webp/               ← intermediate WebP before copy-to-public
  data/
    bubbles.json            ← speech bubble data (coordinates, speaker, text, audio)
    pages.json              ← page dimensions
    character-voice-descriptions.json
    voice-sourcing-suggestions.json  ← Phase 4 output
    castlist.json           ← character → ElevenLabs voice ID
    source-material.json    ← character → voice clip source
    audio-timestamps.json   ← ElevenLabs word alignment data
    gemini-context/         ← per-page Gemini analysis cache
  audio/                    ← generated .mp3 files
  checkpoint.json           ← pipeline progress (gitignored)

public/comics/<book>/issue-<n>/
  pages/                    ← OUTPUT: WebP images served by Next.js
  audio/                    ← OUTPUT: MP3 files served by Next.js
  bubbles.json
  manifest.json

data/                       ← global data (alias-map, source-material overrides)
scripts/                    ← all processing scripts
scripts/utils/              ← shared utilities (Gemini, Roboflow, OCR, image math)
src/                        ← Next.js app
```

---

## Key Environment Variables

Set in `.env` (used by `--env-file=.env` flag in all script commands):

```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ROBOFLOW_API_KEY=
NEXT_PUBLIC_BASE_URL=
```

For Claude Code personal settings: copy `.claude/settings.local.json.example` → `.claude/settings.local.json` and fill in keys.

---

## Common Commands

```bash
# Add a new comic (after Phase 2 + 3)
pnpm scrape-pages -- --url <url> --book <name> --issue <n>
pnpm ingest -- --book <name> --issue <n>

# Resume a stalled pipeline run
pnpm ingest -- --book <name> --issue <n>  # auto-resumes from checkpoint

# Force restart from a specific step
pnpm ingest -- --book <name> --issue <n> --from-step generate-audio

# Fix specific bubbles after human review
pnpm apply-fixes  # reads fixes.json exported from the web review UI

# Dev server
pnpm dev

# Type check
pnpm typecheck
```

---

## Roadmap

The end-state vision and phased plan tying every workstream together
lives in **[specs/roadmap/00-overview.md](specs/roadmap/00-overview.md)**.
Open this first if you want context on where things are going. Sub-docs:

| File | What it covers |
|---|---|
| [00-overview.md](specs/roadmap/00-overview.md) | North-star, current state, end-state diagram, phased plan |
| [01-data-model.md](specs/roadmap/01-data-model.md) | Canonical DB schema (existing + planned) |
| [02-ingest-pipeline.md](specs/roadmap/02-ingest-pipeline.md) | End-state ingest with new steps (wiki, segmentation, lookahead, music scenes) |
| [03-reader-experience.md](specs/roadmap/03-reader-experience.md) | Layered render, transitions, chrome, captions |
| [04-voice-rotation.md](specs/roadmap/04-voice-rotation.md) | IVC archive/restore + fidelity test recipe |
| [05-admin-tooling.md](specs/roadmap/05-admin-tooling.md) | Admin UI gaps and additions per workstream |

## Phase Plan Index

Improvements are broken into phases. Run each in a new Claude session with `/clear` between phases.

| Phase | Spec | Status |
|-------|------|--------|
| 0 | [specs/phases/phase-0-hooks.md](specs/phases/phase-0-hooks.md) | ✅ Done |
| 1 | [specs/phases/phase-1-gemini-models.md](specs/phases/phase-1-gemini-models.md) | ✅ Done |
| 2 | [specs/phases/phase-2-pipeline.md](specs/phases/phase-2-pipeline.md) | ✅ Done |
| 3 | [specs/phases/phase-3-image-ingestion.md](specs/phases/phase-3-image-ingestion.md) | ✅ Done (Stagehand + GEMINI_MEDIUM) |
| 4 | [specs/phases/phase-4-voice-sourcing.md](specs/phases/phase-4-voice-sourcing.md) | ✅ Done |
| 5 | [specs/phases/phase-5-reader-refactor.md](specs/phases/phase-5-reader-refactor.md) | ✅ Done |

---

## Feature Tracker

New features and backlog items live in `specs/features/`. Check here before starting any new feature work.

**[specs/features/features.md](specs/features/features.md)** — the canonical tracker. Statuses: `pending` · `in-progress` · `done` · `blocked`. Update this file when work starts or completes.

Each feature has its own spec file in `specs/features/`:

| Feature | Status | Spec |
|---------|--------|------|
| Global character registry | `pending` | [specs/features/character-registry.md](specs/features/character-registry.md) |
| Review UI — annotation editor | `pending` | [specs/features/review-ui-phase-a.md](specs/features/review-ui-phase-a.md) |
| Review UI — live regeneration | `blocked` (needs storage migration) | [specs/features/review-ui-phase-b.md](specs/features/review-ui-phase-b.md) |

When implementing a feature: read its spec file, implement only what's in that spec, then update the status in `features.md`.

---

## Known Issues / Technical Debt

- `src/components/ZenComicReader.tsx` refactored to 223 lines (Phase 5 complete) — logic lives in `src/hooks/`
- `public/` folder image storage won't scale on Vercel (Phase 2 `STORAGE_MODE=s3` flag exists but isn't wired up)
- Some one-off scripts in `scripts/` are patches for gaps in the pipeline (backfill-context, repair-cues, regenerate-timestamps) — these become less necessary once Phase 2 pipeline runs cleanly end-to-end
- Roboflow model may benefit from re-training (has improved since initial setup)
