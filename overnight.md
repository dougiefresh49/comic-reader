# Overnight notes — 2026-04-29

Working through the list while user sleeps. This file is the running log.

## Status

| Task | State | PR |
|---|---|---|
| describe-panels (issue 1) | ✅ done | n/a — was already populated, 98 panels with effect+audio tags |
| Settings: volume + playback speed | ✅ shipped | #12 |
| Bug fix: panel-view layout collapse + RLS + camera-demo leak | ✅ shipped | #12 |
| Admin audio-library swap modal | ✅ verified | smoke-tested, no PR needed |
| Panel review UI | ✅ verified | smoke-tested, no PR needed |
| MP4 export | in-progress | next |
| Offline reading | pending | |

## Bugs found + fixed (all in PR #12)

1. **Reader layout collapsed to 0×0** — pre-existing layout bug. The flex centering wrapper used `max-h-full max-w-full` (caps, not setters), so PanelViewFrame's `aspect-[2/3] w-full` couldn't compute. Changed to `h-full w-full`. Page image now renders.
2. **Panels table RLS missing SELECT policy** — bubbles had `public read`, panels did not. With RLS enabled, anon key returned `[]` and the "Panel View" button never appeared. Added matching policy via `apply_migration` + checked in `supabase/migrations/20260429_panels_public_read.sql`.
3. **Camera-demo cyan boxes leaked into live reader** — the runtime EFFECTS map included the preview-only `CameraPushIn*Demo` components. Panels tagged `camera_pull_back` showed a "pull back" label over the page. Split into `EFFECTS` (runtime, no demos) + `EFFECTS_PREVIEW` (gallery with demos). Camera transforms still apply at runtime via PanelViewFrame's CSS class layer.

## Decisions log

- **Camera effects in registry**: kept the PreviewEffect adapter pattern instead of inlining the camera animations into the gallery. Lets us extend with more preview-only demos later without polluting runtime.
- **Volume defaults**: matched spec 04 exactly (1.0 / 0.20 / 0.5 / 0.25 for dialogue/music/sfx/ambience).
- **Playback rate range**: 0.75x → 2.0x. Safari preserves pitch up through ~1.5x.

## Verified working in live reader

- `/book/tmnt-mmpr-iii/issue-1/3` panel-view auto-play
- Panel 3 renders `impact_lines_radial` bursting from center
- Panels 1–6 sequence through with their effect tags
- No console errors / warnings

## Admin flow smoke tests — all passing

- `/admin/audio-library` — 27 tags rendered (9 ambience / 10 sfx / 8 music). Each has a player + Swap default + + Variant button.
- "+ Variant" modal on `sword_clang` — opens correctly with Variant name input, three tabs (Freesound / Generate / Upload), Freesound query prefilled.
- `/admin/tmnt-mmpr-iii/issue-1/review/panels` — 6 panels on page 3 render with color-coded outlines. Sidebar shows per-panel cards: cinematic description, effect tag chips, ambience/sfx/music_mood, isNewScene toggle, Apply.
- Bubble dots on the page image color-matched to their assigned panel.

No variants exist yet so the chip ▾ variant buttons aren't testable visually, but the underlying logic is wired (PR #10).

## Open for next session
