# Features

Backlog and status tracker for planned features. Update status here when work starts or completes.

**Statuses:** `pending` · `in-progress` · `done` · `blocked`

---

## Reader

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Zen Reader layout (immersive, docked HUD) | `done` | — | Built in Phase 5. Hooks in `src/hooks/`, component at `src/components/ZenComicReader.tsx` |
| Karaoke word highlight | `done` | — | `useWordHighlight.ts` — ElevenLabs word alignment timestamps |
| Auto-play mode | `done` | — | `useAutoPlay.ts` |
| Pinch-to-zoom | `done` | — | `usePinchZoom.ts` |
| Page selector grid | `done` | — | Bottom control bar |

## Review & Corrections

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Review UI — Phase A (annotation) | `done` | [review-ui-phase-a.md](review-ui-phase-a.md) | Desktop sidebar editor — edit bubbles, adjust bounds, add/delete, export fixes.json |
| Review UI — Keyboard, Speaker UX & Sort | `done` | [review-ui-keyboard-and-sort.md](review-ui-keyboard-and-sort.md) | `a` to add, Tab bubble nav, speaker auto-focus, form tab order, drag-to-reorder, character list caching fix |
| Review UI — Phase B (live regen) | `blocked` | [review-ui-phase-b.md](review-ui-phase-b.md) | In-browser re-run Gemini / re-generate audio. Needs storage migration first. |

## Pipeline & Ingestion

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Pipeline orchestrator with checkpoints | `done` | — | `scripts/ingest.ts` — Phase 2 |
| Automated image ingestion (Stagehand) | `done` | — | `scripts/scrape-pages.ts` — Phase 3 |
| Voice clip sourcing assistant | `done` | — | `scripts/find-voice-sources.ts` — Phase 4, uses GEMINI_HIGH |
| Global character registry | `done` | [character-registry.md](character-registry.md) | `data/character-registry.json` + `scripts/manage-registry.ts`. Migrated 29 characters from tmnt-mmpr-iii. |
| Book-aware context | `done` | [book-aware-context.md](book-aware-context.md) | `book-config.json` (franchise context + wiki URLs) + `character-roster.json` (cross-page/issue name consistency) + character classification (named vs generic) to skip research for background characters. |
| Interactive alias review | `pending` | [interactive-alias-review.md](interactive-alias-review.md) | Step 8.5 — per-character guided menu [1] New / [2] Alias to existing list. Prunes stale characters against bubbles.json first. Needs UX update from free-text to guided menu. |
| Review speakers | `done` | [review-speakers.md](review-speakers.md) | Step 4.5 post-get-context — review/correct all speaker names in bubbles.json before any processing. [1] Accept / [2] Edit / [3] Choose from confirmed+registry list. Auto-accepts known registry characters. Fixes names at the source so alias-map stays clean. |

## Infrastructure

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Asset storage migration (S3 / Supabase / Vercel Blob) | `pending` | — | Currently `public/` on Vercel — won't scale. Prerequisite for Review UI Phase B. |
| Auth (Clerk or Supabase) | `pending` | — | Noted as known need, not yet specced |

## Episode Generation

Specs in `specs/features/episode-generation/`. Two output modes: motion comic (free, Ken Burns + existing audio) and full cinematic (Venice.ai image + video generation). See [00-overview.md](episode-generation/00-overview.md) for architecture, cost estimates, and CLI interface.

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Motion Comic MVP | `done` | [01-motion-comic-mvp.md](episode-generation/01-motion-comic-mvp.md) | `pnpm motion-comic` — Ken Burns + ElevenLabs audio + FFmpeg. No Venice. |
| Character Setup | `pending` | [02-character-setup.md](episode-generation/02-character-setup.md) | `visualDescription` registry field + seedream reference images + series.json aesthetic lock |
| Shot Planning | `pending` | [03-shot-planning.md](episode-generation/03-shot-planning.md) | Gemini Vision per page → shot-plan.json. Last free gate before Venice spend. |
| Storyboard | `pending` | [04-storyboard.md](episode-generation/04-storyboard.md) | Venice image generation per shot (seedream + flux-2-max-edit). ~$5–15/issue. |
| Video Clips | `pending` | [05-video-clips.md](episode-generation/05-video-clips.md) | Venice video queue per panel (kling-3.0 for faces, seedance-2.0 for atmosphere). ~$15–50/issue. |
| Assembly | `pending` | [06-assembly.md](episode-generation/06-assembly.md) | FFmpeg concat + ElevenLabs audio mix + optional Venice music. |
| Review System | `pending` | [review-system.md](episode-generation/review-system.md) | Human-gated review at each phase. Static HTML galleries + terminal prompts. No AI at review time. |

## Future / Ideas

| Idea | Notes |
|------|-------|
| Sound effects for onomatopoeia | BOOM, CRASH etc. trigger actual SFX clips |
| Roboflow model retraining | Model has improved since initial setup — may reduce need for manual bounds corrections |
| Episode web player | `/episode/[bookId]/[issueId]` route in Next.js app — after assembly pipeline ships |
