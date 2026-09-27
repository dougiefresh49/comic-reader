import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeNewCharacterQueue } from "../../../scripts/utils/new-character-queue";

export interface UnresolvedFaceCounts {
  unresolvedDetections: number;
  unresolvedExemplars: number;
  /** Sum of detections + exemplars with character_id IS NULL. */
  total: number;
}

/**
 * Unresolved faces for (book, issue): detections on the issue's panels
 * with character_id IS NULL, plus exemplars for the issue with
 * character_id IS NULL. Same definition the cluster review UI uses.
 */
export async function countUnresolvedFaces(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<UnresolvedFaceCounts> {
  const { data: panels, error: panelsError } = await client
    .from("panels")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (panelsError) {
    throw new Error(
      `countUnresolvedFaces panels ${bookId}/${issueId}: ${panelsError.message}`,
    );
  }

  const panelIds = (panels ?? []).map((p) => p.id as string);
  let unresolvedDetections = 0;

  if (panelIds.length > 0) {
    const { count, error } = await client
      .from("panel_character_detections")
      .select("id", { count: "exact", head: true })
      .in("panel_id", panelIds)
      .is("character_id", null);

    if (error) {
      throw new Error(
        `countUnresolvedFaces detections ${bookId}/${issueId}: ${error.message}`,
      );
    }
    unresolvedDetections = count ?? 0;
  }

  const { count: exemplarCount, error: exemplarError } = await client
    .from("character_face_exemplars")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("source_issue", issueId)
    .is("character_id", null);

  if (exemplarError) {
    throw new Error(
      `countUnresolvedFaces exemplars ${bookId}/${issueId}: ${exemplarError.message}`,
    );
  }

  const unresolvedExemplars = exemplarCount ?? 0;
  return {
    unresolvedDetections,
    unresolvedExemplars,
    total: unresolvedDetections + unresolvedExemplars,
  };
}

/**
 * Pending new-character reviews for (book, issue). Calls
 * analyzeNewCharacterQueue without projectRoot (no filesystem reads).
 */
export async function countPendingNewCharacters(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<number> {
  const { pendingCount } = await analyzeNewCharacterQueue(
    client,
    bookId,
    issueId,
  );
  return pendingCount;
}
