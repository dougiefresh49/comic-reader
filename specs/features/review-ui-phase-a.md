# Feature: Review UI — Phase A (Annotation)

## Status: `pending`
## Prerequisite: None — build now
## Blocked by: Nothing

---

## Purpose

A desktop-focused review interface at `/comic/[bookId]/[issueId]/review` for manually correcting speech bubble data before publishing an issue. Catch speaker mismatches, fix OCR errors, adjust bounding boxes, and add missed bubbles — all in one place.

Phase A is annotation only. All edits are stored client-side (IndexedDB) and exported as `fixes.json` for local processing. Nothing writes to disk during review.

Phase B (live in-browser regeneration) is a separate spec — see `review-ui-phase-b.md`. Do not implement Phase B as part of this.

---

## Route

```
/comic/[bookId]/[issueId]/review
/comic/[bookId]/[issueId]/review?page=3   ← deep-link to specific page
```

New file: `src/app/book/[bookId]/[issueId]/review/page.tsx`

The existing reader route is `src/app/book/[bookId]/[issueId]/[pageNumber]/page.tsx` — the review route sits alongside it at the issue level.

---

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER: [← Back to reader]  Book / Issue  [Export Fixes] [●12] │
├─────────────────────────────────────┬───────────────────────────┤
│                                     │  SIDEBAR                  │
│  COMIC PAGE                         │                           │
│  (left ~65% of viewport)            │  Selected Bubble Panel    │
│                                     │  (right ~35% of viewport) │
│  Bubble overlays rendered on top    │                           │
│  of the page image.                 │  — Speaker                │
│  Clicking a bubble selects it       │  — Emotion                │
│  and loads it in the sidebar.       │  — Type                   │
│                                     │  — Text                   │
│  Selected bubble:                   │  — textWithCues           │
│  - cyan outline + glow              │  — AI Reasoning           │
│  - drag handles on corners/edges    │  — Actions                │
│    to resize bounding box           │                           │
│  - drag bubble body to reposition   │  ──────────────────────   │
│                                     │  BUBBLE LIST              │
│  Draw mode:                         │  (all bubbles this page,  │
│  - click + drag on page             │   ordered by reading idx) │
│  - creates new bubble               │                           │
│    → opens in sidebar               │                           │
├─────────────────────────────────────┴───────────────────────────┤
│  FOOTER: [◀ Prev Page]  Page 3 / 22  [Next Page ▶]             │
│          [+ Add Bubble] [Delete Selected] [Undo]                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Bubble Overlay

Each bubble rendered as an absolute-positioned `<div>` over the page image using `%`-based coordinates from `style` in `bubbles.json`.

**Visual states:**

| State | Style |
|-------|-------|
| Default | Faint translucent fill, subtle border — always visible in review mode |
| Hover | Brighter border |
| Selected | Cyan outline + glow + resize handles |
| Modified (unsaved) | Amber tint — pending change |
| Marked for redo | Red outline |

---

## Sidebar — Selected Bubble Panel

```
┌─────────────────────────────────┐
│  Bubble #7  [Mark for Redo ✕]  │
├─────────────────────────────────┤
│  Speaker                        │
│  [Raphael            ▼]         │  ← dropdown of known characters + free text
│                                 │
│  Emotion                        │
│  [Angry              ▼]         │  ← dropdown of common emotions + free text
│                                 │
│  Type                           │
│  ● SPEECH  ○ NARRATION  ○ SFX  │
│                                 │
│  Text (OCR)                     │
│  ┌─────────────────────────┐   │
│  │ editable textarea       │   │
│  └─────────────────────────┘   │
│                                 │
│  textWithCues                   │
│  ┌─────────────────────────┐   │
│  │ editable textarea       │   │
│  └─────────────────────────┘   │
│                                 │
│  AI Reasoning                   │
│  ┌─────────────────────────┐   │
│  │ read-only, collapsible  │   │
│  └─────────────────────────┘   │
│                                 │
│  Bounding Box (% coords)        │
│  x: 12.3  y: 44.1              │
│  w: 18.5  h: 9.2               │  ← updates live as handles are dragged
│                                 │
│  [Phase B buttons — grayed out] │
│  [↻ Re-run Gemini Context]      │
│  [🔊 Re-generate Audio]         │
└─────────────────────────────────┘
```

**Character dropdown** populates from all known characters in `castlist.json` / `bubbles.json` for this issue, with free-text fallback for new characters.

---

## Bounds Editing

When a bubble is selected, render 8 drag handles (4 corners + 4 edge midpoints) on the overlay border.

- **Drag corner** → resize from that corner
- **Drag edge** → resize along that axis only
- **Drag bubble body** → reposition without resizing
- Coordinates update live; sidebar shows updated % values in real time

Use pointer events (`onPointerDown`, `onPointerMove`, `onPointerUp`). Store delta as percentage of container dimensions.

---

## Add New Bubble (Draw Mode)

1. `[+ Add Bubble]` button activates draw mode — cursor becomes crosshair
2. Click + drag on page to define bounding box
3. On pointer up: new bubble created with empty fields, auto-selected in sidebar
4. User fills in Speaker, Type, Text
5. Press Enter or click "Save" to confirm — bubble added to local state with temp ID (`new-001`, etc.)
6. Escape or click outside cancels

---

## Delete Bubble

`[Delete Selected]` in footer — only active when a bubble is selected. Marks bubble deleted in local state, overlay disappears. Shows undo toast for 5 seconds.

---

## Undo

Single-level undo (`[Undo]` button). Reverts the last action (field edit, move, resize, add, delete).

---

## Local State (IndexedDB)

All edits stored under key `review-edits-<bookId>-<issueId>`.

```ts
type ReviewEdit = {
  bubbleId: string;           // existing ID or "new-001"
  action: "update" | "delete" | "add";
  changes: Partial<Bubble>;
  timestamp: number;
};
```

- Survives page refresh
- Header badge shows pending edit count: `[Export Fixes] ●12`
- Edits reload automatically on revisit
- "Clear all edits" in overflow menu

---

## Export Fixes

`[Export Fixes]` button — active when there are pending edits.

Generates `fixes.json` compatible with `pnpm apply-fixes`:

```json
{
  "bookId": "tmnt-mmpr-iii",
  "issueId": "issue-1",
  "fixes": [
    {
      "bubbleId": "page-03-bubble-007",
      "action": "update",
      "changes": { "speaker": "Raphael", "emotion": "Angry" }
    },
    {
      "bubbleId": "page-05-bubble-002",
      "action": "update",
      "changes": {
        "bounds": { "x": 0.123, "y": 0.441, "width": 0.185, "height": 0.092 }
      }
    },
    {
      "bubbleId": "new-001",
      "action": "add",
      "pageIndex": 5,
      "data": {
        "speaker": "Leonardo",
        "emotion": "Calm",
        "type": "SPEECH",
        "text": "Hang on.",
        "bounds": { "x": 0.55, "y": 0.12, "width": 0.20, "height": 0.08 }
      }
    }
  ]
}
```

Downloads as `fixes-<bookId>-<issueId>-<timestamp>.json`. After export: "Clear saved edits? [Keep / Clear]"

---

## Bubble List (Sidebar Bottom)

Scrollable list of all bubbles on current page, reading order:

```
#1  ZORDON          "...BUT you stopped Warbunny..."  ✓
#2  NARRATOR        "THE COMMAND CENTER..."            ✓
#3  RAPHAEL         "But it's not that simple..."      ● modified
#4  [unassigned]    "OUR ENEMIES MAY HAVE..."          ✕ redo
```

Click any row to select that bubble on the page and load it in the panel above.

---

## Page Navigation

Footer prev/next controls. Preserves sidebar state (collapses if no bubble selected on new page).

**Keyboard shortcuts:**
- `←` / `→` — prev/next page
- `Escape` — deselect bubble / cancel draw mode
- `Delete` — delete selected bubble

---

## Implementation Steps

1. Create `src/app/book/[bookId]/[issueId]/review/page.tsx`
2. Create `src/components/review/ReviewLayout.tsx` — two-column shell
3. Create `src/components/review/BubbleOverlay.tsx` — overlay + selection
4. Create `src/components/review/BoundsEditor.tsx` — drag handles
5. Create `src/components/review/DrawMode.tsx` — click+drag new bubble
6. Create `src/components/review/BubbleSidebar.tsx` — detail panel + bubble list
7. Create `src/hooks/useReviewEdits.ts` — IndexedDB read/write
8. Create `src/hooks/useBoundsEditor.ts` — pointer event math for resize/reposition
9. Wire export button → generate + download `fixes.json`
10. Update `scripts/apply-fixes.ts` to handle `"action": "add"` for new bubbles (currently only handles `"update"`)

## Key Files to Read Before Implementing

- `src/types/comic.ts` — `Bubble` type, coordinate system
- `src/components/zen-comic-reader/` — existing bubble overlay patterns to reuse
- `scripts/repair-cues.ts` — textWithCues format reference
- `scripts/apply-fixes.ts` — current fixes.json schema to stay compatible

## Verification

```bash
pnpm dev
# /comic/tmnt-mmpr-iii/issue-1/review
# - Bubbles visible as overlays on page
# - Click bubble → loads in sidebar
# - Edit speaker → amber tint on bubble
# - Drag handle → bounding box updates live
# - Draw mode → new bubble created, fills in sidebar
# - Export → fixes.json downloads with correct schema
# pnpm apply-fixes → verify changes applied to bubbles.json
pnpm typecheck && pnpm lint
```
