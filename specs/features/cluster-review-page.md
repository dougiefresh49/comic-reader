# Cluster Review Page — Implementation Plan

## Context

The ingest pipeline's first human review pause point ("review-clusters") currently shows a stub page with no data. The `characterLookaheadPage` workflow step detects faces, identifies them via Gemini + pgvector exemplar matching, and writes to `panel_character_detections` and `character_face_exemplars`. But the review UI doesn't query or display any of this — the user would be approving blind.

This plan builds the full cluster review UI so the user can see face detections grouped by character, fix misidentifications, reject false positives, and confirm correct IDs before the pipeline continues.

---

## Data Available

**`panel_character_detections`**: id, character_id (nullable), suggested_name (nullable), panel_id (FK panels), face_bbox (jsonb), identification_confidence, human_verified, cluster_id

**`character_face_exemplars`**: id, character_id (nullable), suggested_name (nullable), book_id, source_issue, page_number, crop_path, confidence, is_confirmed, embedding (vector 768)

**Face crops**: public bucket `face-exemplars` at `{bookId}/{sourceIssue}/{charId|_unresolved}/{uuid}.jpg`. Public URL: `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/face-exemplars/${crop_path}`.

**Key constraint**: No direct FK between detections and exemplars. They share `(character_id OR suggested_name)` + `(book_id, source_issue)`. A detection at 0.6-0.69 confidence has no exemplar (no crop to show). Only ≥0.7 confidence faces have stored crops.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/app/admin/[bookId]/[issueId]/review/clusters/page.tsx` | Rewrite (server component with data fetching) |
| `src/app/admin/[bookId]/[issueId]/review/clusters/ClusterReviewClient.tsx` | New (client component) |
| `src/app/admin/[bookId]/[issueId]/review/clusters/actions.ts` | New (server actions) |
| `src/app/admin/[bookId]/[issueId]/review/clusters/ApproveClusterButton.tsx` | Modify (add `disabled` prop) |

**Reference files** (patterns to follow):
- `src/app/admin/[bookId]/[issueId]/review/new-characters/page.tsx` — server component pattern
- `src/app/admin/[bookId]/[issueId]/review/new-characters/NewCharactersReviewClient.tsx` — client state + optimistic updates
- `src/app/admin/[bookId]/[issueId]/review/new-characters/actions.ts` — server action pattern
- `src/lib/supabase-admin.ts` — admin Supabase client

---

## 1. Server Component (`page.tsx`)

Parallel fetch via `Promise.all()`:

**Query A** — All detections for this issue:
```
panels (book_id, issue_id) → get panel IDs
panel_character_detections (panel_id in panelIds) → all detections
```

**Query B** — All exemplars for this issue:
```
character_face_exemplars (book_id, source_issue) → all exemplars with crop_path
```

**Query C** — Known characters for rename/assign dropdown:
```
characters (book_id) → id, name
```

**Server-side grouping** (before passing to client):
1. Match detections to exemplars by `(character_id)` or `(suggested_name)` + `page_number` proximity
2. Group into clusters by `character_id` (resolved) or `suggested_name` (unresolved)
3. Build public crop URLs from `crop_path`
4. Sort: resolved clusters alphabetically, then unresolved

**Data shape to client**:
```ts
interface ClusterFace {
  detectionId: string;
  exemplarId: string | null;
  cropUrl: string | null;         // null if no exemplar (0.6-0.69 confidence)
  confidence: number;
  humanVerified: boolean;
  isConfirmed: boolean;
  pageNumber: number;             // from exemplar or derived from panel
  panelId: string;
  faceBbox: { x: number; y: number; w: number; h: number };
}

interface CharacterCluster {
  key: string;                    // character_id or `unresolved:${suggestedName}`
  characterId: string | null;
  suggestedName: string | null;
  label: string;                  // display name
  faces: ClusterFace[];
  isResolved: boolean;
}
```

---

## 2. Client Component (`ClusterReviewClient.tsx`)

**State**:
- `clusters` — mutable cluster array (optimistic updates)
- `selectedFaces` — `Map<string, Set<string>>` (clusterKey → detectionIds)
- `pending` via `useTransition`
- `msg` for error/success banner

**Layout**:

```
┌─ Stats Bar ──────────────────────────────────────────────┐
│ Total: 47 faces │ Resolved: 38 │ Unresolved: 9          │
└──────────────────────────────────────────────────────────┘

┌─ Unresolved Faces (9) ── amber border ──────────────────┐
│ ┌─ "Tommy" (suggested) ── 4 faces ────────────────────┐ │
│ │ [crop] [crop] [crop] [crop]                         │ │
│ │ [Assign to Character ▾]  [Reject Selected]          │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─ "Unknown soldier" (suggested) ── 5 faces ──────────┐ │
│ │ [crop] [crop] [crop] [crop] [crop]                  │ │
│ │ [Assign to Character ▾]  [Reject Selected]          │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

┌─ Resolved Characters (38 faces) ────────────────────────┐
│ ┌─ green-ranger ── 12 faces ── avg 0.87 ──────────────┐ │
│ │ [crop] [crop] [crop] [crop] [crop] [crop] ...       │ │
│ │ [✓ Confirm All]  [Rename ▾]  [Reject Selected]     │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─ shredder ── 8 faces ── avg 0.91 ── ✓ confirmed ───┐ │
│ │ [crop] [crop] [crop] [crop] ...                     │ │
│ └─────────────────────────────────────────────────────┘ │
│ ...                                                      │
└──────────────────────────────────────────────────────────┘

┌─ Footer ─────────────────────────────────────────────────┐
│ ← Back to pipeline          [Approve & Continue Pipeline]│
└──────────────────────────────────────────────────────────┘
```

**Face thumbnail**: 72x72px, `object-cover`, rounded. Confidence badge overlay (green ≥0.9, yellow 0.7-0.89, red <0.7). Click to toggle selection (cyan border when selected). No-crop placeholder for ≤0.69 confidence detections.

**"Assign to Character" dropdown**: Search input filtering known characters list, plus free-text option for new character ID. Same pattern as QueueCard in new-characters.

**"Move Selected to..." button**: Appears when faces are selected within a cluster. Dropdown of other clusters to merge into. This handles the merge use case without drag-and-drop.

**Approve button**: Disabled until all unresolved clusters are empty (assigned or rejected).

---

## 3. Server Actions (`actions.ts`)

All use `supabaseAdmin`, return `{ ok: true } | { ok: false; error: string }`, call `revalidatePath`.

### `confirmCluster`
- Args: `{ detectionIds: string[], exemplarIds: string[] }`
- Updates: `panel_character_detections.human_verified = true`, `character_face_exemplars.is_confirmed = true`

### `rejectDetections`
- Args: `{ detectionIds: string[], exemplarIds: string[] }`
- Deletes from both tables. Storage cleanup deferred (crops are small JPEGs).

### `reassignDetections`
- Args: `{ detectionIds: string[], exemplarIds: string[], targetCharacterId: string }`
- Updates `character_id` on both tables, clears `suggested_name`
- Handles merge (moving faces between clusters) and resolve (assigning unresolved to known character)

### `renameCluster`
- Args: `{ detectionIds: string[], exemplarIds: string[], newCharacterId: string }`
- Updates `character_id` on all, clears `suggested_name`
- If `newCharacterId` not in characters table, inserts a minimal row

---

## 4. ApproveClusterButton Enhancement

Add `disabled?: boolean` prop. Button disabled when `loading || disabled`. Parent passes `disabled={!allHandled}`.

---

## Verification

1. `pnpm typecheck` — no type errors
2. Start dev server (`pnpm next dev`), navigate to `/admin/tmnt-mmpr-iii/issue-2/review/clusters`
3. Verify face crops load from Supabase Storage
4. Test: assign an unresolved cluster → check DB updates
5. Test: reject a face → check deletion
6. Test: confirm a resolved cluster → check human_verified/is_confirmed flags
7. Test: approve button enables only after all unresolved handled
8. Test: approve resumes the workflow hook
