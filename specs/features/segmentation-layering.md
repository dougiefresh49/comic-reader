# SAM3 segmentation → particle layering

**Status**: pending — needs review before build

## Problem

Particle effects render on top of everything in the panel: the
characters, the bubbles, and the background art. On dense or close-up
panels (see `feedback/screenshots/3.png`) a moderately-strong smoke
+ light-rays preset turns into a "blurry mess" that occludes the
characters and obscures dialogue.

The proper fix is layering: particles between the background and the
foreground (characters + bubbles), not above the foreground.

## Insight from the Roboflow agent conversation

The user added a SAM3 zero-shot segmentation block to their existing
Roboflow workflow and it produced **clean** character + bubble + face
masks on the first try — see
`docs/roboflow/character-cutouts.png` and
`docs/roboflow/agent-convo.md`. The cutouts have crisp edges with no
visible bleed, even on stylized comic art.

This means we can get the foreground mask "for free" alongside the
panel + bubble bbox detection we already do.

## Goal

For every panel, produce a **foreground mask layer** (characters +
bubbles) and a **background plate** (everything else). At render time:

```
[ background plate ]              z 0   ← page art with foreground holed out
[ particle effects ]              z 1   ← smoke, light rays, etc.
[ foreground mask layer ]         z 2   ← characters + bubbles, transparent BG
[ interactive bubble buttons ]    z 3   ← unchanged
```

Particles flow visually behind the characters; bubbles are never
occluded.

## Data flow

### Ingest

Update the existing Roboflow workflow (the one that returns panel +
bubble bboxes) to also include the `segmentation_predictions` SAM3
block. New per-page output schema additions:

```jsonc
{
  // existing fields …
  "segmentation": [
    {
      "class": "character" | "bubble" | "face" | "head" | "person",
      "polygon": [[x0, y0], [x1, y1], …],
      "confidence": 0.97
    }
  ]
}
```

Persist polygons under each panel via a new field:

```sql
alter table panels add column foreground_polygons jsonb;
-- shape: { characters: [[[x,y]…]], bubbles: [[[x,y]…]] }
-- normalized 0..1 in panel-local coordinates
```

A new ingest step `extract-foreground-masks` (slotted after
`get-context`):

1. Read the cached Roboflow response.
2. Filter `segmentation_predictions` to character/face/head/person and
   bubble classes. Merge overlapping polygons within each class.
3. Convert page-level polygons to panel-local 0..1 coordinates.
4. Write `foreground_polygons` per panel.

No image generation at ingest time. We render the masks at runtime via
SVG `<clipPath>` — keeps storage cheap and the math reversible.

### Runtime composite

`PanelViewFrame` already mounts the page image, the dim overlay, and
`PanelEffectsOverlay`. New structure inside the frame:

```tsx
<PanelViewFrame …>
  {/* z-0: full page image, masked to "non-foreground" */}
  <Image src={pageImage} className="absolute inset-0 …"
         style={{ clipPath: backgroundClipPath(panel) }} />

  {/* z-1: particles */}
  <PanelEffectsOverlay panel={panel} … />

  {/* z-2: page image again, masked to foreground only */}
  <Image src={pageImage} className="absolute inset-0 …"
         style={{ clipPath: foregroundClipPath(panel) }} />

  {/* z-3: bubble buttons (unchanged) */}
  …
</PanelViewFrame>
```

The page image is rendered twice — once with everything outside the
foreground polygons (the background plate), once with only the
foreground polygons visible. Browsers render this efficiently because
the underlying bitmap is the same and `clip-path` is GPU-accelerated.

`backgroundClipPath` and `foregroundClipPath` build SVG-style
`clip-path: polygon(...)` strings from the stored polygons. Helpers
live at `src/components/motion-comic/foreground-mask.ts`.

### Bubble exclusion zones for particles

Particle emitters need to know where bubbles are so they don't spawn
inside them (and end up clipped *out* by the foreground mask, leaving
holes around bubbles). Pass `bubblePolygons` to the particle config:

```ts
<PanelEffectsOverlay
  panel={activePanel}
  exclusionZones={panel.foregroundPolygons.bubbles}
  …
/>
```

`tsParticles` supports `exclude` zones via the `move.outModes` config
and `density.area`. Plumb the polygons through.

## Action lines (related)

User-flagged on `screenshots/1.png`: the pinwheel particle is in the
wrong location; the actual action lines are in the upper-left of the
panel art.

SAM3 won't reliably find action lines (they're high-frequency texture,
not a "thing"). Two-step plan:

1. Add an `action_line_position` enum to the panel effect tag schema:
   `top-left | top-right | bottom-left | bottom-right | center |
   full-panel`. Update the Gemini prompt to pick. Cheap, gets us
   "lines in the corner where the art has lines" without any new
   model.
2. Later: train a small Roboflow detector on action-line clusters
   (~50 labeled examples). Returns bboxes → particle effect spawns
   inside the bbox.

## Phasing

1. **Stopgap (1 hr)**: cap opacity on smoke + light-rays effects to
   ~0.5 globally, and disable smoke on panels Gemini tagged with
   `character_close_up`. Buys time without committing to the bigger
   work. (User asked for sign-off before shipping — flagged in reply
   doc.)
2. **Schema + ingest (½ day)**: add `foreground_polygons` column,
   build `extract-foreground-masks` step, backfill on tmnt-mmpr-iii.
3. **Runtime composite (½ day)**: dual-image clip-path render,
   `foreground-mask.ts` helpers, particle exclusion zones.
4. **Action-line position hint (1 hr)**: extend tag schema + prompt.
5. **Action-line detector (1 day)**: optional follow-up; train
   detector, wire into workflow output, render bbox-clipped effects.

Phases 2+3 land the visible fix for `screenshots/3.png`. 4 fixes
`screenshots/1.png`. 5 is polish.

## Risks

- **SAM3 misses on stylized panels.** Possible. Mitigation: when no
  polygon is returned for a panel, fall back to current "particles on
  top" rendering. The `foreground_polygons` column is nullable and
  drives a simple feature flag at render time.
- **clip-path performance on mobile.** Two clip-pathed `<Image>`
  elements per panel. Should be fine — we're already at 60fps with
  the existing overlay stack — but profile on iPhone 12-class
  hardware before shipping.
- **Foreground polygons too detailed.** SAM3 returns dense polygons.
  Simplify to ~30 vertices per shape via Ramer–Douglas–Peucker
  before persisting; the visual difference is invisible and the
  clip-path string stays small.

## Side benefit: character lookahead unlock

The `voice-cloning-and-ingest-lookahead.md` research doc proposed
training a character face detector specifically for clustering /
lookahead. SAM3's `face` class output covers that for free. If we
persist face polygons (we already do as part of `foreground_polygons`),
the lookahead pipeline can:

1. Crop each face by polygon bbox.
2. Embed with CLIP.
3. Cluster across the issue.
4. Identify each cluster via wiki appearances list (one Gemini call
   per cluster, not per panel).

This drops the "train a face detector" line item from the lookahead
plan. Worth folding into that spec when we revisit it.
