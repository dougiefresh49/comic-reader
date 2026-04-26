# Phase 0 — Motion Comic MVP

## Status: `pending`
## Prerequisites: Finished issue in `assets/comics/<book>/issue-<n>/` (pages-webp/, audio/, bubbles.json)
## Cost: ~$0 (no Venice calls)

---

## Purpose

The fastest path to a watchable episode. Animates the existing WebP comic pages with a Ken Burns effect (slow zoom + subtle pan) and layers in the existing ElevenLabs character audio. No AI generation — purely FFmpeg + existing assets.

The motion comic is a standalone deliverable, not a stepping stone to the cinematic pipeline. It preserves the original comic art, which for TMNT/MMPR is often more recognizable and compelling for the target audience (kids) than AI-regenerated character faces.

---

## Command

```bash
pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1
pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1 --dry-run   # show page/duration plan only
```

---

## Output

```
assets/episodes/<book>/issue-<n>/assembled/episode-motion-comic.mp4
```

---

## Pipeline Steps

### Step 1 — Build page audio tracks

For each page (ordered by page number):

1. Read `assets/comics/<book>/<issue>/bubbles.json` — get all bubbles for this page key (`page-01.jpg`, etc.)
2. Bubbles are already in reading order (sort-bubbles-gemini ran during ingest)
3. For each bubble: locate audio file at `assets/comics/<book>/<issue>/audio/<bubble.id>.mp3`
4. Skip bubbles with `type === "SFX"` or `type === "BACKGROUND"` (no audio generated for these)
5. Concatenate bubble MP3s with 0.3s silence between each line using FFmpeg concat demuxer
6. Output: `assets/episodes/<book>/issue-<n>/audio/page-NN-dialogue.mp3`
7. Record total page audio duration (sum of clip durations + padding)

Pages with no dialogue bubbles get a minimum clip duration of 3 seconds.

### Step 2 — Generate per-page video clips

For each page:

1. Input: `assets/comics/<book>/<issue>/pages-webp/page-NN.webp`
2. Apply Ken Burns effect via FFmpeg `zoompan` filter:
   - Alternate between zoom-in and zoom-out across pages for visual variety
   - Slow zoom rate: `z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))'` (zooms from 1.5x → 1.0x)
   - Center pan: `x='iw/2-(iw/zoom/2)'`, `y='ih/2-(ih/zoom/2)'`
   - Duration: page audio duration + 0.5s tail
   - Frame rate: 24fps
3. Output: `assets/episodes/<book>/issue-<n>/panels/page-NN-video.mp4` (video only, no audio)

### Step 3 — Merge audio into page clips

For each page clip + dialogue track:

```bash
ffmpeg -i page-NN-video.mp4 -i page-NN-dialogue.mp3 \
  -c:v copy -c:a aac -shortest \
  page-NN-mixed.mp4
```

Output: `assets/episodes/<book>/issue-<n>/panels/page-NN-mixed.mp4`

### Step 4 — Assemble final episode

Concatenate all `page-NN-mixed.mp4` files using FFmpeg concat demuxer:

1. Generate `concat-list.txt` listing all page clips in order
2. Run concat:
```bash
ffmpeg -f concat -safe 0 -i concat-list.txt \
  -c:v libx264 -crf 22 -preset medium \
  -c:a aac -b:a 192k \
  episode-motion-comic.mp4
```
3. Output: `assets/episodes/<book>/issue-<n>/assembled/episode-motion-comic.mp4`

---

## Review

After assembly, the pipeline runs:
```
open assets/episodes/<book>/issue-<n>/assembled/episode-motion-comic.mp4
```
Opens in QuickTime on macOS. No approval gate — motion comic runs fully unattended.

---

## Dry Run Output

```
📽  Motion Comic Plan — tmnt-mmpr-iii / issue-1

   Page  Bubbles  Audio Duration  Video Duration
   ───────────────────────────────────────────────
   01    5        18.3s           18.8s
   02    3        11.2s           11.7s
   03    8        29.6s           30.1s
   ...
   22    4        14.1s           14.6s
   ───────────────────────────────────────────────
   Total:          ~8m 42s

Proceed? [Y/n]
```

---

## Implementation Notes

- Check `ffmpeg` is available on PATH before running; exit with clear error if not
- `audio-timestamps.json` contains word-level timing — use it to get accurate per-bubble durations rather than probing MP3 files with ffprobe
- Handle missing audio files gracefully: if a bubble's MP3 doesn't exist, log a warning and skip that bubble (don't abort the whole page)
- The Ken Burns direction (zoom-in vs zoom-out) should alternate per page so adjacent pages feel different
- All intermediate files (`page-NN-video.mp4`, `page-NN-mixed.mp4`, `concat-list.txt`) go in a `_tmp/` subdirectory that is cleaned up after successful assembly

---

## Key Files to Read

- `assets/comics/tmnt-mmpr-iii/issue-1/bubbles.json` — Record<pageKey, Bubble[]> structure
- `assets/comics/tmnt-mmpr-iii/issue-1/audio-timestamps.json` — per-bubble duration data
- `scripts/ingest.ts` — parseArgs pattern to replicate for `motion-comic.ts`
