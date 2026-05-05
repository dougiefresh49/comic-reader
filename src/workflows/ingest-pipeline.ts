import { createHook } from "workflow";
import { FatalError } from "workflow";

import {
  updatePipelineStep,
  getPageList,
  markIssueReady,
  batchArray,
} from "./steps/shared";
import {
  roboflowAnalyzeBatch,
  extractForegroundMasksBatch,
  characterLookaheadPage,
  getContextPage,
} from "./steps/vision";
import { sortPageElements, addBubbleStyles } from "./steps/sort";
import {
  generateVoiceDescriptions,
  cleanVoiceDescriptions,
} from "./steps/voice";
import {
  getCharactersNeedingVoices,
  generateVoiceModel,
  voiceRotationCheckout,
  getBubbleIdsForAudio,
  generateAudioBatch,
} from "./steps/generation";
import {
  uploadAudio,
  consolidateMusicScenes,
  generateManifest,
} from "./steps/publishing";

interface IngestInput {
  bookId: string;
  issueId: string;
}

export async function ingestPipeline(input: IngestInput) {
  "use workflow";

  const { bookId, issueId } = input;

  await updatePipelineStep(bookId, issueId, "roboflow-page-analyze");

  // ── Phase 1: Vision Analysis ──────────────────────────────────────
  const pages = await getPageList(bookId, issueId);
  if (pages.length === 0) {
    throw new FatalError("No pages found for this issue");
  }

  const roboflowBatches = batchArray(pages, 6);
  for (const batch of roboflowBatches) {
    await roboflowAnalyzeBatch(bookId, issueId, batch);
  }

  await updatePipelineStep(bookId, issueId, "extract-foreground-masks");

  for (const batch of roboflowBatches) {
    await extractForegroundMasksBatch(bookId, issueId, batch);
  }

  await updatePipelineStep(bookId, issueId, "character-lookahead");

  for (const page of pages) {
    await characterLookaheadPage(bookId, issueId, page.pageNumber);
  }

  // ── Phase 2: Human Review — Character Clusters ────────────────────
  await updatePipelineStep(bookId, issueId, "review-clusters", true);

  using clusterHook = createHook<{ approved: boolean }>({
    token: `ingest:${bookId}/${issueId}/cluster-review`,
  });
  await clusterHook;

  // ── Phase 3: OCR + Context ────────────────────────────────────────
  await updatePipelineStep(bookId, issueId, "get-context");

  for (const page of pages) {
    await getContextPage(bookId, issueId, page.pageNumber);
  }

  // ── Phase 4: Sort + Human Review ──────────────────────────────────
  await updatePipelineStep(bookId, issueId, "sort-page-elements");

  for (const page of pages) {
    await sortPageElements(bookId, issueId, page.pageNumber);
  }

  await addBubbleStyles(bookId, issueId);

  await updatePipelineStep(bookId, issueId, "review-pages", true);

  using pageReviewHook = createHook<{ approved: boolean }>({
    token: `ingest:${bookId}/${issueId}/page-review`,
  });
  await pageReviewHook;

  // ── Phase 5: Voice Processing ─────────────────────────────────────
  await updatePipelineStep(bookId, issueId, "generate-voice-descriptions");

  await generateVoiceDescriptions(bookId, issueId);
  await cleanVoiceDescriptions(bookId, issueId);

  // ── Phase 6: Human Review — Characters + Casting ──────────────────
  await updatePipelineStep(bookId, issueId, "review-new-characters", true);

  using characterHook = createHook<{ approved: boolean }>({
    token: `ingest:${bookId}/${issueId}/character-review`,
  });
  await characterHook;

  await updatePipelineStep(bookId, issueId, "casting", true);

  using castingHook = createHook<{ approved: boolean }>({
    token: `ingest:${bookId}/${issueId}/casting`,
  });
  await castingHook;

  // ── Phase 7: Voice Generation ─────────────────────────────────────
  await updatePipelineStep(bookId, issueId, "voice-rotation-checkout");
  await voiceRotationCheckout(bookId, issueId);

  await updatePipelineStep(bookId, issueId, "generate-voice-models");
  const characters = await getCharactersNeedingVoices(bookId, issueId);
  for (const characterId of characters) {
    await generateVoiceModel(bookId, issueId, characterId);
  }

  await updatePipelineStep(bookId, issueId, "generate-audio");
  const bubbleIds = await getBubbleIdsForAudio(bookId, issueId);
  const audioBatches = batchArray(bubbleIds, 20);
  for (const batch of audioBatches) {
    await generateAudioBatch(bookId, issueId, batch);
  }

  // ── Phase 8: Publishing ───────────────────────────────────────────
  await updatePipelineStep(bookId, issueId, "upload-audio");
  await uploadAudio(bookId, issueId);

  await updatePipelineStep(bookId, issueId, "consolidate-music-scenes");
  await consolidateMusicScenes(bookId, issueId);

  await updatePipelineStep(bookId, issueId, "generate-manifest");
  await generateManifest(bookId, issueId);

  await markIssueReady(bookId, issueId);

  return { bookId, issueId, status: "ready" };
}
