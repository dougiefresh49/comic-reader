# MP4 Export (sketch)

## Status: `pending` — last priority
## Goal: bake the live motion-comic experience into a shareable MP4
## Cost: $0 (headless Chromium + ffmpeg, all local)

---

## Approach

Two-stage:

1. **Capture:** spin up Playwright + Chromium, navigate to a special render URL like `/episode-render/<book>/<issue>?audioSpeed=1.2&autoplay=true`, screen-record the page at the panel-view auto-play sequence end-to-end.
2. **Mux:** ffmpeg combines the captured WebM video stream with the layered audio tracks (dialogue mix from existing audio, music + sfx + ambience) into a final `episode.mp4`.

The render URL is a stripped-down version of the live reader: full-screen, no HUD, auto-play locked on, deterministic timing (no real-time clock — uses `requestAnimationFrame` + scripted progression).

---

## Why not a pure FFmpeg approach

FFmpeg-only solutions (composite the page image + Ken Burns + audio) work for the existing motion-comic MVP but can't render canvas particle effects, CSS animations, or any of the v1 effect library. Headless Chromium gives us pixel-perfect parity with the live reader for free.

Trade-off: rendering is slow (1× real-time minimum). For a 14-min issue, ~14 min of capture. Acceptable for an offline export.

---

## Open questions for later

- Resolution: 1080p enough? 1440p costs more disk + time.
- Frame rate: 30 fps probably plenty for comic motion; 60 if we observe choppiness.
- Audio mixing: render layers separately and mix in ffmpeg, or capture mixed audio from Chromium?
- Subtitle track: bake VTT from `audio-timestamps.json` so platforms like Plex / Apple TV can show captions.

Defer all of this until specs 01–04 ship and we can actually open the live reader to validate before exporting.
