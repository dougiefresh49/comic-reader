# Reply — testing session 2026-04-30

Going through your notes section-by-section. Where I shipped a fix
tonight, status block sits inline. Where the change is bigger and wants
a decision before I touch it, I wrote a spec and linked it. Where it's
purely a question, I answered.

---

## Non-page-specific feedback

### 1. Background music restarting per panel

**Status**: spec'd, not yet shipped. See
[specs/features/music-scenes.md](../specs/features/music-scenes.md).

The cause is in the data, not the playback layer. `PanelAudioLayer`
already has continuity logic — if `musicTag` is unchanged across
panels and `isNewScene` is false, it keeps the bed playing without
restarting. So music *should* persist when you walk through panels with
the same mood.

What's actually happening:

- Each panel gets its own `audio_tags.music_mood` value picked by
  Gemini. Even within a clearly-continuous action sequence, Gemini
  often returns slightly different moods per panel (`tense_action_a`
  vs `tense_action_b`), so the "same tag" check in `PanelAudioLayer`
  fires false on every step → crossfade → the bed retriggers.
- And/or `isNewScene` is over-flagged. Gemini biases toward marking
  every dramatic beat as a new scene.

The right fix isn't in the player — it's at ingest time. Group runs of
panels into **music scenes** so a single track is anchored to a panel
range, and the player only crossfades when crossing a scene boundary.
Crossing a page boundary should re-enter the same scene if the next
page's first panel is still in it (your "resume the track at the exact
spot" comment — agreed it's nice-to-have but I'd start with "continue
playing without restart" and worry about exact-resume later).

Spec covers the data model (`music_scenes` table + `panels.scene_id`
FK), the ingest step that consolidates per-panel moods into runs, and
the player change. ETA roughly half a day once you green-light the
spec.

### 2. Reading mode resets on page transition

**Status**: ✅ shipped tonight. See PR (will open when you wake up).

`panelViewMode` was local React state that died with the route on
every page nav. Lifted it into `useSettings` with localStorage backing,
so panel-by-panel mode survives the transition. Auto-play is *not*
auto-resumed because of browser autoplay restrictions — but you'll
land on the next page already in panel view, with the first panel
focused. One tap on Play continues. (If Chrome ever decides we have
"sufficient user engagement" it'll auto-play; we don't have to do
anything for that to start working.)

### 3. Panels out of order (issue 1 page 5)

**Status**: ✅ shipped runtime sort tonight; ingest-side fix specced.

The panel order comes from Gemini in the ingest pipeline (the order
Gemini emits is what gets persisted as `sort_order`). Gemini is mostly
right but mis-orders when panels share a row band. The runtime
comparator I added catches that without re-running the pipeline:

- Treat panels as belonging to a "row band" if their vertical centers
  fall within ~50% of either panel's height
- Sort same-row panels left-to-right, otherwise top-to-bottom

This stamps a stable reading order on what comes out of the DB and
also exposes a `panelOrder` admin override so you can hand-correct on
any page where the heuristic disagrees.

I considered putting this in the ingest pipeline instead so it lands
in `sort_order` permanently — the case for runtime is that we can fix
existing books without re-running ingest, and the comparator is cheap.
The case for ingest is single source of truth. I went with runtime now
+ a backfill script that can rewrite `sort_order` later if we want to
canonicalize.

For the page 5 specific bug: after the fix you should see panels in
the right order without any backfill. If not, the heuristic
misidentified the row band — drop the page in the admin Panel Review
UI and reorder by hand; takes 5 seconds.

### 4. Particle effects look wrong/clunky

Discussed inline below per screenshot, plus the SAM3 idea covered in
its own section.

### 5. Bottom settings / control panel is a mess

**Status**: spec'd, not yet shipped. See
[specs/features/reader-chrome-redesign.md](../specs/features/reader-chrome-redesign.md).

Looked at your Kindle reference shots. Key things they do that we
don't:

- Top bar holds *navigation* concerns (back, table of contents, nav
  controls). Bottom bar holds *progress*. Settings live behind a
  single "Aa" sheet that's pretty dense but contextual.
- The reading panel itself is **uncluttered** — they fade chrome away
  and re-show on tap. Our reader keeps the bottom bar permanently
  visible.
- "Guided View" entry/exit is via a top-right toggle, not a button
  squeezed into the bottom bar.

The redesign spec proposes:

- Move panel-view toggle, page navigation, and "back to library" to a
  top bar (auto-hides 3s after last interaction; tap to bring back).
- Bottom bar collapses to just the speech text + a thin progress
  indicator.
- Settings sheet stays where it is, but reorganized into three groups:
  Audio (volumes + speed), Reading (panel-view default, auto-advance,
  motion intensity), Diagnostics (downloaded indicator, version).

I want your sign-off before doing this — it's mostly UI churn and
worth getting the destination right.

---

## Page-specific feedback

### `screenshots/1.png` — Issue 1 page with action lines

You're right that the pinwheel placed in the middle is the wrong
choice for this panel. The current selection is per-panel: Gemini
picks an effect tag from `EFFECT_TAGS`, the player renders that effect
centered or full-panel. There's no spatial intent — Gemini is choosing
*what* effect, not *where*.

Two ways to fix:

1. **Cheap**: extend the effect tag schema to include a position hint
   (`top-left`, `top-right`, `center`, `full-panel`). Update the
   prompt to make Gemini pick. This is shallow but gets you "lines go
   in the upper-left where the actual lines are drawn."
2. **Right**: detect the action lines in the page art (Roboflow
   workflow → small model trained on action-line clusters) → ship the
   bbox to the player → render the effect in that bbox. More work,
   much better fit. Pairs naturally with the SAM3 segmentation idea
   below — the action-line detector and the character-mask detector
   live in the same workflow.

I'd combine these: ship the position hint in the next ingest pass to
unblock the immediate ugliness, then fold in the detected-bbox
approach when the segmentation work lands.

### `screenshots/2.0.png` + `2.1.png` + `2.2.png` — panel order

Already covered above (item 3). After the runtime sort fix, this page
should walk in the right sequence: 2.0 wide layout → 2.1 (top half +
middle row of action) → 2.2 (close-up of the dragon-Foot-Soldier
backed by red sigil). If it doesn't, the row-band heuristic missed
something on this page and we'll need a manual reorder via the admin
UI.

### `screenshots/3.png` — particle effects swallowing the page

This is the loud one and it's a layering problem, not a particle-tuning
problem. Right now the smoke + light-rays sit on top of *everything*,
including the characters and the bubbles, so a moderately dense effect
hides the panel. The fix lives in the SAM3 idea — see next section.

In the meantime, two stopgaps:

- Cap the opacity / particle density on smoke and the light-rays
  preset. We're rendering at the visual intensity that looks great on
  test panels but not on dense art like this one. A 50% opacity ceiling
  would get the cool effect without the "blurry mess."
- Disable smoke entirely on panels Gemini tagged as containing a
  primary character close-up. Easy heuristic; not perfect but cuts the
  worst cases.

Happy to ship the opacity cap immediately if you want — say the word.

---

## Ideas

### Roboflow SAM3 segmentation → particle layering

I read your conversation with the Roboflow agent and the
`character-cutouts.png` result. **That's a really good output for
zero-shot.** The chroma-key cutout has clean edges on characters, faces,
and bubbles with no obvious bleed.

Answers to your specific questions:

> **Is it something we could pull off?**

Yes, and I think this is the unlock for the layering problem on
`screenshots/3.png`. The hybrid approach the agent described is
correct: run SAM3 once per panel during ingest, save the polygon mask,
then the runtime composites:

```
[ background page art ]
     ↑ z-index 0
[ particle effects ]
     ↑ z-index 1
[ character + bubble mask layer ]
     ↑ z-index 2
```

The mask layer is the panel art with everything *outside* the mask
made transparent (the inverse of what their `character_cutouts` block
produced). Particles render between the two image layers and end up
behind the characters/bubbles automatically.

> **Is there another way?**

Theoretically we could do foreground extraction with a
`background-removal` style model, but SAM3's cleaner because it
specifically segments per-class (character vs bubble vs etc.) so we
get separate masks if we want different effects to layer differently
(e.g., smoke between bg and characters, but light-rays on top of
everything except bubbles).

> **Does this make character lookahead more possible now?**

Yes, materially. The "highest leverage" bullet in
[voice-cloning-and-ingest-lookahead.md](../specs/research/voice-cloning-and-ingest-lookahead.md)
was face detection + clustering. If SAM3 is already producing clean
face cutouts as a *side effect* of the segmentation we want for
particle layering, we get character lookahead for the cost of
embedding/clustering — no separate face detector training.

The flow becomes:

1. Roboflow workflow runs SAM3 + bubble + panel detectors per page
   (one API call).
2. We save: panel boxes, bubble boxes, character/face polygon masks.
3. Embed every face crop with CLIP. Cluster across the issue.
4. Identify clusters via wiki appearances list (cheap Gemini call —
   one per cluster).
5. Stamp `(page, panel, character_id)` rows from the cluster
   assignments. Speaker ID becomes "find the closest face to the
   bubble's tail," not "guess from the panel image."

This collapses a lot of the lookahead spec into a single ingest step
because SAM3 is pulling double duty.

> **Action lines / smoke-around-bubbles edge cases?**

Action lines: SAM3 won't reliably segment them because they're
high-frequency texture, not a "thing." Best path is a small Roboflow
detector trained specifically on action-line clusters — tens of labeled
examples, similar effort to your panel-detector. It returns bboxes,
not polygons; we just clip the effect to the bbox.

Smoke around bubbles: yes, this is the hard case. Bubbles are at
"infinity" in reading-order space — they're meta-elements that should
never be occluded. The mask-stack approach handles this naturally
because the bubble mask sits on top of everything, so smoke flowing
"around" a bubble works as long as we don't allow particles to spawn
inside the bubble mask. Add bubble-bbox exclusion to the particle
emitter and we're good.

I wrote this up in detail at
[specs/features/segmentation-layering.md](../specs/features/segmentation-layering.md)
with the Roboflow workflow output schema, the runtime composite
implementation, and a phasing plan that doesn't require pausing
existing ingest.

### Reverse-engineering the Kindle Mac app

Useful for inspiration but I'd push back gently on building toward
their exact model.

The Gemini summary at `docs/kindle/inspect-mac-app.md` is right that
Kindle's Guided View is metadata-driven (publisher-authored panel
coordinates baked into `.kfx` / Region Magnification). Their panels
land where they do because a person at the publisher drew the
rectangles. They have no AI in the reader.

What we should borrow:

1. **Smooth pan-and-zoom transitions.** Their Core Animation transition
   between panels feels great because of two things: physics-based
   easing (not linear) and *sub-frame* timing. We can match this with
   CSS transforms and a spring easing curve. No native code needed.
   Ten lines of Framer Motion or hand-rolled `requestAnimationFrame`
   with a critically-damped spring.
2. **Tighter panel crops.** Their guided view crops *exactly* to the
   panel bbox; ours pads with the page background visible. The
   tradeoff: tighter crop is more cinematic but loses bubbles that
   spill outside the panel rect (you can see this in
   `issue-05--page-03.02--guided-view-panel-with-bubbles-outside.png`
   — half a bubble is cut off). Our padded crop catches all bubbles
   but feels less focused.
3. **Auto-hiding chrome.** Already in the redesign spec.

What we should *not* try to copy:

- Reverse-engineering the binary for transition math. The CSS
  spring-easing approach gives equivalent smoothness in 1% of the
  effort.
- Their metadata-first model. Our value-add over Kindle is that you
  *don't* need a publisher to author panel coordinates — Gemini +
  Roboflow do it. Switching to manual authoring would be a regression.

Concrete thing I can ship this week: rewrite the panel transition to
use a spring curve instead of the current linear `ease-out`. The
codepath is small (`PanelView.transforms.ts` and the transform on
`PanelViewFrame`). Will make navigation feel materially better. Want
me to do that next?

---

## What I'm doing tonight while you sleep

Already committed to the branch:

1. ✅ `panelViewMode` persistence across page transitions (item 2)
2. ✅ Runtime panel reading-order sort + admin override hook (item 3)

Specs written, awaiting your sign-off:

3. `specs/features/music-scenes.md` — fix for music restart (item 1)
4. `specs/features/segmentation-layering.md` — SAM3 particle layering
   (Ideas section)
5. `specs/features/reader-chrome-redesign.md` — Kindle-inspired chrome
   cleanup (item 5)

Things I am *not* doing without your call:

- Anything in `specs/features/reader-chrome-redesign.md` (UI churn)
- Anything that requires re-running ingest (so ingest-side panel
  ordering stays specced; runtime sort handles the user-visible bug)
- Stopgap opacity caps on particle effects — easy 5-min change but I'd
  rather wait for the SAM3 layering than land tuning that gets
  overwritten

Reply when you can; in the meantime the repo's ready for you to merge
the two completed fixes.
