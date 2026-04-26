# Episode Generation — Review System

## Purpose

The review system is how you stay in control of a long, multi-phase, billed pipeline. Each phase has a defined review gate that pauses the pipeline, shows you what was generated, and lets you approve the output or mark specific items for regeneration before spending on the next phase.

**Design rule:** review is always visual + human. No AI calls at review time. The pipeline generates artifacts for you to inspect, then waits.

---

## Review Gate Summary

| Phase | Review artifact | How to inspect | What you decide |
|-------|----------------|----------------|-----------------|
| Phase 1 — Character References | Finder opens `characters/` | Thumbnail previews in Finder | Approve or re-generate specific characters by name |
| Phase 2 — Shot Plan | Terminal table + editable JSON | Read terminal output, edit `shot-plan.json` if needed | Approve plan (last free gate) or edit shots manually |
| Phase 3 — Storyboard | `review-storyboard.html` opened in browser | Image grid in browser | Approve all or enter shot IDs to re-generate |
| Phase 4 — Video Clips | `review-videos.html` opened in browser | Video grid in browser | Approve all or enter shot IDs to re-generate |
| Phase 5 — Assembly | `open episode-001.mp4` | QuickTime playback | Watch and accept; re-run from `assemble-episode` if needed |

---

## `review-state.json`

The pipeline persists review decisions in `assets/episodes/<book>/issue-<n>/review-state.json`.

```json
{
  "storyboard": {
    "s001": "approved",
    "s002": "approved",
    "s003": "needs-regen",
    "s004": "approved"
  },
  "videos": {
    "s001": "approved",
    "s002": "approved",
    "s003": "pending",
    "s004": "approved"
  }
}
```

**Status values:**
- `"approved"` — accepted, skip in future runs
- `"needs-regen"` — rejected, must re-generate before proceeding
- `"pending"` — not yet reviewed (default for new shots)

The pipeline will not proceed past a phase if any shot has status `"needs-regen"` for that phase's section.

---

## Checkpoint vs Review State

These are two separate files with different concerns:

| File | Purpose |
|------|---------|
| `episode-checkpoint.json` | Tracks which pipeline *steps* have completed (setup-series, plan-shots, storyboard, etc.) |
| `review-state.json` | Tracks which *outputs* you've approved or rejected at each review gate |

The checkpoint prevents re-running completed steps. The review state prevents spending on Phase 4 before Phase 3 is fully approved.

---

## The `--reject-shots` Flag

When you identify shots to regenerate during review:

```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --reject-shots s003,s007 --from-step storyboard
```

This:
1. Sets `review-state.json` storyboard status for s003, s007 → `"needs-regen"`
2. Clears `episode-checkpoint.json` back to the `storyboard` step
3. Re-runs storyboard generation only for those shots
4. Re-generates `review-storyboard.html` and opens it
5. Resumes normal review flow for just those shots

The same pattern applies at the video phase:
```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --reject-shots s003 --from-step generate-videos
```

---

## Review HTML Generator (`scripts/utils/review-generator.ts`)

Generates self-contained HTML files using `file://` relative paths. No server needed.

```typescript
generateStoryboardReview(episodeDir: string, shots: ShotDescriptor[]): void
generateVideoReview(episodeDir: string, shots: ShotDescriptor[]): void
```

Both functions:
1. Build HTML string with embedded CSS
2. Write to `<episodeDir>/review-storyboard.html` or `review-videos.html`
3. Call `open <path>` (macOS) to launch in default browser

The HTML is intentionally static — no JavaScript state, no form submission. It's a read-only gallery. All decisions are made in the terminal after viewing.

---

## Review Flow in Practice

### Example: storyboard review

```
🎨 Storyboard complete — 23 panels generated

Opening review in browser...
file:///Users/.../assets/episodes/tmnt-mmpr-iii/issue-1/review-storyboard.html

[browser opens showing a 4-column grid of all 23 panel images with shot IDs]

Approve all panels and continue to video generation?
Or enter shot IDs to regenerate (comma-separated): [Enter to approve all]
> s003, s011

Marking s003, s011 for regeneration...
Rebuilding storyboard for 2 shots...

   Generating s003... ✓ ($0.08)
   Generating s011... ✓ ($0.08)

Review updated panels:
[browser re-opens showing only s003 and s011]

Approve these panels? [Y/n]
> Y

✅ All 23 panels approved. Proceeding to video generation.
```

---

## Philosophy: Why Not a Full Web UI?

The Review UI Phase A (annotation editor) is a Next.js app because it requires complex interactions: drag-to-resize, IndexedDB persistence, live editing. Episode review doesn't need any of that.

Episode review needs:
1. **See the asset** (image or video)
2. **Decide** (approve or reject)
3. **Communicate the decision** (type shot IDs in terminal)

A static HTML gallery + terminal prompt covers all three without building and maintaining additional UI infrastructure. The review HTML files are ephemeral — generated per-session, not committed.

---

## Cost Discipline

The review system enforces a cost discipline:

1. **Phase 2 (shot planning) is the last free gate.** Edit `sceneDescription` here to improve prompt quality before spending on images.
2. **Phase 3 (storyboard) is cheap.** Regenerating a bad panel costs ~$0.10. Iterate freely here.
3. **Phase 4 (video) is expensive.** Each regeneration costs ~$1.20. Be selective. If a panel is borderline, fix it at Phase 3 before committing to video.
4. **Never auto-proceed past a review gate.** Even in automated/CI contexts, the pipeline should not skip review gates without explicit `--skip-review` flag (not recommended for production use).

---

## macOS Integration Notes

- `open <folder>` opens Finder with Quick Look previews — works for PNG files
- `open <file>.html` opens in default browser via `file://` protocol
- `open <file>.mp4` opens in QuickTime Player
- All `open` calls use Node.js `child_process.exec('open <path>')`
- On non-macOS: log the path and instruct user to open manually
