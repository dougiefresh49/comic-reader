import { FatalError } from "workflow";
import { isDryRun } from "~/lib/fakes/dry-run";
import {
  WordGeometryDataError,
  wordGeometryForPage,
} from "~/lib/word-geometry-page";

/**
 * Word boxes for one page (#573), as a Workflow step: the work is
 * `wordGeometryForPage` in `src/lib/word-geometry-page.ts`, shared with the review editor's Save.
 */
export async function wordGeometryPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  // Checked before any page work, so a missing key fails the run at
  // `failed:word-geometry` instead of the engine's plain (retried) error.
  if (!isDryRun()) {
    const { env } = await import("~/env.mjs");
    if (!env.GOOGLE_CLOUD_VISION_API_KEY) {
      throw new FatalError(
        "GOOGLE_CLOUD_VISION_API_KEY required for the word-geometry step",
      );
    }
  }

  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  try {
    return await wordGeometryForPage(supabase, bookId, issueId, pageNumber);
  } catch (err) {
    // A data failure is not cured by a retry; a Cloud Vision error is.
    if (err instanceof WordGeometryDataError) throw new FatalError(err.message);
    throw err;
  }
}
