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

## ⚠ Direction shift (2026-04-28)

Smoke-test of Phase 2 produced 190 shots / $9.50 image + $95–$380 video
cost vs a $5 hard API ceiling. The cinematic-video plan is incompatible
with the budget AND the actual product goal (kid-first reading
experience that preserves the book medium).

New default direction: **Motion Comic Plus**. See
[`../motion-comic-plus/00-overview.md`](../motion-comic-plus/00-overview.md).
The old Phase 3/4 specs are marked superseded but kept for the optional
"Hero Shot Cinematic" opt-in mode.

`shot-planner.ts` and the `plan-shots` step are kept as the feeder for
hero-shot cinematics. The new default `direct-panels` step (spec'd in
motion-comic-plus/01-panel-direction.md) replaces it for everyday use.

---

## Phase 2 — Shot Planning — ✅ Done (now optional path for hero shots only)

Implementation:
- `scripts/utils/shot-planner.ts` — Gemini Vision per-page panel analysis,
  bubble→panel spatial mapping (% center inside region bounds, smallest
  region wins ties), shot grouping rules, review-table printer
- `plan-shots` step added to `scripts/generate-episode.ts` step registry
- Output: `assets/episodes/<book>/<issue>/shot-plan.json`
- Cost: ~$0.05–0.10/issue (~24 GEMINI_MEDIUM calls)

**Reddit-driven design hardening** (Seedance/Venice content filters):
- Gemini Vision prompt explicitly forbids character names and IP proper
  nouns in panel descriptions; mandates cinematic vocabulary
  ("depth of field", "low-angle", "rim lighting", "tracking shot")
- `sceneDescription` is built purely from cinematic terms — safe to send
  directly to Venice
- IP names stay in `characters[]` array (sourced from bubbles' `speaker`
  field) and only feed into Phase 3's character-reference image lookup
- This makes Phase 3/4 prompts filter-safe by construction

**Smoke test next step:** run against TMNT × MMPR III issue 1
(`pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step plan-shots`)
to validate panel-mapping accuracy and review the generated `sceneDescription` strings before Phase 3.

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
