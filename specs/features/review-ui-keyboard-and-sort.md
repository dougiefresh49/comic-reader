# Feature: Review UI — Keyboard Shortcuts, Speaker UX & Sort Order

## Status: `pending`
## Prerequisite: Review UI Phase A (`done`)
## Blocked by: Nothing

---

## Purpose

Three focused improvements to the review interface to reduce friction during correction passes:

1. **Keyboard-driven navigation and editing** — navigate pages and bubbles, add bubbles, and fill fields without touching the mouse.
2. **Sort order editing** — drag bubbles in the sidebar list to fix reading order, exported as a `reorder` action in `fixes.json`.
3. **Character list caching fix** — speaker `<datalist>` was rebuilding on every render, causing flicker and intermittent empty states.

---

## 1. Keyboard Shortcuts

### Already implemented (do not re-implement)
| Key | Action |
|-----|--------|
| `←` / `→` | Prev / next page |
| `Escape` | Deselect bubble / cancel draw mode |
| `Delete` / `Backspace` | Delete selected bubble |

### New shortcuts to add

All shortcuts are **suppressed when focus is inside any `<input>`, `<textarea>`, or `<select>`** — the existing guard in `ReviewLayout` already does this, extend it for the new keys.

| Key | Action |
|-----|--------|
| `a` | Toggle draw mode (same as clicking `+ Add Bubble`) |
| `Tab` | Select next bubble in reading order on current page; wraps around |
| `Shift+Tab` | Select previous bubble in reading order |
| `Enter` | When a bubble is selected and focus is NOT in a form field: focus the speaker input |

#### Implementation notes

- `Tab` / `Shift+Tab` during bubble-list navigation: prevent default to avoid browser tab behaviour. Only intercept when focus is outside a form field.
- Track `localBubbles` index for Tab cycling. Skip `deleted` bubbles.
- When Tab selects a bubble, scroll the bubble list item into view (the sidebar list).

---

## 2. Speaker Input UX

### Auto-focus speaker on bubble select

When `selectedId` changes to a non-null value (i.e., a bubble is selected), automatically focus the speaker `<input>` in the sidebar.

- Use a `ref` on the speaker input. Call `.focus()` + `.select()` in a `useEffect` that fires when `selectedId` changes.
- The `<input>` currently uses `list="speaker-list"` (a `<datalist>`). The native datalist dropdown opens automatically when the input is focused and has a value — no extra work needed for the dropdown to appear.
- If the user dismisses by pressing `Escape` while focused on the speaker input, do **not** propagate to the layout-level Escape handler (which would deselect the bubble). Stop propagation on the input's `onKeyDown`.

### Tab order within the editing panel

The sidebar form fields should tab in this order:
1. Speaker input
2. Emotion input
3. Type radio group (the first radio button)
4. OCR Text textarea
5. textWithCues textarea

Achieve this with explicit `tabIndex` values on each field, or by making sure the DOM order matches the desired tab order and no field has `tabIndex="-1"`. The AI Reasoning section is read-only and collapsible — exclude it from tab order (`tabIndex={-1}` on the textarea inside it).

When tabbing from the last form field (textWithCues), focus should return to the speaker input of the **next bubble** in reading order — i.e., Tab past the last field advances to the next bubble and focuses its speaker input. Implement this by trapping the Tab key on the last field:

```ts
// on textWithCues onKeyDown:
if (e.key === 'Tab' && !e.shiftKey) {
  e.preventDefault();
  advanceToNextBubble(); // select next bubble → triggers auto-focus of speaker
}
```

---

## 3. Character List Caching Fix

### Root cause

The `characters` prop is a `string[]` built server-side. It is stable across renders of `ReviewLayout`. However, the `<datalist>` inside `BubbleSidebar` (and the `BubblePanel` within it) is recreated from props on every render because it maps over the array inline. When `BubbleSidebar` re-renders (e.g., on any field change), the datalist briefly unmounts/remounts, causing the native autocomplete to reset mid-type.

### Fix

Memoize the datalist element or the options array so it only changes when the `characters` array reference changes:

```tsx
// In BubbleSidebar / BubblePanel
const speakerOptions = useMemo(
  () => characters.map((c) => <option key={c} value={c} />),
  [characters],
);

// Then in JSX:
<datalist id="speaker-list">{speakerOptions}</datalist>
```

The `characters` array reference is stable (passed from the server component once), so `useMemo` will only run once per mount. This eliminates the flicker.

---

## 4. Sort Order Editing

### UI — drag to reorder in the bubble list

The bubble list in the sidebar (currently a static ordered list) becomes drag-and-drop reorderable.

**Interaction:**
- Each row has a drag handle icon (`⠿` or `≡`) on the left.
- Drag the handle to reorder the row within the list.
- The page overlay updates in real time — bubble numbers renumber as you drag.
- A reorder is only recorded as an edit if the final order differs from the original.
- Reordering is **per-page** — you cannot drag a bubble to a different page.

**Visual:**
- Dragging row: slight opacity reduction + lift shadow.
- Drop target row: cyan top/bottom border to indicate insertion point.

**Implementation:**
Use the HTML5 Drag and Drop API or `@dnd-kit/sortable` (already common in Next.js apps). Prefer `@dnd-kit/sortable` — it handles touch, keyboard (for accessibility), and avoids the jank of native drag-and-drop on cross-browser.

```
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Use `SortableContext` with `verticalListSortingStrategy` around the bubble list rows. Each row is a `useSortable` item keyed by bubble ID.

Only expose the drag handle, not the entire row, as the drag trigger (`listeners` from `useSortable` attached to the handle element only).

### State

The local sort order is stored separately from `edits` to avoid conflating field changes with order changes. Add a `pageOrder` map to `useReviewEdits`:

```ts
// In useReviewEdits state
pageOrder: Record<number, string[]>;  // pageNum → ordered bubble IDs
```

- Initialized as `null` / absent per page (meaning: use original order from `bubbles.json`).
- Set when the user reorders. Persisted to IndexedDB alongside `edits`.
- When `pageOrder[currentPage]` exists, `localBubbles` is sorted to match it before rendering.
- Deleted from state if the user drags back to the original order (no-op edit pruning).

### Export — `fixes.json` extension

Add a new action type `"reorder"` to the fixes schema:

```json
{
  "bubbleId": "__page-reorder__",
  "action": "reorder",
  "pageIndex": 3,
  "orderedIds": ["page-03_b02", "page-03_b01", "page-03_b03", "..."]
}
```

`bubbleId` is the sentinel string `"__page-reorder__"` (it doesn't reference a real bubble; `pageIndex` identifies the page).

### Script — `apply-fixes.ts` extension

Handle `"reorder"` action:

```ts
case "reorder": {
  const pageKey = `page-${String(fix.pageIndex).padStart(2, "0")}.jpg`;
  const original = cache[pageKey] ?? [];
  const idToIndex = new Map(fix.orderedIds.map((id, i) => [id, i]));
  cache[pageKey] = [...original].sort((a, b) => {
    const ai = idToIndex.get(a.id) ?? Infinity;
    const bi = idToIndex.get(b.id) ?? Infinity;
    return ai - bi;
  });
  break;
}
```

Bubbles not in `orderedIds` (e.g., newly-added ones not yet in the sort) sort to the end.

---

## Implementation Steps

1. **Character list caching** — `BubbleSidebar.tsx`: wrap datalist options in `useMemo`. Quick win, do this first.

2. **`'a'` shortcut** — `ReviewLayout.tsx`: add `'a'` case to the existing keydown handler; call `setDrawMode(v => !v)`.

3. **Tab bubble navigation** — `ReviewLayout.tsx`: intercept `Tab` / `Shift+Tab` outside form fields; cycle through `localBubbles` by index; call `setSelectedId`.

4. **Speaker auto-focus** — `BubbleSidebar.tsx` or `BubblePanel` sub-component: add `speakerRef`, `useEffect` on `bubble?.id` change → `.focus()` + `.select()`. Add `onKeyDown` Escape guard.

5. **Tab order within form** — `BubbleSidebar.tsx`: set explicit `tabIndex` ordering; add Tab trap on textWithCues to advance to next bubble.

6. **Sort order state** — `useReviewEdits.ts`: add `pageOrder` to state shape and IndexedDB persistence; expose `setPageOrder(pageNum, ids)` and `getPageOrder(pageNum)`.

7. **Bubble list drag-and-drop** — `BubbleSidebar.tsx`:
   - Install `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
   - Wrap bubble list in `DndContext` + `SortableContext`
   - Each row becomes a `useSortable` item
   - `onDragEnd` → call `setPageOrder` if order changed

8. **`localBubbles` sort in ReviewLayout** — after merging edits, apply `pageOrder` if set for current page.

9. **Export** — `buildFixesJson` in `useReviewEdits.ts`: for each page in `pageOrder`, append a `reorder` fix entry if the order differs from original.

10. **`apply-fixes.ts`** — add `"reorder"` case as described above.

---

## Key Files to Read Before Implementing

| File | Why |
|------|-----|
| `src/components/review/ReviewLayout.tsx` | Existing keyboard handler, page nav, selectedId state |
| `src/components/review/BubbleSidebar.tsx` | Speaker input, bubble list, form field layout |
| `src/hooks/useReviewEdits.ts` | Edit state shape, IndexedDB persistence, `buildFixesJson` |
| `scripts/apply-fixes.ts` | Current fix action handling — add `reorder` case |

---

## Verification

```bash
pnpm dev
# /comic/tmnt-mmpr-iii/issue-1/review

# Keyboard:
# - Press 'a' outside a text field → draw mode activates
# - Press Tab → next bubble selected, speaker input focused
# - Press Shift+Tab → previous bubble selected
# - While in speaker input, Tab → moves to emotion field
# - Tab through all fields → wraps to next bubble's speaker
# - Select a bubble, press Enter → speaker input focused
# - Speaker input focused, press Escape → stays selected, focus leaves input (does NOT deselect bubble)

# Speaker autocomplete:
# - Select bubble → speaker input focused immediately
# - Type partial name → datalist suggestions appear and stay stable

# Sort order:
# - Drag bubble row handle → order updates live on page overlay
# - Export fixes.json → contains "reorder" entry for reordered pages
# - pnpm apply-fixes → bubbles.json reflects new order

pnpm typecheck
```
