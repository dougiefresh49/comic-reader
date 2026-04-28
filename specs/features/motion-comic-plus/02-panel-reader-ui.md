# Panel Reader UI

## Status: `pending`
## Goal: Kindle-style double-tap to enter "panel view," swipe between panels, exit back to full page

---

## Behavior

### Default mode — full-page reader (today's experience)
The page is shown at `object-contain` inside the reader frame. Tapping a bubble plays its audio with karaoke. Nothing changes here.

### Panel view mode (new)
1. **Enter:** double-tap anywhere on the page, OR tap a "Panel View" button in the bottom HUD
2. The page transforms (CSS) to zoom and pan onto the first panel. Other panels are hidden behind a subtle dim overlay.
3. **Advance / retreat:** swipe-left / swipe-right (touch), arrow keys (desktop), or HUD buttons. Each transition animates the transform to the next panel's `boundingBox`.
4. **Auto-play:** an optional toggle plays the panel's bubbles (and audio layers — spec 04) on entry, then auto-advances after `estimatedDurationSeconds` elapses. Pause/resume controls in the HUD.
5. **Exit:** double-tap, ESC, pinch-out, or HUD button → animates back to full-page mode.

### What gets shown
While in panel view:
- The full-page image stays in DOM but is `transform: scale(...) translate(...)` to put the active panel's bbox center at the viewport center
- Other panels are dimmed via a CSS mask layer (`mask-image`) cut out around the active panel's bbox — gives the focused-spotlight feel without cropping
- Bubbles within the active panel remain tappable; bubbles outside it are filtered out of the overlay layer

---

## Component sketch

```
src/components/zen-comic-reader/
├── ZenComicReader.tsx                # existing — adds <PanelView/>
├── PanelView.tsx                     # new
├── PanelView.transforms.ts           # new — math for boundingBox → CSS transform
├── usePanelNavigation.ts             # new hook — panel index state + gestures
└── ...
```

### Math

Given:
- `containerWidth`, `containerHeight` (viewport)
- `boundingBox: { x, y, w, h }` (fractions of page)
- `pageNaturalWidth`, `pageNaturalHeight` from the loaded `<img>`

Compute the CSS transform that scales the page so the panel fills (with margin) the container, and translates so the panel's center hits the container's center:

```ts
function panelTransform(
  panel: BoundingBox,
  container: { w: number; h: number },
  page: { w: number; h: number },
  margin = 0.05,
): { scale: number; tx: number; ty: number } {
  const panelW = panel.w * page.w;
  const panelH = panel.h * page.h;
  const targetW = container.w * (1 - margin * 2);
  const targetH = container.h * (1 - margin * 2);
  const scale = Math.min(targetW / panelW, targetH / panelH);

  const panelCenterX = (panel.x + panel.w / 2) * page.w;
  const panelCenterY = (panel.y + panel.h / 2) * page.h;
  const tx = container.w / 2 - panelCenterX * scale;
  const ty = container.h / 2 - panelCenterY * scale;

  return { scale, tx, ty };
}
```

Apply via:
```css
.page-image-layer {
  transform: translate(var(--tx)) translate(var(--ty)) scale(var(--scale));
  transform-origin: 0 0;
  transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

Animation eases into each panel for a comic-feel "camera move." `380ms` and the easing curve are tuned for "snappy but readable"; expose as constants.

---

## Gesture handling

Use lightweight gesture library or hand-roll:
- Touch swipe: pointer events, threshold ~60px horizontal travel < 400ms
- Mouse wheel horizontal: also advances/retreats (trackpad swipes)
- Arrow keys: ←/→ panel nav, ESC exits, Space toggles auto-play

Recommended: `@use-gesture/react` (free, MIT). ~5 KB gz. Already plays nice with React 19.

---

## Bubbles inside panels

The current `BubbleOverlay` renders all bubbles for the page. In panel view we filter to bubbles whose center falls inside the active panel's `boundingBox`. They retain their existing `style.left/top/width/height` (% of page) — when the page is scaled by the transform, the absolutely-positioned bubbles scale with it for free.

Karaoke highlight continues to work unchanged because the bubble component just keys off the audio time.

---

## HUD updates

Below the page, add a panel-view-specific HUD when `panelViewMode === true`:

```
[ × close ]   panel 3 of 11   [ ⏯ play ]   [ ‹ prev ]   [ next › ]
```

Add a thin progress bar showing position within the page's panels.

---

## Accessibility

- ARIA-live region announces panel transitions ("Panel 3 of 11. {primarySpeaker} speaks: {first bubble OCR}")
- `prefers-reduced-motion: reduce` → swap CSS transitions for instant transforms
- Keyboard nav (ESC / arrows / space) covers all gestures
- Focus management: when entering panel view, focus moves to the panel container; when exiting, returns to the originating page element

---

## Acceptance test

- On TMNT × MMPR III issue 1 page 3, double-tap enters panel view focused on the top vortex panel
- Swipe-left advances through the kraash panel and the three small bottom panels in reading order
- Auto-play mode plays each bubble's audio in sequence, including narration captions, then advances
- ESC returns to full-page mode at the same scroll position
- All bubbles remain tappable in panel view; bubbles outside the active panel don't fire when tapped through the dim overlay

---

## What this doesn't include

- Effects (motion lines, particles, music) — those layer in via spec 03 and 04
- MP4 export — spec 05
- Editing / overriding panel bounds — manual edit of `panel-direction.json` is the v1 escape hatch; a proper UI editor is later
