# Scene Editor — review UI for music scene grouping

**Status**: `pending` — needs user review of UX approach

---

## Problem

The auto-consolidation pipeline groups consecutive same-mood panels into `music_scenes` rows, but the grouping is often wrong:

- Gemini tags adjacent panels with slightly different moods (`tense_action_a` vs `tense_action_b`), splitting what should be one scene into two.
- Some pages (e.g., issue 1 pg 03) are a single continuous scene across all panels, but the pipeline creates multiple scenes because mood tags drift.
- There's no way to fix this without re-running the pipeline or editing the DB directly.

The panel review UI currently shows per-panel `music_mood` dropdown and `isNewScene` checkbox, but no scene-level view.

---

## Goal

A review UI layer — similar to the bubble↔panel assignment pattern — where the user can see, create, merge, split, and edit music scenes across an issue's panels.

---

## UX Concept: Scene Lane

A horizontal "scene lane" sits above (or beside) the panel list in the panel review page. Each scene is a colored block spanning its panels.

### Layout

```
┌─────────────────────────────────────────────────┐
│  SCENES                                         │
│  ┌──────────────┐ ┌────────┐ ┌────────────────┐ │
│  │ tense_action │ │ calm   │ │ heroic_triumph │ │
│  │ panels 1–4   │ │ 5–6    │ │ 7–12           │ │
│  └──────────────┘ └────────┘ └────────────────┘ │
├─────────────────────────────────────────────────┤
│  PANELS  (existing panel card list)             │
│  [1] [2] [3] [4] [5] [6] [7] [8] [9]...        │
└─────────────────────────────────────────────────┘
```

### Interactions

**Select a scene** — click a scene block to select it. Selected scene highlights, and its panels are visually marked in the panel list below.

**Edit scene properties** — selecting a scene opens an inline editor (or sidebar) with:
- **Mood** — dropdown of available moods from the audio library
- **Label** — optional human-readable name (e.g., "Opening fight")
- **Panel range** — shows start/end panels (read-only, changed via merge/split)

**Merge scenes** — select two adjacent scenes → "Merge" button combines them into one, keeping the mood of the first (editable after merge).

**Split scene** — click a panel within a selected scene → "Split here" creates two scenes at that boundary.

**Reassign panel** — similar to bubble↔panel: click a panel, then choose which scene it belongs to. Scenes must remain contiguous (no gaps, no panel in two scenes).

**Create scene** — if unassigned panels exist (shouldn't normally happen), select them and hit "New scene."

**Auto-consolidate** — "Re-run auto" button re-runs the consolidation algorithm on the current data without touching the pipeline. Useful as a reset.

---

## Data Flow

### Read

```
GET panels (ordered by page_number, sort_order) with scene_id populated
GET music_scenes for this issue
```

### Write

All edits are local state until "Save." On save, a server action:
1. Deletes existing `music_scenes` for the issue
2. Inserts new scene rows
3. Updates `panels.scene_id` for all panels
4. Optionally updates `panels.is_new_scene` to match scene boundaries

This is the same "batch save" pattern as the panel review page.

---

## Components

| Component | Role |
|-----------|------|
| `SceneLane` | Horizontal bar of colored scene blocks. Each block is clickable. |
| `SceneEditor` | Inline editor for the selected scene (mood dropdown, label input). |
| `SceneActions` | Merge / Split / Re-run auto buttons. Context-dependent on selection. |

These compose into the existing `PanelsReviewClient` page, either as a new section above the panel list or as a tab.

---

## DB Changes

None — `music_scenes` table and `panels.scene_id` already exist. The server action just needs a `saveScenes` function.

---

## Server Action

```typescript
// src/server/actions/review/scenes.ts
export async function saveScenes(
  bookId: string,
  issueId: string,
  scenes: Array<{
    musicMood: string;
    label: string | null;
    panelIds: string[];  // ordered
  }>
)
```

Deletes old scenes → inserts new → bulk-updates `panels.scene_id`.

---

## Open Questions

1. **Where does this live?** Option A: new tab in the panel review page. Option B: dedicated `/admin/{bookId}/{issueId}/review/scenes` route. Option C: inline section in the existing panel review page (above the panel cards). Leaning toward C since scenes and panels are tightly coupled.

2. **Cross-page continuity.** The scene lane should show ALL panels across ALL pages for the issue (not just the current page), since scenes can span page boundaries. This is different from the panel review which is per-page. Might need a separate "issue-wide" view.

3. **Audio preview.** Should clicking a scene play the associated mood track? Nice-to-have but not required for v1.

4. **Visual encoding.** Color-code scenes by mood category? Or just alternate colors for visual separation?

---

## Estimate

- Server action + data loading: 2 hours
- SceneLane + SceneEditor components: 4 hours  
- Integration into panel review page: 2 hours
- Testing / polish: 2 hours

~1.5 days total
