import type { SupabaseClient } from "@supabase/supabase-js";
import { FatalError } from "workflow";
import {
  analyzeNewCharacterQueue,
  NEW_CHARACTER_SPEECH_TYPES,
} from "../../../scripts/utils/new-character-queue";

export interface UnresolvedFaceCounts {
  unresolvedDetections: number;
  unresolvedExemplars: number;
  /** Sum of detections + exemplars with character_id IS NULL. */
  total: number;
}

/** Bubble fields the new-character empty-analysis guard inspects. */
export type AnalyzableSpeakerBubble = {
  type: string;
  ignored: boolean | null;
  speaker: string | null;
};

/**
 * Same bubble set analyzeNewCharacterQueue aggregates: speech types only,
 * not ignored, speaker non-blank after trim.
 */
export function filterAnalyzableSpeakerBubbles(
  bubbles: AnalyzableSpeakerBubble[],
): AnalyzableSpeakerBubble[] {
  const speechTypes: readonly string[] = NEW_CHARACTER_SPEECH_TYPES;
  return bubbles.filter(
    (b) =>
      speechTypes.includes(b.type) && !b.ignored && Boolean(b.speaker?.trim()),
  );
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
 * Probes bubbles first so a failed read cannot look like an empty queue.
 */
export async function countPendingNewCharacters(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<number> {
  // Head count before the helper: its bubbles failure path returns empty
  // lists and pendingCount 0, which would skip the gate.
  const { error: bubbleError } = await client
    .from("bubbles")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (bubbleError) {
    throw new FatalError(
      `countPendingNewCharacters bubbles ${bookId}/${issueId}: ${bubbleError.message}`,
    );
  }

  const { autoResolved, queue, pendingCount } = await analyzeNewCharacterQueue(
    client,
    bookId,
    issueId,
  );

  // Zero resolved + zero pending with analyzable speaker bubbles means the
  // helper's bubbles read failed (same masked empty return). Match the
  // helper's own filters so SFX / ignored / blank speakers do not trip this.
  if (autoResolved.length === 0 && queue.length === 0) {
    const { data: speakerRows, error: speakerError } = await client
      .from("bubbles")
      .select("type, ignored, speaker")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("type", [...NEW_CHARACTER_SPEECH_TYPES])
      .not("ignored", "is", true);

    if (speakerError) {
      throw new FatalError(
        `countPendingNewCharacters bubbles ${bookId}/${issueId}: ${speakerError.message}`,
      );
    }

    const analyzable = filterAnalyzableSpeakerBubbles(
      (speakerRows ?? []) as AnalyzableSpeakerBubble[],
    );
    if (analyzable.length > 0) {
      throw new FatalError(
        `countPendingNewCharacters bubbles ${bookId}/${issueId}: analyzeNewCharacterQueue returned empty with speaker-bearing bubbles present`,
      );
    }
  }

  return pendingCount;
}
