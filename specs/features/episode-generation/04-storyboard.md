# Phase 3 — Storyboard (Image Generation)

## Status: `pending`
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

All shots: `POST /image/generate` with `model: "seedream-v5-lite"`

For character shots where reference images exist, use the image editing endpoint instead:
```
POST /images/edit
{
  "model": "flux-2-max-edit",
  "images": [base64_character_reference(s)],
  "prompt": "<built prompt>",
  "negative_prompt": "<series.aesthetic.negativePrompt>",
  "strength": 0.65
}
```

Include up to 2 character reference images. If 3+ characters, fall back to `/image/generate` with `seedream-v5-lite` (describe all characters in text — multi-reference conditioning is unreliable above 2).

**5. Save output:**

`shot-NNN.png` — decoded from base64 response

`shot-NNN.provenance.json`:
```json
{
  "shotId": "s002",
  "model": "flux-2-max-edit",
  "endpoint": "/images/edit",
  "hasFaces": true,
  "characterRefs": ["raphael", "leonardo"],
  "prompt": "...",
  "negativePrompt": "...",
  "generatedAt": "2026-04-26T00:00:00Z"
}
```

`hasFaces: true` — used in Phase 4 to decide between Kling and Seedance. Any shot with characters present = `hasFaces: true`.

**6. Log Venice balance after every 5 images.**

---

## Cost Estimate (shown before proceeding)

Before storyboard begins, print:
```
🎨 Storyboard — 23 shots
   Character shots (flux-2-max-edit): 18 × ~$0.08 = ~$1.44
   Establishing shots (seedream-v5-lite): 5 × ~$0.04 = ~$0.20
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
- `strength: 0.65` for `flux-2-max-edit` is a starting point — too high loses character accuracy, too low loses scene context. May need tuning per shot type.
- For action shots with many characters, a text-only prompt to `seedream-v5-lite` often produces better composition than trying to condition on multiple reference images.

---

## Key Files

- `assets/episodes/<book>/issue-<n>/shot-plan.json` — shot descriptors
- `assets/episodes/<book>/series.json` — aesthetic prompts
- `assets/episodes/<book>/characters/*/reference.png` — character reference images
- `data/character-registry.json` — `visualDescription` per character
- `scripts/utils/venice-client.ts` — Venice API calls
- `scripts/utils/review-generator.ts` — generates review HTML
