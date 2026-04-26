# Phase 2 — Shot Planning

## Status: `pending`
## Prerequisites: Phase 1 complete (series.json exists)
## Cost: ~$0.10–0.30/issue (Gemini Vision per page)

---

## Purpose

Convert `bubbles.json` + comic page images into a structured list of **shot descriptors** — the unit of production for the cinematic pipeline. Each shot becomes one image generation call + one video generation call.

This phase is the bridge between the comic's reading structure and the video's cinematic structure. A good shot plan is the difference between a coherent episode and a choppy slide show.

Human review is required before any Venice spending begins.

---

## Command

```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step plan-shots
```

---

## Output

`assets/episodes/<book>/issue-<n>/shot-plan.json`:

```json
{
  "bookId": "tmnt-mmpr-iii",
  "issueId": "issue-1",
  "generatedAt": "2026-04-26T00:00:00Z",
  "totalShots": 23,
  "estimatedDurationSeconds": 312,
  "shots": [
    {
      "shotId": "s001",
      "pageIndex": 1,
      "type": "establishing",
      "characters": [],
      "primarySpeaker": null,
      "sceneDescription": "Aerial view of New York City at night, neon signs reflecting on wet streets",
      "dialogue": [],
      "audioFiles": [],
      "estimatedDurationSeconds": 4.0,
      "sourcePageKey": "page-01.jpg",
      "panelRegion": "full-page"
    },
    {
      "shotId": "s002",
      "pageIndex": 1,
      "type": "dialogue",
      "characters": ["Raphael", "Leonardo"],
      "primarySpeaker": "Raphael",
      "sceneDescription": "Raphael confronts Leonardo on a rooftop, gesturing aggressively. Night city backdrop.",
      "dialogue": [
        { "speaker": "Raphael", "text": "I told you this was a trap!", "audioFile": "page-01-bubble-003.mp3" },
        { "speaker": "Leonardo", "text": "Stay focused. We finish this together.", "audioFile": "page-01-bubble-004.mp3" }
      ],
      "audioFiles": ["page-01-bubble-003.mp3", "page-01-bubble-004.mp3"],
      "estimatedDurationSeconds": 6.2,
      "sourcePageKey": "page-01.jpg",
      "panelRegion": "bottom-half"
    }
  ]
}
```

---

## Shot Types

| Type | Description | Venice model (later) |
|------|-------------|---------------------|
| `establishing` | No characters, location/atmosphere | `seedance-2.0` |
| `dialogue` | 1–3 characters speaking | `kling-3.0` |
| `action` | Characters in motion/combat (3+ or fast motion) | `kling-3.0` |
| `narration` | NARRATION/CAPTION bubbles, no character face | `seedance-2.0` |
| `reaction` | Character(s) reacting without speaking | `kling-3.0` |

---

## Shot Grouping Rules

These rules run on the sorted bubbles from `bubbles.json`:

1. **Page boundary = scene break opportunity.** Every new page gets at least one shot. If the page is dramatically different from the previous (detected by Gemini — different location, time jump), insert an establishing shot before the dialogue shots.

2. **Consecutive bubbles, same primary speaker = one shot** (up to ~8 seconds of audio). If a character delivers multiple lines in a row, combine them into one shot rather than cutting on every bubble.

3. **Speaker change = new shot.** When the primary speaker changes, start a new shot.

4. **NARRATION/CAPTION bubbles** always become their own `narration` type shot.

5. **SFX/BACKGROUND bubbles** are skipped — no shot generated.

6. **Maximum shot audio duration: 10 seconds** (Venice video max). Split longer sequences at natural dialogue breaks.

---

## Process

### Step A — Per-page Gemini Vision analysis

For each page image:

1. Send page image + that page's bubbles (from `bubbles.json`) to Gemini Vision (`GEMINI_MEDIUM`):

```
You are analyzing a comic book page for video production.

Here is the page image and the structured dialogue data for this page:
<bubbles_json>

For this page, identify:
1. How many distinct visual panels are on this page (1–6 typically)?
2. For each panel, describe: location/setting, which characters appear, the action/mood.
3. Are there any mid-page scene changes (location shift, time jump)?
4. Suggest where natural scene/shot breaks should be.

Return JSON:
{
  "panelCount": number,
  "panels": [
    {
      "region": "top-third | top-half | bottom-half | bottom-third | full-page | left-half | right-half",
      "setting": "string description of location",
      "characters": ["character names visible"],
      "action": "string description of what's happening",
      "mood": "string"
    }
  ],
  "sceneBreakAfterPanel": number | null
}
```

Model: `GEMINI_MEDIUM` — visual description is not deep reasoning.

### Step B — Map bubbles to panels

Cross-reference each bubble's `style` coordinates with the panel regions returned by Gemini. Assign each bubble to a panel. Use the spatial overlap of bubble `style` (left/top/width/height as %) to determine which panel region it falls in.

### Step C — Apply grouping rules

Apply the shot grouping rules from above to produce the final shot list. For each shot:
- Build `sceneDescription` from the Gemini panel description
- Collect `audioFiles` from the bubble IDs (audio file naming: `<bubble.id>.mp3`)
- Calculate `estimatedDurationSeconds` from `audio-timestamps.json` (sum of bubble durations + 0.3s padding between lines)
- Assign `type` based on characters present and bubble types

### Step D — Write shot-plan.json

Write the complete shot plan. Log summary stats.

---

## Review Gate

After shot planning, the pipeline prints a formatted table and opens a browser preview:

```
📋 Shot Plan — tmnt-mmpr-iii / issue-1
   23 shots · ~5m 12s total

   Shot  Page  Type          Characters           Duration  Description
   ────────────────────────────────────────────────────────────────────────────
   s001  01    establishing  —                    4.0s      Aerial NYC at night
   s002  01    dialogue      Raphael, Leonardo    6.2s      Raphael confronts Leo...
   s003  02    action        All 4 turtles        8.0s      Rooftop battle begins
   ...
   s023  22    narration     —                    3.5s      "TO BE CONTINUED..."

Estimated Venice spend (phases 3–4): ~$28–45

Review the shot plan.
Edit shot-plan.json manually to merge, split, or adjust shots. 
Proceed with this plan? [Y/n]
```

If the user edits `shot-plan.json` before answering: the pipeline re-reads the file before proceeding, so manual edits are respected.

**This is the last free review gate before Venice spending begins.**

---

## Editing the Shot Plan

Common manual adjustments:
- **Merge shots**: combine two short adjacent shots by removing one and adding its `audioFiles` and `dialogue` entries to the other
- **Split a shot**: duplicate a shot entry and divide the `audioFiles` and `dialogue` between them
- **Change type**: override Gemini's `type` assignment (e.g., change `dialogue` to `action` for a combat scene)
- **Edit `sceneDescription`**: this becomes the Venice image generation prompt — improving it directly improves the generated image

The shot plan is a plain JSON file. No tooling required to edit it.

---

## Key Files

- `assets/comics/<book>/<issue>/bubbles.json` — source dialogue data (Record<pageKey, Bubble[]>)
- `assets/comics/<book>/<issue>/audio-timestamps.json` — bubble audio durations
- `assets/comics/<book>/<issue>/pages-webp/` — page images for Gemini Vision
- `assets/episodes/<book>/series.json` — aesthetic (needed in later phases)
- `scripts/utils/shot-planner.ts` — implement the grouping logic here
