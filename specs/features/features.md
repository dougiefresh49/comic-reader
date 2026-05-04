# Features

Backlog and status tracker for planned features. Update status here when work starts or completes.

**Statuses:** `pending` · `in-progress` · `done` · `blocked`

> **Looking for the big picture?** See [`specs/roadmap/00-overview.md`](../roadmap/00-overview.md) — north-star, end-state diagrams, and phased plan that ties all the work below together.

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
| Review UI — Phase B (live regen) | `done` | [review-ui-phase-b.md](review-ui-phase-b.md) | Server actions in `src/server/actions/review/`. Re-run context (Gemini), regenerate cues, regenerate audio — all wired to BubbleSidebar buttons. Reads/writes Supabase Storage. |

## Pipeline & Ingestion

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Pipeline orchestrator with checkpoints | `done` | — | `scripts/ingest.ts` — Phase 2 |
| Automated image ingestion (Stagehand) | `done` | — | `scripts/scrape-pages.ts` — Phase 3 |
| Voice clip sourcing assistant | `done` | — | `scripts/find-voice-sources.ts` — Phase 4, uses GEMINI_HIGH |
| Global character registry | `done` | [character-registry.md](character-registry.md) | `data/character-registry.json` + `scripts/manage-registry.ts`. Migrated 29 characters from tmnt-mmpr-iii. |
| Book-aware context | `done` | [book-aware-context.md](book-aware-context.md) | `book-config.json` (franchise context + wiki URLs) + `character-roster.json` (cross-page/issue name consistency) + character classification (named vs generic) to skip research for background characters. |
| Interactive alias review | `pending` | [interactive-alias-review.md](interactive-alias-review.md) | Step 8.5 — per-character guided menu [1] New / [2] Alias to existing list. Prunes stale characters against bubbles.json first. Needs UX update from free-text to guided menu. |
| Review speakers (terminal) | `done` | [review-speakers.md](review-speakers.md) | Step 4.5 post-get-context — review/correct all speaker names in bubbles.json before any processing. [1] Accept / [2] Edit / [3] Choose from confirmed+registry list. Auto-accepts known registry characters. Fixes names at the source so alias-map stays clean. |
| Review speakers (browser UI) | `done` | [review-speakers-browser.md](review-speakers-browser.md) | Browser version of step 4.5. Pipeline pauses (exit 2), user reviews in `/admin/.../review/speakers`. Inline alias creation replaces step 8.5 for common case. PR #29. |
| Source page upload + admin dashboard | `done` | [upload-and-pipeline-trigger.md](upload-and-pipeline-trigger.md) | `/admin/new-issue` drag-and-drop upload to `comic-pages-raw` bucket. `/admin` dashboard shows pipeline status per issue with pause/resume links. |
| Casting browser UI | `done` | [casting-browser.md](casting-browser.md) | `/admin/characters/casting` — two-phase triage UI with wiki voice hints, on-demand Gemini research per character, Voice Design flow, paste voice ID, Complete Casting to unpause pipeline. |
| Voice clip splitting | `done` | [audio-splitting.md](audio-splitting.md) | `pnpm split-voice` — isolate target character voice from mixed audio using source separation + diarization + Gemini speaker ID. PR #31. |
| Book parts (multi-part series) | `done` | [book-parts.md](book-parts.md) | `book_parts` table for multi-part series (e.g., TMNT x MMPR Part I/II/III). Nullable `part_id` on issues. New columns on `books` for wiki/publisher/franchises. |
| Smart add flow | `in-progress` | [smart-add-flow.md](smart-add-flow.md) | AI-assisted book/issue discovery. Gemini + Google Search grounding finds wiki pages and reading sources. Two flows: "Add Book" (search + create) and "Add Issue" (auto-detect next + lookup source). Requires Book Parts migration. |

## Infrastructure

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Data hosting migration (Supabase DB + Storage) | `done` | [data-hosting/README.md](data-hosting/README.md) | Phases A–D complete: 5 Storage buckets, DB schema (14 tables), frontend reads from Supabase CDN, pipeline writes to Supabase. Unblocks Review UI Phase B. |
| Auth (Clerk or Supabase) | `pending` | — | Noted as known need, not yet specced |

## Episode Generation — PAUSED

> **Status: Paused as of 2026-05-02.** Does not fit the core goal (make reading fun) and generation costs (Venice image/video) were too high. Motion Comic MVP is done and usable; the cinematic pipeline beyond that is shelved indefinitely.

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Motion Comic MVP | `done` | [01-motion-comic-mvp.md](episode-generation/01-motion-comic-mvp.md) | `pnpm motion-comic` — Ken Burns + ElevenLabs audio + FFmpeg. No Venice. |
| Character Setup | `done` | [02-character-setup.md](episode-generation/02-character-setup.md) | `visualDescription` registry field + seedream reference images + series.json aesthetic lock |
| Shot Planning | `paused` | [03-shot-planning.md](episode-generation/03-shot-planning.md) | Paused — too expensive, out of scope. |
| Storyboard | `paused` | [04-storyboard.md](episode-generation/04-storyboard.md) | Paused — too expensive, out of scope. |
| Video Clips | `paused` | [05-video-clips.md](episode-generation/05-video-clips.md) | Paused — too expensive, out of scope. |
| Assembly | `paused` | [06-assembly.md](episode-generation/06-assembly.md) | Paused — too expensive, out of scope. |
| Review System | `paused` | [review-system.md](episode-generation/review-system.md) | Paused — too expensive, out of scope. |

## Motion Comic Plus — PAUSED

> **Status: Paused as of 2026-05-02.** Episode generation workstream is shelved (too expensive, out of scope for core reading experience).

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Panel Direction (Gemini panel rects + effect/audio tags) | `paused` | [motion-comic-plus/01-panel-direction.md](motion-comic-plus/01-panel-direction.md) | Paused with episode generation. |
| Panel Reader UI (Kindle-style) | `paused` | [motion-comic-plus/02-panel-reader-ui.md](motion-comic-plus/02-panel-reader-ui.md) | Paused with episode generation. |
| Effect Library | `paused` | [motion-comic-plus/03-effect-library.md](motion-comic-plus/03-effect-library.md) | Paused with episode generation. |
| Audio Layer | `paused` | [motion-comic-plus/04-audio-layer.md](motion-comic-plus/04-audio-layer.md) | Paused with episode generation. |
| MP4 Export | `paused` | [motion-comic-plus/05-mp4-export.md](motion-comic-plus/05-mp4-export.md) | Paused with episode generation. |
| Onomatopoeia bubble re-detection | `pending` | — | User task: re-add to Roboflow now that hand-tweak + multi-class detection are mature |

## From 2026-04-30 testing-session feedback

| Feature | Status | Spec | Notes |
|---------|--------|------|-------|
| Persist panel-view across page nav | `done` | — | `panelViewPreferred` in `useSettings`; reader auto-enters panel view on next page if last toggle was on. Audio not auto-resumed (browser autoplay policy). |
| Runtime panel reading-order sort | `done` | — | `src/lib/panel-reading-order.ts` row-band heuristic. `source === "manual"` panels keep their persisted order. |
| Music scenes (group panels by mood run) | `done` | [music-scenes.md](music-scenes.md) | `music_scenes` table, `consolidate-music-scenes` script, runtime `scene_id` continuity. PR #20. |
| SAM3 segmentation → particle layering | `done` | [segmentation-layering.md](segmentation-layering.md) | SVG clip-path layering (bg → effects → fg). `LayeredPanel.tsx`. Falls back when `foregroundPolygons` is null. PR #23. |
| Reader chrome redesign (Kindle-inspired) | `done` | [reader-chrome-redesign.md](reader-chrome-redesign.md) | Auto-hiding top bar, slim bottom bar, view sheet, single-tap chrome toggle. PR #21. |

## Future / Ideas

| Idea | Notes |
|------|-------|
| Roboflow model retraining | Model has improved since initial setup — may reduce need for manual bounds corrections |
| Episode web player | `/episode/[bookId]/[issueId]` route in Next.js app — after assembly pipeline ships |
| ~~Spring-curve panel transitions~~ | **Done** — rAF spring physics in `PanelView.transforms.ts`. PR #20. |
| Action-line position hint in effect tags | Cheap fix for effects placed in wrong corner; precursor to action-line bbox detection. See `segmentation-layering.md` §"Action lines". |
