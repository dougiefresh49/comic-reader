# Episode Generation — Status Snapshot

_Last updated: overnight session 2026-04-28_

## Phase 0 — Motion Comic MVP — ✅ DONE

`pnpm motion-comic` works end-to-end.

## Phase 1 — Character Setup — ✅ Followup fixes applied

All 4 fixes from `02-character-setup-followup.md` are confirmed applied
in `scripts/generate-episode.ts` and `scripts/utils/venice-client.ts`:
- Registry saves immediately after each `visualDescription` is written
- `generateImage()` returns `{ buffer, balanceUsd }` from `X-Balance-Remaining` header
- Non-null assertion replaced with explicit `if (!readyAppearance) continue;` guard
- `generatedCount` tracked in-loop (not from directory count)

The script is implementation-ready for a full run. Verification still
needs to happen against a fresh book.

## Phase 2 — Shot Planning — 🟡 Pending implementation

Spec (`03-shot-planning.md`) is complete and detailed. Implementation has
not started. **Last free review gate before Venice spending begins.**

Required:
- `scripts/utils/shot-planner.ts` — Gemini Vision per-page panel analysis
- Output: `shot-plan.json` per issue with structured shot descriptors
- Manual review/edit step on the JSON before Phase 3 starts
- Cost: ~$0.10–0.30/issue (Gemini Vision only)

Open questions for implementation:
- Bubble-to-panel mapping is the trickiest part — Gemini detects panels,
  we already have bubbles with positions; how to associate them deterministically?
- Shot grouping rules clear in spec but require real test data to validate

## Phase 3 — Storyboard — 🟢 Ready to code

Spec (`04-storyboard.md`) is implementation-ready. Venice models picked,
prompt strategies documented, review HTML generator outlined.

Required:
- `scripts/storyboard.ts` — single panel image per shot
- Model selection: single-character → `seedream-v5-lite-edit`, multi → `seedream-v5-lite`
- Output: `panels/shot-NNN.png` + provenance JSON
- Cost: ~$5–15/issue (~$0.05/image)

## Phase 4 — Video Clips — 🟢 Ready to code (most complex)

Spec (`05-video-clips.md`) is highly detailed.

Required:
- `scripts/video-clips.ts` — async Venice video queue
- Models: kling-o3-pro-reference-to-video (faces), seedance-2-0 (atmosphere)
- Polling timeout 10 min, duration snapping per model lookup
- Cost: ~$15–50/issue (~$0.50–2/clip)

**Risk:** Spec doesn't confirm Venice's async concurrency limits.
Recommend a small smoke test before submitting batches.

## Phase 5 — Assembly — 🟢 Ready to code

Spec (`06-assembly.md`) clear. FFmpeg-only with optional Venice music.

Required:
- `scripts/assemble-episode.ts`
- FFmpeg commands fully specified
- Optional `stable-audio-3` background music — not yet in `scripts/utils/models.ts`

**TODO before implementation:** add `VENICE_AUDIO_MUSIC = "stable-audio-3"`
to `scripts/utils/models.ts`.

## Review System — 🟢 Ready to code

Static HTML galleries + macOS `open` integration. No blockers.

---

## Recommended next sprint order

1. Verify Phase 1 with a real run on TMNT×MMPR (smoke test)
2. Implement Phase 2 (shot-planning) — last free gate
3. Phase 3 + 5 in parallel (small + low-cost)
4. Phase 4 last (highest cost + complexity)
5. Wire the review system into each phase as it ships

No spec changes needed. No questions blocking the user.
