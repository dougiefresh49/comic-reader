# Overnight notes — 2026-04-29

## Final status

| Task | Status | PR |
|---|---|---|
| describe-panels for issue 1 | ✅ already done | n/a — 98 panels populated with effect/audio tags (must've run earlier) |
| Settings volume + playback speed | ✅ shipped | [#12](https://github.com/dougiefresh49/comic-reader/pull/12) |
| Reader bug fixes (layout, RLS, demo leak) | ✅ shipped | [#12](https://github.com/dougiefresh49/comic-reader/pull/12) |
| Test particle effects in reader | ✅ verified (after fixing 3 bugs) | rolled into #12 |
| Test admin audio swap flow | ✅ verified | smoke-tested, no PR needed |
| Test admin panel review flow | ✅ verified | smoke-tested, no PR needed |
| Offline reading | ✅ shipped | [#13](https://github.com/dougiefresh49/comic-reader/pull/13) |
| MP4 export | ⚠ partial | [#14](https://github.com/dougiefresh49/comic-reader/pull/14) — silent video works, audio muxing TODO |

**Recommended merge order**: #12 → #13 → #14 (each based on its predecessor, will rebase cleanly).

## Bugs found + fixed (PR #12)

These were all pre-existing but newly-surfaced when I tried to use the panel-view auto-play end-to-end:

1. **Reader layout collapsed to 0×0**. The flex centering wrapper used `max-h-full max-w-full` (caps without setters). With PanelViewFrame's `aspect-[2/3] w-full` inside, the cascade had no concrete dimensions to compute from. Switched the wrapper to `h-full w-full`. Page image now renders.

2. **Panels table missing RLS SELECT policy**. RLS was enabled on `panels` but no policy existed → anon key returned `[]` and the "Panel View" button never appeared. Added `public read` matching the bubbles policy. Migration checked in at `supabase/migrations/20260429_panels_public_read.sql`. Already applied to prod via Supabase MCP.

3. **Camera-demo cyan boxes leaked into the live reader**. The runtime EFFECTS map registered the preview-only `CameraPushIn*Demo` components, so panels with `camera_pull_back` etc. tags rendered a "pull back" label box on top of the page art. Split into `EFFECTS` (runtime, no demos) + `EFFECTS_PREVIEW` (gallery with demos). Camera transforms still apply at runtime via PanelViewFrame's CSS class layer.

## What ships in #12 (settings)

- **Reading speed slider** 0.75x → 2x with preset chips (0.75 / 1.0 / 1.2 / 1.5 / 2.0). Plumbed into `useAudioPlayback`'s `audio.playbackRate`.
- **Per-layer volume**: dialogue / music / sfx / ambience sliders with ON/MUTE chip + reset. Spec-default volumes: 1.0 / 0.20 / 0.5 / 0.25.
- All settings persist to localStorage. Mid-bubble adjustments take effect immediately.

## What ships in #13 (offline reading)

- **"Download for offline" button** per issue on the book page.
- Service worker at `public/sw.js` — cache-first for `comic-pages` + `comic-audio` URLs.
- `<ServiceWorkerRegistrar>` mounted at root layout so the SW is active on every page (intercepts cold loads, not just after a download).
- `getIssueOfflineUrls` server helper builds the prefetch list: page WebPs + every bubble's dialogue audio + every audio-library file referenced by the issue's panel tags (variant-aware via `parseTag`).
- Verified live: clicking download on issue 1 cached 211 files; button transitions Idle → "Downloading… X%" → "✓ Available offline".

## What ships in #14 (MP4 export, partial)

- **`/episode-render/<book>/<issue>?page=<n>` route** — stripped-down reader: no HUD, autoplay locked, deterministic timing. Sets `window.__episodeRenderDone = true` after the last panel.
- **`pnpm export-episode-mp4 -- --book ... --issue ... [--page N] [--upload]`** — Playwright + ffmpeg-static. Records WebM → transcodes to MP4. Outputs to `out/episodes/<book>/<issue>/`.
- **Status**: video stream works (verified visually). **Audio is missing from the export** — Chromium's audio doesn't make it into the Playwright WebM. The fix is to mix audio in via ffmpeg per-panel from source files (bubble mp3s + library tracks aligned to panel start times). Roughly half a day of work.

## Decisions made without input

- **Render route is unauthenticated**. It needs to be reachable from a Playwright browser without basic-auth bouncing. Easiest: leave open, since it's not linked from anywhere and exposes no admin data. If you'd rather lock it, add a `?token=` query param + middleware exemption.
- **Camera-effect demos in preview-only registry**. Cleaner than monkey-patching the runtime registry. Future preview-only effects can register the same way.
- **Volume defaults match spec 04 exactly**. Easy to tweak per-user via the slider; no point in re-deriving the balance.
- **Service worker reuses `comic-reader-v1` cache** without versioning. Bumping the SW version invalidates everything. We'll cross that bridge if the schema changes.
- **MP4 output goes into the existing `comic-audio` bucket** with content-type `video/mp4`. Cleaner would be a dedicated `comic-videos` bucket but that requires a Supabase config change. Easy follow-up.

## Anything you should know first thing

- **Apply prod migration** — already done remotely via the Supabase MCP `apply_migration`. The `.sql` file is in the repo too. Just FYI in case you wonder where it came from.
- **PR base chain matters**: #14 is based on #12. If you merge #12 first, #14 will auto-rebase cleanly. If you want to squash-merge in a different order, GitHub will handle it but watch the diff for the merge conflict in `package.json` (just version bumps).
- **No work touching ingest pipeline tonight** — only consumer code + admin UI. The pipeline scripts under `scripts/` are unchanged.
