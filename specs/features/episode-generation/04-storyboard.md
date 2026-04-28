# Phase 3 — Storyboard (Image Generation)

> **⚠ Superseded.** The cinematic-video direction was abandoned for cost
> reasons (~$95–$380/issue against a $5 API ceiling). The new default
> render path is **Motion Comic Plus** —
> see [`../motion-comic-plus/00-overview.md`](../motion-comic-plus/00-overview.md).
> This spec is retained for the optional **Hero Shot Cinematic** mode,
> where individual shots can be tagged `--hero` to opt into Venice
> image+video gen.

## Status: `superseded` (default), `pending` (hero-shot opt-in only)
## Prerequisites: Phase 2 complete (shot-plan.json approved), Phase 1 complete (series.json, character references)
## Cost: ~$5–15/issue (~$0.05–0.50 per image × 20–30 shots)

---

## Purpose

Generate one panel image per shot using Venice image generation. These images become the input frames for video generation in Phase 4.

Each shot's `sceneDescription` (from shot-plan.json) + the series aesthetic + character reference images (for character shots) are combined into an image prompt.

---

## Command

```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step storyboard

# Regenerate only rejected shots (after review)
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --reject-shots s003,s007 --from-step storyboard
```

---

## Output

Per shot:
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.png`
- `assets/episodes/<book>/issue-<n>/panels/shot-NNN.provenance.json`

---

## Process

### For each shot in shot-plan.json (in order, checkpointed per shot):

**1. Skip if panel already exists and is approved** (check `review-state.json`)

**2. Check if shot is marked for regeneration** (either first run or `--reject-shots` was used)

**3. Build image prompt:**

For `establishing` or `narration` type shots (no characters):
```
[series.aesthetic.stylePrompt], [shot.sceneDescription], [mood from shot], 
wide establishing shot, cinematic composition
```

For `dialogue`, `action`, or `reaction` type shots (with characters):
```
[series.aesthetic.stylePrompt], [shot.sceneDescription], 
[character1.visualDescription], [character2.visualDescription if present],
[primarySpeaker] is [emotion from primary dialogue bubble], 
dynamic comic panel composition, mid-shot framing
```

**4. Select model and endpoint:**

**Establishing / narration shots (no characters):**
```
POST /image/generate
{
  "model": "seedream-v5-lite",     // VENICE_IMAGE_STORYBOARD from models.ts
  "prompt": "<built prompt>",
  "negative_prompt": "<series.aesthetic.negativePrompt>",
  "aspect_ratio": "16:9",
  "format": "png",
  "hide_watermark": true
}
→ { "images": ["<base64-png>"] }   decode images[0] → PNG buffer
```

**Single-character shots (1 character, reference image exists):**
```
POST /image/edit
{
  "model": "seedream-v5-lite-edit",  // VENICE_IMAGE_EDIT_CHAR from models.ts
  "image": "<base64 of character's reference.png>",
  "prompt": "<built prompt — place this character in the scene>",
  "aspect_ratio": "16:9"
}
→ binary image/png response (write buffer directly — no base64 unwrapping)
```

Note: The edit endpoint takes **one image** and returns **binary PNG** (not JSON). There is no `negative_prompt` or `strength` parameter on this endpoint.

**Multi-character shots (2+ characters) — fallback:**
```
POST /image/generate
{
  "model": "seedream-v5-lite",     // VENICE_IMAGE_STORYBOARD from models.ts
  "prompt": "<built prompt — describe all characters in text>",
  "negative_prompt": "<series.aesthetic.negativePrompt>",
  "aspect_ratio": "16:9",
  "format": "png",
  "hide_watermark": true
}
```

The `/image/edit` endpoint accepts only a single input image — it cannot composite multiple character references. For 2+ character shots, describe all characters in the text prompt instead.

**Import all model ID strings from `scripts/utils/models.ts` — never hardcode inline.**

**5. Save output:**

`shot-NNN.png` — from `/image/generate`: decode `images[0]` from base64; from `/image/edit`: write binary response directly

`shot-NNN.provenance.json`:
```json
{
  "shotId": "s002",
  "model": "seedream-v5-lite-edit",
  "endpoint": "/image/edit",
  "hasFaces": true,
  "characterRefs": ["raphael"],
  "prompt": "...",
  "generatedAt": "2026-04-26T00:00:00Z"
}
```

`hasFaces: true` — used in Phase 4 to select the R2V video model and pass `reference_image_urls`. Any shot with characters present = `hasFaces: true`.

Note: `negativePrompt` is omitted from provenance when using the edit endpoint (that endpoint has no negative_prompt field).

**6. Log Venice balance after every 5 images.**

Balance is returned in the `X-Balance-Remaining` response header on all Venice API calls. Read it from the response header — no separate API call needed.

---

## Cost Estimate (shown before proceeding)

Before storyboard begins, print:
```
🎨 Storyboard — 23 shots
   Single-char shots (seedream-v5-lite-edit): 12 × ~$0.05 = ~$0.60
   Multi-char shots (seedream-v5-lite):        6 × ~$0.05 = ~$0.30
   Establishing shots (seedream-v5-lite):       5 × ~$0.05 = ~$0.25
   Estimated total: ~$1.64
   Current balance: $12.43

Proceed? [Y/n]
```

---

## Review Gate

After all panels are generated, the pipeline:

1. Generates `assets/episodes/<book>/issue-<n>/review-storyboard.html`
2. Opens it in the browser: `open review-storyboard.html`

### Review HTML Structure

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #111; color: #fff; font-family: sans-serif; padding: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .shot { border: 1px solid #333; border-radius: 6px; overflow: hidden; }
    .shot img { width: 100%; display: block; }
    .shot-meta { padding: 8px 10px; font-size: 12px; color: #aaa; }
    .shot-id { font-weight: bold; color: #fff; }
  </style>
</head>
<body>
  <h1>Storyboard Review — tmnt-mmpr-iii / issue-1</h1>
  <p>23 panels · Review and note any shot IDs to regenerate</p>
  <div class="grid">
    <!-- generated per shot -->
    <div class="shot">
      <img src="./panels/shot-001.png" />
      <div class="shot-meta">
        <span class="shot-id">s001</span> · p.1 · establishing · 4.0s<br>
        Aerial NYC at night
      </div>
    </div>
    ...
  </div>
</body>
</html>
```

Uses `file://` relative paths — no server needed. Opens in any browser.

### Pipeline pause after opening HTML:

```
🎨 Storyboard review opened in browser.
   file:///.../review-storyboard.html

Approve all panels and continue to video generation?
Or enter shot IDs to regenerate (comma-separated): [Enter to approve all]
> s003, s007

Regenerating s003, s007...
```

Regenerated shots re-run the generation step above, then the review HTML is regenerated and re-opened for the affected shots only.

---

## Prompt Improvement Tips (for implementers)

- The `sceneDescription` in shot-plan.json is the primary lever for image quality. The review gate before storyboard (Phase 2) is specifically for editing these descriptions.
- The `seedream-v5-lite-edit` endpoint has no `strength` parameter — prompt wording is the main lever. Describe the target scene clearly; the model retains the character's appearance from the input `reference.png`.
- For action shots with many characters, a text-only prompt to `seedream-v5-lite` often produces better composition than trying to condition on multiple reference images.

---

## Key Files

- `assets/episodes/<book>/issue-<n>/shot-plan.json` — shot descriptors
- `assets/episodes/<book>/series.json` — aesthetic prompts
- `assets/episodes/<book>/characters/*/reference.png` — character reference images (input to /image/edit)
- `data/character-registry.json` — `visualDescription` per character
- `scripts/utils/models.ts` — `VENICE_IMAGE_STORYBOARD` (`seedream-v5-lite`), `VENICE_IMAGE_EDIT_CHAR` (`seedream-v5-lite-edit`)
- `scripts/utils/venice-client.ts` — Venice API calls
- `scripts/utils/review-generator.ts` — generates review HTML
- `docs/venice-ai/image-models.json` — confirmed image model IDs and constraints
- `docs/venice-ai/image-model-traits.json` — model traits reference
