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
| Review UI — Phase A (annotation) | `pending` | [review-ui-phase-a.md](review-ui-phase-a.md) | Desktop sidebar editor — edit bubbles, adjust bounds, add/delete, export fixes.json |
| Review UI — Phase B (live regen) | `blocked` | [review-ui-phase-b.md](review-ui-phase-b.md) | In-browser re-run Gemini / re-generate audio. Needs storage migration first. |

## Pipeline & Ingestion

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Pipeline orchestrator with checkpoints | `done` | — | `scripts/ingest.ts` — Phase 2 |
| Automated image ingestion (Stagehand) | `done` | — | `scripts/scrape-pages.ts` — Phase 3 |
| Voice clip sourcing assistant | `done` | — | `scripts/find-voice-sources.ts` — Phase 4, uses GEMINI_HIGH |
| Global character registry | `done` | [character-registry.md](character-registry.md) | `data/character-registry.json` + `scripts/manage-registry.ts`. Migrated 29 characters from tmnt-mmpr-iii. |

## Infrastructure

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Asset storage migration (S3 / Supabase / Vercel Blob) | `pending` | — | Currently `public/` on Vercel — won't scale. Prerequisite for Review UI Phase B. |
| Auth (Clerk or Supabase) | `pending` | — | Noted as known need, not yet specced |

## Future / Ideas

| Idea | Notes |
|------|-------|
| Sound effects for onomatopoeia | BOOM, CRASH etc. trigger actual SFX clips |
| Background music | Ambient score per page/scene |
| Video generation | Use panels + audio as script to generate animated episode |
| Roboflow model retraining | Model has improved since initial setup — may reduce need for manual bounds corrections |
