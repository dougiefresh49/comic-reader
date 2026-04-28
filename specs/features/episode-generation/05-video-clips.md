# Phase 4 — Video Clip Generation

> **⚠ Superseded.** The cinematic-video direction was abandoned for cost
> reasons (~$95–$380/issue against a $5 API ceiling). The new default
> render path is **Motion Comic Plus** —
> see [`../motion-comic-plus/00-overview.md`](../motion-comic-plus/00-overview.md).
> This spec is retained for the optional **Hero Shot Cinematic** mode,
> where individual shots can be tagged `--hero` to opt into Venice
> image+video gen.

## Status: `superseded` (default), `pending` (hero-shot opt-in only)
## Prerequisites: Phase 3 complete (all panels approved in review-state.json)
## Cost: ~$15–50/issue (~$0.50–2.00 per clip × 20–30 shots)

---

## Purpose

Convert each storyboard panel image into a short video clip using Venice's async video queue. This is the most expensive phase. Every clip is checkpointed individually — a failed or interrupted run resumes from the last incomplete clip.

---

## Command

```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step generate-videos

# Re-run specific clips after rejection
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --reject-shots s003,s007 --from-step generate-videos
```

---

## Output

Per shot:
- `assets/episodes/<book>/issue-<n>/videos/shot-NNN.mp4`

---

## Model Selection Per Shot

Read `shot-NNN.provenance.json` (`hasFaces` field):

```
hasFaces === true  → VENICE_VIDEO_CHARACTER  = "kling-o3-pro-reference-to-video"
                     R2V model: pass character reference.png(s) via reference_image_urls.
                     Maintains character identity without needing seedream-sourced input images.

hasFaces === false → VENICE_VIDEO_ATMOSPHERE = "seedance-2-0-image-to-video"
                     Standard image-to-video. No reference images needed.
```

**Import all model ID strings from `scripts/utils/models.ts` — never hardcode inline.**

This decision is automatic — no user input needed.

---

## Process

### Before starting

For each shot, call `POST /video/quote` with the same payload as the queue request to get the exact cost. Sum all quotes, then print:

```
🎬 Video Generation — 23 shots
   Character shots (kling-o3-pro-reference-to-video): 18 × ~$1.20 = ~$21.60
   Atmosphere shots (seedance-2-0-image-to-video):     5 × ~$0.80 = ~$4.00
   Estimated total: ~$25.60
   Current balance: $12.43

⚠️  This is the most expensive phase. Proceed? [Y/n]
```

### Per shot (sequential or batched — see note on batching below):

**1. Skip if video already exists and is not marked for regeneration**

**2. Determine clip duration**

- Sum audio durations for this shot from `audio-timestamps.json`
- Add 0.5s tail padding
- Snap to nearest supported duration value for the selected model (round **up**), then pass as a string (e.g. `"5s"`, `"10s"`)

Supported durations per model:
- `kling-o3-pro-reference-to-video`: `"3s"` through `"15s"` every second — snap to `Math.ceil(audioDuration + 0.5)`, clamp to `[3, 15]`, format as `"Xs"`
- `seedance-2-0-image-to-video`: `["4s","5s","8s","10s","12s","15s"]` — snap to first value ≥ audioDuration + 0.5s

See Duration Snapping Reference section below for the lookup table.

**3. Build video prompt**

For both models, the prompt describes the motion:
```
[shot.sceneDescription], [if dialogue: primarySpeaker + emotion + speaking], 
smooth camera motion, [series.aesthetic.stylePrompt excerpt — style and palette only]
```

Keep prompts under ~150 tokens. Venice video prompts should describe motion, not appearance — appearance comes from the input image.

**4. Submit to video queue**

```json
POST /video/queue
{
  "model": "kling-o3-pro-reference-to-video",   // VENICE_VIDEO_CHARACTER or VENICE_VIDEO_ATMOSPHERE
  "prompt": "<built prompt>",
  "image_url": "<base64 data URI of shot-NNN.png>",
  "reference_image_urls": ["<base64 data URI of character reference.png>"],  // hasFaces only; omit for atmosphere shots
  "duration": "6s",               // string enum — model-specific; see Duration Snapping Reference
  "aspect_ratio": "16:9",
  "audio": false                  // we provide our own ElevenLabs audio in Phase 5
}
→ { "model": "...", "queue_id": "uuid" }
```

Note: There is no `quote_usd` in the queue response. Use `/video/quote` before queueing for cost estimates.
The `X-Balance-Remaining` response header gives current balance after submission.

**5. Poll for completion**

```
POST /video/retrieve
{
  "model": "kling-o3-pro-reference-to-video",   // same model used to queue
  "queue_id": "<uuid>"
}
→ While processing: JSON { "status": "PROCESSING", "average_execution_time": 45000 }
→ On completion:    binary video/mp4 response (Content-Type: video/mp4)
→ On failure:       4xx/5xx error response
```

Poll every 15 seconds. Timeout after 10 minutes. On failure: log and mark shot for regeneration in `review-state.json`, continue to next shot.

**6. Save clip**

Write binary response body directly to `assets/episodes/<book>/issue-<n>/videos/shot-NNN.mp4` — no base64 decoding needed.

Log:
```
   ✓ s002 — kling-o3-pro-reference-to-video · 6s  (balance: $11.23 remaining)
```

Read balance from the `X-Balance-Remaining` response header on the `/video/retrieve` completion response.

**7. Update episode-checkpoint.json** after each successful clip.

---

## On Batching

The Venice video queue is async — you submit and poll later. It's safe to submit multiple shots in parallel and poll them concurrently. Recommended approach:

- Submit shots in batches of 5
- Start polling all 5 as they're submitted
- When a slot completes, submit the next queued shot
- This minimizes wall-clock time while avoiding rate limit issues

The checkpoint still tracks per-shot so partial batches survive interruption.

---

## Duration Snapping Reference

Duration is passed as a **string enum** (e.g. `"5s"`). Supported values vary by model. Always round **up** to ensure enough runtime for the dialogue. Add 0.5s padding before snapping.

### `kling-o3-pro-reference-to-video` (every second from 3–15s)

```ts
const raw = audioDuration + 0.5;
const snapped = Math.max(3, Math.min(15, Math.ceil(raw)));
const durationStr = `${snapped}s`;
```

### `seedance-2-0-image-to-video` (fixed set: 4s, 5s, 8s, 10s, 12s, 15s)

| Audio + padding | Snapped to |
|-----------------|-----------|
| ≤ 4.0s | `"4s"` |
| ≤ 5.0s | `"5s"` |
| ≤ 8.0s | `"8s"` |
| ≤ 10.0s | `"10s"` |
| ≤ 12.0s | `"12s"` |
| > 12.0s | `"15s"` |

If padded audio duration > snapped clip duration: log a warning. The assembly phase will handle audio that slightly overruns the clip.

---

## Review Gate

After all clips are generated:

1. Generate `assets/episodes/<book>/issue-<n>/review-videos.html`
2. Open in browser: `open review-videos.html`

### Review HTML Structure

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #111; color: #fff; font-family: sans-serif; padding: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
    .shot { border: 1px solid #333; border-radius: 6px; overflow: hidden; }
    .shot video { width: 100%; display: block; }
    .shot-meta { padding: 8px 10px; font-size: 12px; color: #aaa; }
    .shot-id { font-weight: bold; color: #fff; }
  </style>
</head>
<body>
  <h1>Video Review — tmnt-mmpr-iii / issue-1</h1>
  <p>23 clips · Total: ~$26.40 spent · Review and note any shot IDs to regenerate</p>
  <div class="grid">
    <div class="shot">
      <video src="./videos/shot-001.mp4" controls loop></video>
      <div class="shot-meta">
        <span class="shot-id">s001</span> · p.1 · establishing · seedance-2-0-image-to-video · 4s<br>
        Aerial NYC at night
      </div>
    </div>
    ...
  </div>
</body>
</html>
```

`<video>` tags with `controls` and `loop` via `file://` — works in Chrome/Safari without a server.

### Pipeline pause:

```
🎬 Video review opened in browser.

Approve all clips and continue to audio assembly?
Or enter shot IDs to regenerate (comma-separated): [Enter to approve all]
> s011

⚠️  Regenerating s011 will cost ~$1.20. Proceed? [y/N]
> y
```

---

## Running Cost Log

Throughout this phase, maintain a running total printed to console:

```
   Progress: 18/23 shots · $21.40 spent · $4.03 remaining est.
```

Also write `assets/episodes/<book>/issue-<n>/cost-log.json` with per-shot actual spend (from `quote_usd`).

---

---

## Venice API Notes

- **Queue:** `POST /video/queue` — submits job, returns `{ model, queue_id }`
- **Quote:** `POST /video/quote` — same payload as queue, returns cost estimate before committing
- **Retrieve:** `POST /video/retrieve` with body `{ model, queue_id }` — returns JSON while processing, binary `video/mp4` on completion
- **Balance:** Read `X-Balance-Remaining` response header (returned on queue, retrieve, and quote responses)
- **Model IDs:** Always import from `scripts/utils/models.ts` (`VENICE_VIDEO_CHARACTER`, `VENICE_VIDEO_ATMOSPHERE`)
- **Reference docs:** `docs/venice-ai/video-models.json`, `docs/venice-ai/video-models-descriptions.json`

---

## Key Files

- `assets/episodes/<book>/issue-<n>/shot-plan.json` — shot descriptors + audio file lists
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.provenance.json` — `hasFaces` flag + character refs list
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.png` — panel images (input to video queue)
- `assets/episodes/<book>/characters/*/reference.png` — character reference images for `reference_image_urls`
- `assets/comics/<book>/<issue>/audio-timestamps.json` — bubble durations for snapping
- `scripts/utils/models.ts` — `VENICE_VIDEO_CHARACTER`, `VENICE_VIDEO_ATMOSPHERE`
- `scripts/utils/venice-client.ts` — queue submission + polling
- `scripts/utils/review-generator.ts` — video review HTML
- `docs/venice-ai/video-models.json` — confirmed model IDs and supported duration values
