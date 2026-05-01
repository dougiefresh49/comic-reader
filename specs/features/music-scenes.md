# Music scenes — group panels into continuous music runs

**Status**: pending — needs review before build

## Problem

Background music restarts on every panel transition, even when adjacent
panels share the same `audio_tags.music_mood`. The user reported this
on issue 1 page 5: "every time I click another panel the same
background music starts over."

The runtime player (`PanelAudioLayer`) already has continuity logic —
if `musicTag` is unchanged across panels and `isNewScene` is false, it
keeps the bed playing. So the runtime is fine. The bug is upstream:

- Gemini emits per-panel `music_mood` tags. Adjacent panels in a single
  action sequence often get slightly different mood tags
  (`tense_action_a` vs `tense_action_b`), so the player's "same tag"
  check fails and crossfades. Result: the music retriggers.
- And/or `isNewScene` is over-flagged. Gemini biases toward marking
  every dramatic beat as a new scene.

## Goal

A single music bed plays continuously across a sequence of panels,
including across page boundaries. The bed crossfades only when the
*authored intent* says the scene has actually changed — not because
Gemini drifted on a tag.

## Design

### Data model

Add a `music_scenes` table that owns the (book, issue, ordered range
of panels, music tag) tuple. Panels reference scenes via FK:

```sql
create table music_scenes (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  -- canonical mood tag for the whole scene
  music_mood text not null,
  -- inclusive panel range, by global panel index across the issue
  start_panel_id uuid references panels(id),
  end_panel_id uuid references panels(id),
  -- optional human-readable label for admin UI
  label text,
  created_at timestamptz default now(),
  unique (start_panel_id)
);

alter table panels add column scene_id uuid references music_scenes(id);
```

Why range-based instead of "first panel marks scene start":

- Range gives us O(1) "is this panel in scene S?" without scanning.
- Page navigation still works: when the reader mounts page N, it loads
  the panels for that page and resolves `scene_id` for each. If two
  consecutive panels (across a page boundary) share `scene_id`, the
  player keeps the bed.

### Ingest step: consolidate moods into runs

New script: `scripts/consolidate-music-scenes.ts`. Slot it after
`panel-director` (which writes per-panel `music_mood`) and before
`copy-to-public`.

Algorithm:

```
panels = all panels for issue, ordered by (page, sortOrder)
runs = []
current = null
for p in panels:
    if current and similar(current.mood, p.music_mood) and !p.isNewScene:
        current.end = p
    else:
        if current: runs.push(current)
        current = { start: p, end: p, mood: canonical(p.music_mood) }
runs.push(current)
```

`similar(a, b)` collapses near-synonyms (`tense_action_a` ≈
`tense_action_b`). Implementation: normalize by stripping trailing
`_<letter>` / `_<digit>` suffixes, then string-equal. Add a manual
canonical-mood lookup table for hand-curated equivalences.

`canonical(mood)` picks the cleanest representative for the run (the
one whose source clip exists in the audio library, falling back to the
first occurrence).

Each run becomes a `music_scenes` row; each panel in the range gets
`scene_id` set.

### Runtime change

`PanelAudioLayer` continuity check changes from "same `musicTag`" to
"same `scene_id`". When `scene_id` matches the previously-playing
scene, the bed continues; the audio element is *not* paused, *not*
re-`load()`ed, and `currentTime` is preserved.

When `scene_id` differs, crossfade as today.

When the page route changes and the component unmounts, we lose
playback position. To preserve across page boundaries, hoist the music
`<audio>` element to a layout-level component (one level above the
page route) and have `PanelAudioLayer` read/write via context. This is
a small refactor — `MotionAudioProvider` mounted in
`src/app/layout.tsx`, `PanelAudioLayer` consumes it.

### Admin override

The Panel Review UI gets a "Music scene" column. Default shows the
auto-grouped scene name; clicking opens a dropdown of (a) extend
previous scene, (b) start new scene here, (c) merge with next scene.
Writes to `music_scenes` directly.

## Phasing

1. Schema migration — `music_scenes` table + `panels.scene_id` column,
   nullable on existing rows.
2. Backfill script — runs the grouping algorithm against existing
   panel data; writes scenes for tmnt-mmpr-iii.
3. Runtime: hoist music `<audio>` to layout-level provider; switch
   continuity check to `scene_id`.
4. Ingest: add `consolidate-music-scenes` step.
5. Admin UI: add scene-edit controls to Panel Review.

Phase 1+2+3 ship the user-visible fix without touching the ingest
pipeline. Steps 4+5 follow as a separate PR.

## Open questions

- **What counts as "exact resume" across page transitions?** The user
  flagged this as nice-to-have, not P0. Hoisting to layout-level
  preserves `currentTime` automatically. Cost is minor: the music
  element survives across all routes, so it'll keep playing if the
  user navigates to the home page mid-scene. We pause on
  `/book/...` route exit.
- **What if Gemini's mood tags are *too* uniform?** Inverse risk:
  every panel ends up in one giant scene. Add a max-scene-length
  guardrail (e.g. ≥ 10 consecutive panels triggers a manual review
  flag).
- **Music library coverage.** This work assumes a library entry for
  every canonical mood. Audit before ingesting the next book.

## Estimate

Half a day for steps 1–3 (the user-visible fix). Another half day for
4–5.
