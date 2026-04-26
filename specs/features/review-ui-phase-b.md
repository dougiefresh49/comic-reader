# Feature: Review UI — Phase B (Live Regeneration)

## Status: `blocked`
## Prerequisite: Storage migration (S3 / Supabase / Blob) must be completed first
## Blocked by: Asset hosting decision — see Known Issues in CLAUDE.md

---

## Purpose

Extends the Review UI (Phase A) with in-browser regeneration buttons. Instead of exporting a fixes file and re-running local scripts, you can re-run Gemini context analysis or re-generate audio for a single bubble directly from the review sidebar.

**Do not implement this until asset storage is off local `public/`.** Next.js server actions in production cannot write to the local filesystem. These features require the ability to read from and write back to wherever assets are hosted.

---

## Prerequisite Detail

Phase B uses Next.js server actions that:
1. Fetch a page image from storage (currently `public/comics/...` — won't work in production)
2. Call Gemini or ElevenLabs API
3. Write the result back to storage

This only works cleanly once assets are on S3, Supabase Storage, or Vercel Blob, where server actions can read/write via SDK.

---

## New UI (additions to Phase A sidebar)

The Phase A sidebar already renders these buttons grayed out as placeholders. Phase B activates them:

```
│  ─── Live Regeneration ─────────│
│  [↻ Re-run Gemini Context]       │  ← calls rerunBubbleContext()
│  [✎ Re-generate Cues]            │  ← calls regenerateCues()
│  [🔊 Re-generate Audio]          │  ← calls regenerateAudio()
```

Each button shows a loading spinner while the server action is in progress. On success, the sidebar fields update with the new values. The user can accept or override.

---

## Server Actions

New directory: `src/server/actions/review/`

### `rerun-context.ts`

```ts
async function rerunBubbleContext(bookId: string, issueId: string, bubbleId: string) {
  // 1. Fetch page image from storage URL
  // 2. Crop to bubble bounding box (using sharp)
  // 3. Call GEMINI_HIGH with page image + bubble crop + existing bubbles for context
  // 4. Return { speaker, emotion, type, aiReasoning }
  // 5. Write updated bubble back to bubbles.json in storage
}
```

Model: `GEMINI_HIGH` (same as the `get-context` pipeline step — needs reasoning about page context, not just the cropped bubble).

### `regenerate-cues.ts`

```ts
async function regenerateCues(bubbleId: string, text: string) {
  // 1. Call GEMINI_FAST with the text content + ElevenLabs cue formatting rules
  // 2. Return { textWithCues }
  // 3. Write updated field back to bubbles.json in storage
}
```

Model: `GEMINI_FAST` — same as `repair-cues.ts`, simple rule-based reformatting.

### `regenerate-audio.ts`

```ts
async function regenerateAudio(bookId: string, issueId: string, bubbleId: string, speaker: string, textWithCues: string) {
  // 1. Look up voice ID for speaker in castlist.json
  // 2. Call ElevenLabs TTS API
  // 3. Upload new MP3 to storage, replacing old file
  // 4. Update audio-timestamps.json with new word alignment data
}
```

No Gemini model — ElevenLabs only.

---

## Model Rule

As always, never hardcode model strings. Import from `scripts/utils/models.ts`:

```ts
import { GEMINI_HIGH, GEMINI_FAST } from "@/scripts/utils/models";
// or re-export from a shared location accessible to both scripts/ and src/
```

Note: `scripts/utils/models.ts` is currently only imported from `scripts/`. When implementing Phase B, decide whether to re-export from `src/lib/models.ts` or use a path alias so server actions can import from the same source of truth.

---

## Storage Abstraction

Before implementing Phase B, create a storage abstraction layer so the server actions don't care whether assets are on S3, Supabase, or Vercel Blob:

```ts
// src/server/storage.ts
export async function readFile(path: string): Promise<Buffer>
export async function writeFile(path: string, data: Buffer): Promise<void>
export async function getPublicUrl(path: string): Promise<string>
```

The implementation swaps based on `STORAGE_PROVIDER` env var. This is also the right moment to implement the `STORAGE_MODE=s3` flag that already exists in the pipeline scripts.

---

## Implementation Steps

1. Complete storage migration (prerequisite — separate decision)
2. Create `src/server/storage.ts` abstraction
3. Create `src/server/actions/review/rerun-context.ts`
4. Create `src/server/actions/review/regenerate-cues.ts`
5. Create `src/server/actions/review/regenerate-audio.ts`
6. Activate the grayed-out buttons in `BubbleSidebar.tsx` (Phase A already renders them)
7. Wire loading/error states in the sidebar

## Verification

```bash
pnpm dev  # must be pointed at a storage-backed issue, not local public/
# - Click "Re-run Gemini Context" → spinner → sidebar updates with new speaker/emotion
# - Click "Re-generate Cues" → sidebar textWithCues field updates
# - Click "Re-generate Audio" → new audio plays in sidebar preview
# - Verify updated files in storage (not just in browser state)
pnpm typecheck && pnpm lint
```
