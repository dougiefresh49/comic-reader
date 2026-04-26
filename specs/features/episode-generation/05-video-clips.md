# Phase 4 — Video Clip Generation

## Status: `pending`
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
hasFaces === true  → kling-3.0   (no provenance restriction, best for character faces)
hasFaces === false → seedance-2.0 (best motion quality for environments/atmosphere)
```

This decision is automatic — no user input needed.

---

## Process

### Before starting

Print cost estimate:
```
🎬 Video Generation — 23 shots
   Character shots (kling-3.0):     18 × ~$1.20 = ~$21.60
   Atmosphere shots (seedance-2.0):  5 × ~$0.80 = ~$4.00
   Estimated total: ~$25.60
   Current balance: $12.43

⚠️  This is the most expensive phase. Proceed? [Y/n]
```

### Per shot (sequential or batched — see note on batching below):

**1. Skip if video already exists and is not marked for regeneration**

**2. Determine clip duration**

- Sum audio durations for this shot from `audio-timestamps.json`
- Add 0.5s tail padding
- Snap to nearest Venice-supported duration value: `[2, 4, 6, 8, 10]` seconds (round up)
- Cap at 10s (Venice maximum for queue endpoint)

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
  "model": "kling-3.0",           // or "seedance-2.0"
  "prompt": "<built prompt>",
  "image_url": "<base64 of shot-NNN.png>",
  "duration": 6,                  // snapped value
  "aspect_ratio": "16:9"
}
→ { "queue_id": "uuid", "quote_usd": 1.20 }
```

Log the `quote_usd` from the response to running cost tracker.

**5. Poll for completion**

```
GET /video/retrieve?queue_id=<uuid>
→ { "status": "processing|completed|failed", "video": "<base64>" }
```

Poll every 15 seconds. Timeout after 10 minutes. On `failed`: log and mark shot for regeneration in `review-state.json`, continue to next shot.

**6. Save clip**

Decode base64 video → `assets/episodes/<book>/issue-<n>/videos/shot-NNN.mp4`

Log:
```
   ✓ s002 — kling-3.0 · 6s · $1.20 (balance: $11.23 remaining)
```

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

Venice models only support specific durations. Always round **up** to ensure enough runtime for the dialogue:

| Audio duration | Snapped to |
|----------------|-----------|
| ≤ 1.5s | 2s |
| 1.5–3.5s | 4s |
| 3.5–5.5s | 6s |
| 5.5–7.5s | 8s |
| 7.5s+ | 10s |

If snapped duration < actual audio duration: log a warning. The assembly phase will handle audio that slightly exceeds clip duration.

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
        <span class="shot-id">s001</span> · p.1 · establishing · seedance-2.0 · 4s<br>
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

## Key Files

- `assets/episodes/<book>/issue-<n>/shot-plan.json` — shot descriptors + audio file lists
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.provenance.json` — `hasFaces` flag
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.png` — panel images
- `assets/comics/<book>/<issue>/audio-timestamps.json` — bubble durations for snapping
- `scripts/utils/venice-client.ts` — queue submission + polling
- `scripts/utils/review-generator.ts` — video review HTML
