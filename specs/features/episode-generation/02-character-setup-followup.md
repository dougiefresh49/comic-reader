# Phase 1 — Character Setup: Post-Implementation Followup

Issues found by code review against the spec. The implementation is functionally solid —
Gemini Vision format, checkpoint logic, known-character descriptions, review loop, and
Venice API calls all match the spec. The items below are spec deviations or runtime risks
that should be fixed before a full end-to-end run.

---

## Fix 1 — Save registry immediately after each `visualDescription` is generated

**File:** `scripts/generate-episode.ts` — inside `lockCharacters`, the `registryDirty`
flag and a single `saveRegistry` at the end.

**Problem:** The spec says "save the result back to the registry appearance's
`visualDescription` field **immediately after generation**." Currently, all
`visualDescription` values are held in memory and flushed in a single `saveRegistry`
call at the very end. If the script is interrupted after Gemini generates a description
but before image generation completes, the description is lost and will be regenerated
on the next run.

**Fix:** Call `saveRegistry(registry)` immediately after setting
`readyAppearance.visualDescription`, not once at the end. Remove the `registryDirty`
flag entirely — always save immediately when a description is written.

```ts
// After setting readyAppearance.visualDescription = visualDescription:
await saveRegistry(registry);
// Remove: registryDirty = true
// Remove: the if (registryDirty) { await saveRegistry(registry) } block at the end
```

---

## Fix 2 — Read balance from response header instead of a separate API call

**File:** `scripts/utils/venice-client.ts` and `scripts/generate-episode.ts`

**Problem:** After each `generateImage()` call, the code makes a separate `getBalance()`
request to `GET /api_keys/rate_limits`. Venice returns the current balance in the
`X-Balance-Remaining` response header on every API call, so this extra round-trip is
unnecessary and adds ~15 extra HTTP requests for a 15-character run.

**Fix:** Update `generateImage()` to return both the image buffer and the balance from
the response header. Update callers to use the returned balance.

In `venice-client.ts`, change the return type and implementation:

```ts
export async function generateImage(params: {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  format?: "png" | "jpeg" | "webp";
  hideWatermark?: boolean;
}): Promise<{ buffer: Buffer; balanceUsd: number | null }> {
  // ... existing fetch call ...
  const balanceHeader = res.headers.get("X-Balance-Remaining");
  const balanceUsd = balanceHeader ? parseFloat(balanceHeader) : null;
  // ... existing base64 decode ...
  return { buffer, balanceUsd };
}
```

In `generate-episode.ts`, update callers:

```ts
const { buffer: imgBuffer, balanceUsd } = await generateImage({ ... });
await fs.writeFile(refImagePath, imgBuffer);

const balance = balanceUsd ?? await getBalance();  // fall back if header missing
console.log(`✓  ($0.05)  💰 $${balance.toFixed(2)} remaining`);
```

The `getBalance()` function can stay as a standalone utility (useful for the pre-flight
balance check before starting a run), but shouldn't be called after every image.

---

## Fix 3 — Guard the non-null assertion on `readyAppearance`

**File:** `scripts/generate-episode.ts` line ~338

**Problem:** `entry.appearances.find((a) => a.voice?.status === "ready")!` uses a
non-null assertion. `hasReadyVoice` returns `true` when a ready appearance exists, so
this should always succeed — but if the registry data is malformed it will throw an
unhandled error with no useful message.

**Fix:** Replace the assertion with an explicit guard:

```ts
const readyAppearance = entry.appearances.find(
  (a) => a.voice?.status === "ready",
);
if (!readyAppearance) {
  console.log(`   ⚠️  [${i + 1}/${readyChars.length}] ${canonicalName} — no ready appearance found, skipping`);
  continue;
}
```

---

## Fix 4 — Correct the end-of-run image count

**File:** `scripts/generate-episode.ts` line ~439-442

**Problem:** The final summary counts the number of subdirectories in
`assets/episodes/<book>/characters/`, which includes directories from previous runs
(skipped characters). This makes the count misleading — it reports total references
available, not references generated in this run.

**Fix:** Track a counter during the loop instead of counting the directory:

```ts
let generatedCount = 0;

// Inside the loop, after successfully writing reference.png:
await fs.writeFile(refImagePath, imgBuffer);
generatedCount++;

// After the loop:
console.log(`\n✅ Generated ${generatedCount} character reference image(s) this run\n`);
```

---

## No action needed — confirmed correct

- **Gemini Vision `contents` format** (`[...imageParts, textPart]`) — matches the
  existing pattern used in `scripts/utils/gemini-context.ts` and `scripts/utils/ocr.ts`.
- **`response.text` getter** — matches every other script in the codebase.
- **`extractJson` helper** — correctly handles both raw JSON and markdown-wrapped JSON
  from Gemini responses.
- **Checkpoint behavior** — `--only-step`, `--force`, and full-run ordering all match
  the spec.
- **Hardcoded known-character descriptions** — all 15 TMNT×MMPR characters present with
  correct values.
- **3-second delay between image requests** — implemented correctly.
- **Registry save for hardcoded descriptions** — hardcoded descriptions also set
  `registryDirty = true` and get written to the registry appearance, so subsequent runs
  find them and skip Gemini/hardcode lookup. Correct.
- **Review loop (Finder + re-generation)** — fully matches spec.
- **`safeCharName` sanitization** — consistent between main loop and review loop.
- **`VENICE_IMAGE_CHAR_REF` in provenance** — resolves to `"seedream-v5-lite"` at
  runtime. Correct.
