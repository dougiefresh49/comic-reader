# Motion Comic — Future Improvements

## Status: `pending` (backlog — not blocking cinematic pipeline)

Improvements to `pnpm motion-comic` if the motion comic format is worth investing in further. Listed in priority order. Each is independent — pick and choose.

---

## Improvement 1: Smart Ken Burns (Bubble-Guided Camera)

**Problem:** The current implementation always zooms from the dead center of the image. On a comic page, the center is rarely where anything interesting happens, so the camera feels random.

**Solution:** Use bubble `%`-based coordinates from `bubbles.json` to calculate a focal point per page. Instead of centering, the camera starts framed on the first bubble and slowly pans toward the last bubble — following reading order as the audio plays.

### Implementation

`buildPlans` already filters dialogue bubbles in reading order. Extend it to extract focal points:

```ts
interface FocalPoint { x: number; y: number; }  // 0.0–1.0, center of bubble

function bubbleFocalPoint(bubble: LocalBubble): FocalPoint {
  // Parse % values from bubble.style (left, top, width, height)
  // Return center: { x: left + width/2, y: top + height/2 }
}
```

Pass `startFocal` and `endFocal` to `generatePageVideo`. Update the `zoompan` expression:

```
x='lerp(startX, endX, (on/d))'
y='lerp(startY, endY, (on/d))'
```

Where `startX/Y` and `endX/Y` are pixel offsets derived from the focal percentages × image dimensions.

For pages with only one bubble, use that bubble's center for both start and end (static frame with zoom only).

**Effort:** Medium. Changes `buildPlans`, `PagePlan`, and `generatePageVideo`.

---

## Improvement 2: Panel Detection + Panel-Level Video

**Problem:** The current approach zooms the entire comic page as one image. A more cinematic result would zoom into individual panels sequentially — each panel gets its own close-up as its dialogue plays.

**Solution:** Use Roboflow (already in the pipeline) with a panel-boundary detection model to detect individual panels on each page. Each panel becomes its own video segment with Ken Burns applied at panel scale.

### Pipeline Change

New step before video generation:

```bash
pnpm motion-comic -- --book tmnt-mmpr-iii --issue 1 --detect-panels
```

1. For each page WebP, call Roboflow panel-detection model (different from the existing bubble model — would need a trained panel model or use a pre-existing one)
2. Output `panel-crops/page-NN-panel-MM.webp` — cropped panel images
3. Map each bubble to its containing panel via bounding box overlap
4. Generate one video segment per panel (Ken Burns on the crop), duration = sum of that panel's bubble audio durations
5. Assemble panel segments → page clip → episode (same Step 4 as current)

### Panel Model

The existing Roboflow workspace detects speech bubbles. Panel detection is a separate model. Options:
- Train a panel model in the existing Roboflow workspace using comic page annotations
- Use a pre-trained comic panel segmentation model (several exist on HuggingFace — `aber-jk/comic-panel-detection` etc.)
- Use Gemini Vision to describe panel layout and extract bounding boxes (`GEMINI_MEDIUM` — vision task, no reasoning)

**Effort:** High. Requires a panel detection model, new crop step, and bubble→panel mapping logic.

---

## Improvement 3: Gemini Vision Focal Point Analysis

**Problem:** Even with bubble-guided camera, the focal point is derived from text positions, not visual content. A dramatic action panel might have the bubble in the corner but the fight in the center.

**Solution:** Send each page (or panel crop) to Gemini Vision and ask it to identify the most visually significant region — the "director's focus point" for that scene.

```
Analyze this comic page panel. Identify the single most visually important region
(the focal point a camera would push toward). Return JSON:
{ "x": 0.0-1.0, "y": 0.0-1.0, "reasoning": "..." }
Where x/y are the normalized center of the focus region.
```

Model: `GEMINI_MEDIUM` (vision task, no deep reasoning needed). Cache results per page to avoid re-calling on re-runs.

Output stored in `data/motion-comic-focal-points.json` per issue.

**Effort:** Low-medium. New Gemini call per page + JSON cache. Ken Burns expression change is small.

---

## Improvement 4: Audio Fade In/Out Per Page

**Problem:** Audio cuts abruptly between pages. Each page's dialogue track starts and ends hard.

**Solution:** Add a short fade-in (0.1s) and fade-out (0.3s) to each page's audio track using FFmpeg `afade` filter before merging:

```bash
ffmpeg -i page-NN-dialogue.mp3 \
  -af "afade=t=in:d=0.1,afade=t=out:st=<duration-0.3>:d=0.3" \
  page-NN-dialogue-faded.mp3
```

**Effort:** Very low. One extra FFmpeg pass per page. Add to `buildPageAudio`.

---

## Improvement 5: Cross-Page Transitions

**Problem:** Pages cut hard with no transition. Jarring on long reads.

**Solution:** Add a short crossfade between page clips during assembly using FFmpeg `xfade` filter:

```bash
ffmpeg -i page-01-mixed.mp4 -i page-02-mixed.mp4 \
  -filter_complex "xfade=transition=fade:duration=0.3:offset=<page1_duration-0.3>" \
  page-01-02-transition.mp4
```

This requires chaining xfade across all pages, which is more complex than the current concat demuxer approach. Would need to switch from `concat` to a filter_complex chain, or process transitions pair-by-pair then concat the results.

**Effort:** Medium. Significant change to the assembly step.

---

## Improvement 6: Hardware-Accelerated Encoding (VideoToolbox)

**Problem:** `libx264` for intermediate clip encoding is CPU-only. On Apple Silicon, the M-series media engine can encode H264 much faster.

**Solution:** Swap `libx264` → `h264_videotoolbox` for intermediate clips (Steps 2 and 3). Keep `libx264` for the final assembly where quality matters more.

```ts
// Step 2 intermediate clips — speed-optimized
"-c:v", "h264_videotoolbox",
"-q:v", "55",  // ~CRF 18 equivalent

// Step 4 final assembly — quality-optimized (unchanged)
"-c:v", "libx264",
"-crf", "22",
```

Note: `h264_videotoolbox` is macOS-only. Add a platform check — fall back to `libx264` on non-macOS.

**Effort:** Very low. 3-line change. Would cut per-page video generation time from ~30s to ~5s on M-series.

---

## Recommended Implementation Order

If investing in the motion comic format:

1. **Improvement 6** (VideoToolbox) — 10-minute change, 5× speed improvement on macOS. Do this first.
2. **Improvement 4** (Audio fades) — 30-minute change, meaningfully better feel.
3. **Improvement 1** (Smart Ken Burns) — 2-3 hour change, biggest visual quality improvement.
4. **Improvement 3** (Gemini focal points) — half day, makes camera choices feel intentional.
5. **Improvement 2** (Panel detection) — multi-day, transforms the format entirely. Only worth it if the motion comic is a primary deliverable.
6. **Improvement 5** (Transitions) — nice polish, low priority.
