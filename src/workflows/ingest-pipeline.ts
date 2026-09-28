import { createHook } from "workflow";
import { FatalError } from "workflow";

import {
  updatePipelineStep,
  getPageList,
  getPanelCount,
  markIssueReady,
  markPipelineFailed,
  batchArray,
} from "./steps/shared";
import {
  roboflowAnalyzeBatch,
  extractForegroundMasksBatch,
  characterLookaheadPage,
  getContextPage,
} from "./steps/vision";
import { sortPageElements, addBubbleStyles } from "./steps/sort";
import { fetchWikiContextStep } from "./steps/wiki";
import { generateVoiceDescriptions } from "./steps/voice";
import {
  getCharactersNeedingVoices,
  generateVoiceModel,
  getBubbleIdsForAudio,
  generateAudioBatch,
} from "./steps/generation";
import {
  uploadAudio,
  consolidateMusicScenes,
  generateManifest,
} from "./steps/publishing";
import { createCastingTasks } from "./steps/casting-tasks";
import {
  countUnresolvedFaces,
  countPendingNewCharacters,
  recordGateSkip,
} from "./steps/gate-checks";
import { closePipelineRun } from "./steps/pipeline-runs";

interface IngestInput {
  bookId: string;
  issueId: string;
  fromStep?: string;
}

const STEP_ORDER = [
  "roboflow-page-analyze",
  "extract-foreground-masks",
  "fetch-wiki-context",
  "character-lookahead",
  "review-clusters",
  "get-context",
  "sort-page-elements",
  "review-pages",
  "review-new-characters",
  "generate-voice-descriptions",
  "casting",
  "generate-voice-models",
  "generate-audio",
  "upload-audio",
  "consolidate-music-scenes",
  "generate-manifest",
] as const;

function shouldRun(step: string, fromStep?: string): boolean {
  if (!fromStep) return true;
  const fromIdx = STEP_ORDER.indexOf(fromStep as (typeof STEP_ORDER)[number]);
  const stepIdx = STEP_ORDER.indexOf(step as (typeof STEP_ORDER)[number]);
  if (fromIdx === -1) return true;
  return stepIdx >= fromIdx;
}

export { STEP_ORDER };

export async function ingestPipeline(input: IngestInput) {
  "use workflow";

  const { bookId, issueId, fromStep } = input;
  const run = (step: string) => shouldRun(step, fromStep);
  let currentStep = fromStep ?? "roboflow-page-analyze";

  try {
    const pages = await getPageList(bookId, issueId);
    if (pages.length === 0) {
      throw new FatalError("No pages found for this issue");
    }

    // ── Phase 1: Vision Analysis ──────────────────────────────────────
    if (run("roboflow-page-analyze")) {
      currentStep = "roboflow-page-analyze";
      await updatePipelineStep(bookId, issueId, currentStep);
      const roboflowBatches = batchArray(pages, 6);
      for (const batch of roboflowBatches) {
        await roboflowAnalyzeBatch(bookId, issueId, batch);
      }
      const panelCount = await getPanelCount(bookId, issueId);
      if (panelCount === 0) {
        throw new FatalError(
          "Roboflow produced 0 panels. API may be down or credentials invalid",
        );
      }
    }

    if (run("extract-foreground-masks")) {
      currentStep = "extract-foreground-masks";
      await updatePipelineStep(bookId, issueId, currentStep);
      const maskBatches = batchArray(pages, 6);
      for (const batch of maskBatches) {
        await extractForegroundMasksBatch(bookId, issueId, batch);
      }
    }

    if (run("fetch-wiki-context")) {
      currentStep = "fetch-wiki-context";
      await updatePipelineStep(bookId, issueId, currentStep);
      await fetchWikiContextStep(bookId, issueId);
    }

    if (run("character-lookahead")) {
      currentStep = "character-lookahead";
      await updatePipelineStep(bookId, issueId, currentStep);
      for (const page of pages) {
        await characterLookaheadPage(bookId, issueId, page.pageNumber);
      }
    }

    // ── Phase 2: Human Review, Character Clusters ─────────────────────
    if (run("review-clusters")) {
      currentStep = "review-clusters";
      const faces = await countUnresolvedFaces(bookId, issueId);
      if (faces.total === 0) {
        await updatePipelineStep(bookId, issueId, currentStep);
        await recordGateSkip(
          bookId,
          issueId,
          "review-clusters",
          "no unresolved faces",
          {
            unresolvedDetections: faces.unresolvedDetections,
            unresolvedExemplars: faces.unresolvedExemplars,
          },
        );
        console.log(
          `[review-clusters] skipped: 0 unresolved faces for ${bookId}/${issueId}`,
        );
      } else {
        await updatePipelineStep(bookId, issueId, currentStep, true);
        using clusterHook = createHook<{ approved: boolean }>({
          token: `ingest:${bookId}/${issueId}/cluster-review`,
        });
        await clusterHook;
      }
    }

    // ── Phase 3: OCR + Context ────────────────────────────────────────
    if (run("get-context")) {
      currentStep = "get-context";
      await updatePipelineStep(bookId, issueId, currentStep);
      for (const page of pages) {
        await getContextPage(bookId, issueId, page.pageNumber);
      }
    }

    // ── Phase 4: Sort + Human Review ──────────────────────────────────
    if (run("sort-page-elements")) {
      currentStep = "sort-page-elements";
      await updatePipelineStep(bookId, issueId, currentStep);
      for (const page of pages) {
        await sortPageElements(bookId, issueId, page.pageNumber);
      }
      await addBubbleStyles(bookId, issueId);
    }

    if (run("review-pages")) {
      currentStep = "review-pages";
      await updatePipelineStep(bookId, issueId, currentStep, true);
      using pageReviewHook = createHook<{ approved: boolean }>({
        token: `ingest:${bookId}/${issueId}/page-review`,
      });
      await pageReviewHook;
    }

    // ── Phase 5: New characters, then voice descriptions ──────────────
    if (run("review-new-characters")) {
      currentStep = "review-new-characters";
      const pendingCount = await countPendingNewCharacters(bookId, issueId);
      if (pendingCount === 0) {
        await updatePipelineStep(bookId, issueId, currentStep);
        await recordGateSkip(
          bookId,
          issueId,
          "review-new-characters",
          "no pending new characters",
          { pendingCount },
        );
        console.log(
          `[review-new-characters] skipped: 0 pending for ${bookId}/${issueId}`,
        );
      } else {
        await updatePipelineStep(bookId, issueId, currentStep, true);
        using characterHook = createHook<{ approved: boolean }>({
          token: `ingest:${bookId}/${issueId}/character-review`,
        });
        await characterHook;
      }
    }

    if (run("generate-voice-descriptions")) {
      currentStep = "generate-voice-descriptions";
      await updatePipelineStep(bookId, issueId, currentStep);
      await generateVoiceDescriptions(bookId, issueId);
    }

    // ── Phase 6: Casting ──────────────────────────────────────────────
    if (run("casting")) {
      currentStep = "casting";
      const casting = await createCastingTasks(bookId, issueId);
      const unresolved = casting.unresolved.length;
      // Unresolved speakers pause the gate too: resuming it accepts their
      // bubbles as silent (counted as silentBubbles by generateManifest).
      if (casting.pending === 0 && unresolved === 0) {
        const reason =
          casting.cast === casting.speakers
            ? "all speakers cast"
            : "no speakers pending or unresolved";
        await updatePipelineStep(bookId, issueId, currentStep);
        await recordGateSkip(bookId, issueId, "casting", reason, {
          speakers: casting.speakers,
          cast: casting.cast,
          pending: casting.pending,
          unresolved,
        });
        console.log(
          `[casting] skipped: ${reason} (${casting.cast} of ${casting.speakers} cast, 0 unresolved)`,
        );
      } else {
        console.log(
          `[casting] paused: ${casting.cast} of ${casting.speakers} cast, ${casting.pending} pending, ${unresolved} unresolved${unresolved > 0 ? `: ${casting.unresolved.join(", ")}` : ""}`,
        );
        await updatePipelineStep(bookId, issueId, currentStep, true);
        using castingHook = createHook<{ approved: boolean }>({
          token: `ingest:${bookId}/${issueId}/casting`,
        });
        await castingHook;
      }
    }

    // ── Phase 7: Voice Generation ─────────────────────────────────────
    if (run("generate-voice-models")) {
      currentStep = "generate-voice-models";
      await updatePipelineStep(bookId, issueId, currentStep);
      const characters = await getCharactersNeedingVoices(bookId, issueId);
      for (const characterId of characters) {
        await generateVoiceModel(bookId, issueId, characterId);
      }
    }

    if (run("generate-audio")) {
      currentStep = "generate-audio";
      await updatePipelineStep(bookId, issueId, currentStep);
      const bubbleIds = await getBubbleIdsForAudio(bookId, issueId);
      const audioBatches = batchArray(bubbleIds, 20);
      for (const batch of audioBatches) {
        await generateAudioBatch(bookId, issueId, batch);
      }
    }

    // ── Phase 8: Publishing ───────────────────────────────────────────
    if (run("upload-audio")) {
      currentStep = "upload-audio";
      await updatePipelineStep(bookId, issueId, currentStep);
      await uploadAudio(bookId, issueId);
    }

    if (run("consolidate-music-scenes")) {
      currentStep = "consolidate-music-scenes";
      await updatePipelineStep(bookId, issueId, currentStep);
      await consolidateMusicScenes(bookId, issueId);
    }

    if (run("generate-manifest")) {
      currentStep = "generate-manifest";
      await updatePipelineStep(bookId, issueId, currentStep);
      await generateManifest(bookId, issueId);
    }

    await markIssueReady(bookId, issueId);
    await closePipelineRun(bookId, issueId, "completed");

    return { bookId, issueId, status: "ready" };
  } catch (err) {
    await closePipelineRun(bookId, issueId, "failed");
    if (err instanceof FatalError) {
      await markPipelineFailed(bookId, issueId, currentStep);
      throw err;
    }
    await markPipelineFailed(bookId, issueId, currentStep);
    throw err;
  }
}
