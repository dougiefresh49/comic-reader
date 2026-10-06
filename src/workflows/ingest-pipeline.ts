import { createHook } from "workflow";
import { FatalError } from "workflow";

import {
  STEP_ORDER,
  resolvePipelineStep,
  type PipelineStep,
} from "~/lib/pipeline-steps";

import {
  updatePipelineStep,
  recordStepStart,
  recordStepEnd,
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
import { getBubbleIdsForAudio, generateAudioBatch } from "./steps/generation";
import { generateManifest } from "./steps/publishing";
import { createCastingTasks } from "./steps/casting-tasks";
import { recordGateSkip, recordGateWait } from "./steps/gate-checks";
import { closePipelineRun, recordMasksFailure } from "./steps/pipeline-runs";

interface IngestInput {
  bookId: string;
  issueId: string;
  fromStep?: string;
}

/** Both arguments are steps the workflow can place, so an unknown name never runs everything. */
function shouldRun(step: PipelineStep, from: PipelineStep | null): boolean {
  if (from === null) return true;
  return STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(from);
}

export async function ingestPipeline(input: IngestInput) {
  "use workflow";

  const { bookId, issueId, fromStep } = input;
  // trigger-ingest resolves fromStep too; this guards any other caller.
  const from = fromStep === undefined ? null : resolvePipelineStep(fromStep);
  if (fromStep !== undefined && from === null) {
    throw new FatalError(`Unknown fromStep "${fromStep}"; nothing was run`);
  }
  const run = (step: PipelineStep) => shouldRun(step, from);
  let currentStep: string = from ?? "roboflow-page-analyze";
  // Set once the issue is ready. From then on nothing writes pipeline_step,
  // and a masks-only retry never writes it either (#356).
  let ready = false;

  try {
    const pages = await getPageList(bookId, issueId);
    if (pages.length === 0) {
      throw new FatalError("No pages found for this issue");
    }

    // ── Phase 1: Vision Analysis ──────────────────────────────────────
    if (run("roboflow-page-analyze")) {
      currentStep = "roboflow-page-analyze";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(
        bookId,
        issueId,
        currentStep,
        pages.length,
      );
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
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    if (run("fetch-wiki-context")) {
      currentStep = "fetch-wiki-context";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(bookId, issueId, currentStep);
      await fetchWikiContextStep(bookId, issueId);
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    if (run("character-lookahead")) {
      currentStep = "character-lookahead";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(
        bookId,
        issueId,
        currentStep,
        pages.length,
      );
      for (const page of pages) {
        await characterLookaheadPage(bookId, issueId, page.pageNumber);
      }
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    // ── Phase 2: Human Review, Character Clusters ─────────────────────
    if (run("review-clusters")) {
      currentStep = "review-clusters";
      const timing = await recordStepStart(bookId, issueId, currentStep);
      // The characters stop always pauses (#349): the owner confirms the cast
      // even when every face has a name. The window closes before the gate
      // opens, so the pause is the gate wait's row and never this step's
      // time (#255).
      await recordStepEnd(bookId, issueId, currentStep, timing);
      await updatePipelineStep(bookId, issueId, currentStep, true);
      await recordGateWait(bookId, issueId, currentStep, "open");
      using clusterHook = createHook<{ approved: boolean }>({
        token: `ingest:${bookId}/${issueId}/cluster-review`,
      });
      await clusterHook;
      await recordGateWait(bookId, issueId, currentStep, "close");
    }

    // ── Phase 3: OCR + Context ────────────────────────────────────────
    if (run("get-context")) {
      currentStep = "get-context";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(
        bookId,
        issueId,
        currentStep,
        pages.length,
      );
      for (const page of pages) {
        await getContextPage(bookId, issueId, page.pageNumber);
      }
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    // ── Phase 4: Sort + Human Review ──────────────────────────────────
    if (run("sort-page-elements")) {
      currentStep = "sort-page-elements";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(
        bookId,
        issueId,
        currentStep,
        pages.length,
      );
      for (const page of pages) {
        await sortPageElements(bookId, issueId, page.pageNumber);
      }
      await addBubbleStyles(bookId, issueId);
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    if (run("review-pages")) {
      currentStep = "review-pages";
      // The window covers the pause setup and closes before the gate opens,
      // so the review time lands on the gate wait and not on this step.
      const timing = await recordStepStart(bookId, issueId, currentStep);
      await updatePipelineStep(bookId, issueId, currentStep, true);
      await recordStepEnd(bookId, issueId, currentStep, timing);
      await recordGateWait(bookId, issueId, currentStep, "open");
      using pageReviewHook = createHook<{ approved: boolean }>({
        token: `ingest:${bookId}/${issueId}/page-review`,
      });
      await pageReviewHook;
      await recordGateWait(bookId, issueId, currentStep, "close");
    }

    // ── Phase 5: Voice descriptions ───────────────────────────────────
    if (run("generate-voice-descriptions")) {
      currentStep = "generate-voice-descriptions";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(bookId, issueId, currentStep);
      await generateVoiceDescriptions(bookId, issueId);
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    // ── Phase 6: Casting ──────────────────────────────────────────────
    if (run("casting")) {
      currentStep = "casting";
      // The voices stop (#353): it pauses while a voice request is open or a
      // speaker has no voice and no "no audio this run" marker. The resume
      // route checks canContinueVoices, so the run goes on only once every
      // item is settled; nothing is written here after the hook.
      const timing = await recordStepStart(bookId, issueId, currentStep);
      const casting = await createCastingTasks(bookId, issueId);
      const unresolved = casting.unresolved.length;
      if (casting.pending === 0) {
        const reason =
          casting.cast === casting.speakers
            ? "all speakers cast"
            : "no voice work left";
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
        await recordStepEnd(bookId, issueId, currentStep, timing);
      } else {
        console.log(
          `[casting] paused: ${casting.cast} of ${casting.speakers} cast, ${casting.pending} pending, ${unresolved} unresolved${unresolved > 0 ? `: ${casting.unresolved.join(", ")}` : ""}`,
        );
        await recordStepEnd(bookId, issueId, currentStep, timing);
        await updatePipelineStep(bookId, issueId, currentStep, true);
        await recordGateWait(bookId, issueId, currentStep, "open");
        using castingHook = createHook<{ approved: boolean }>({
          token: `ingest:${bookId}/${issueId}/casting`,
        });
        await castingHook;
        await recordGateWait(bookId, issueId, currentStep, "close");
      }
    }

    // ── Phase 7: Audio ────────────────────────────────────────────────
    if (run("generate-audio")) {
      currentStep = "generate-audio";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(bookId, issueId, currentStep);
      const bubbleIds = await getBubbleIdsForAudio(bookId, issueId);
      const audioBatches = batchArray(bubbleIds, 20);
      for (const batch of audioBatches) {
        await generateAudioBatch(bookId, issueId, batch);
      }
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    // ── Phase 8: Publishing ───────────────────────────────────────────
    if (run("generate-manifest")) {
      currentStep = "generate-manifest";
      await updatePipelineStep(bookId, issueId, currentStep);
      const timing = await recordStepStart(bookId, issueId, currentStep);
      await generateManifest(bookId, issueId);
      await recordStepEnd(bookId, issueId, currentStep, timing);
    }

    // A masks-only retry leaves the issue row as it found it, so retrying
    // masks on an issue that failed earlier cannot publish it unfinished.
    if (from !== "extract-foreground-masks") {
      await markIssueReady(bookId, issueId);
    }
    ready = true;

    // ── Phase 9: Foreground masks, after ready (#356) ─────────────────
    // The reader opens the issue while this runs and after it fails. It
    // never writes pipeline_step: a failure lands on the run row only, as
    // steps.masksError, and the run still closes completed.
    if (run("extract-foreground-masks")) {
      try {
        const timing = await recordStepStart(
          bookId,
          issueId,
          "extract-foreground-masks",
          pages.length,
        );
        try {
          const maskBatches = batchArray(pages, 6);
          for (const batch of maskBatches) {
            await extractForegroundMasksBatch(bookId, issueId, batch);
          }
        } finally {
          await recordStepEnd(
            bookId,
            issueId,
            "extract-foreground-masks",
            timing,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[masks] ${bookId}/${issueId} failed: ${message}`);
        await recordMasksFailure(bookId, issueId, message);
      }
    }

    await closePipelineRun(bookId, issueId, "completed");

    return { bookId, issueId, status: "ready" };
  } catch (err) {
    await closePipelineRun(bookId, issueId, "failed");
    if (!ready && from !== "extract-foreground-masks") {
      // A failed failed-mark is logged, not thrown, so the run's own error
      // still reaches the caller.
      try {
        await markPipelineFailed(bookId, issueId, currentStep);
      } catch (markErr) {
        const original = err instanceof Error ? err.message : String(err);
        const message =
          markErr instanceof Error ? markErr.message : String(markErr);
        console.log(
          `[pipeline] ${bookId}/${issueId} failed at ${currentStep} (${original}), and marking the issue row failed did not land: ${message}`,
        );
      }
    }
    throw err;
  }
}
