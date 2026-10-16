/**
 * What the audio step would send for an issue right now (#106), without
 * sending it. `loadAudioJobs` is the step's own job selection
 * (`getAudioJobs` wraps it), and `estimateIssueAudio` walks those jobs with
 * the step's voice plan, so the casting page's estimate and the step cannot
 * pick different bubbles. Reads only: no paid call, no `llm_calls` row (the
 * cost report counts every row there as spend).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookCast, type NoVoiceReason } from "~/lib/cast";
import { chunk } from "~/lib/chunk";
import { prepareGroupRender } from "~/lib/render-group-audio";
import { buildTtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import {
  bubbleNeedsAudio,
  collapseAudioJobs,
  planBubbleVoices,
  type AudioJob,
  type BubbleAudioRow,
} from "~/workflows/steps/audio-plan";

/**
 * The audio step's work: the bubbles with no audio that `bubbleNeedsAudio`,
 * as jobs (`collapseAudioJobs`). Members of a joined group (#451) with two or
 * more active members fold into one job for the group. Throws on a read
 * error. `selected` is the number of bubbles behind the jobs.
 */
export async function loadAudioJobs(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<{ jobs: AudioJob[]; selected: number }> {
  const { data: bubbles, error } = await client
    .from("bubbles")
    .select(
      "id, speaker, ignored, silent, audio_storage_path, text_with_cues, ocr_text, page_number, sort_order, group_id",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
    .eq("silent", false)
    .is("audio_storage_path", null)
    .order("page_number")
    .order("sort_order");
  if (error) throw new Error(error.message);

  const selected = (
    (bubbles ?? []) as (BubbleAudioRow & { group_id: string | null })[]
  ).filter((b) => bubbleNeedsAudio(b));

  // Active members per group, counted over the whole group (members that
  // already have audio included), so a group with one member selected still
  // renders as a group.
  const groupIds = [
    ...new Set(selected.flatMap((b) => (b.group_id ? [b.group_id] : []))),
  ];
  const activeGroupSize = new Map<string, number>();
  for (const ids of chunk(groupIds, 100)) {
    const { data: members, error: gErr } = await client
      .from("bubbles")
      .select("group_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .in("group_id", ids);
    if (gErr) throw new Error(gErr.message);
    for (const m of (members ?? []) as { group_id: string | null }[]) {
      if (m.group_id)
        activeGroupSize.set(
          m.group_id,
          (activeGroupSize.get(m.group_id) ?? 0) + 1,
        );
    }
  }

  return {
    jobs: collapseAudioJobs(selected, activeGroupSize),
    selected: selected.length,
  };
}

export interface AudioEstimate {
  /** Lines that would get new audio: single bubbles plus every group member. */
  lines: number;
  /** Paid calls: one per single bubble, one per group. */
  jobs: number;
  /** Request text over those calls, voice prefix included, as ElevenLabs bills it. */
  characters: number;
  /** Selected lines skipped for want of a voice: unassigned, no voice, or not in a slot. */
  waiting: number;
}

/** The skips that wait on casting, not on an owner's choice of silence. */
const WAITING: ReadonlySet<NoVoiceReason> = new Set<NoVoiceReason>([
  "unassigned",
  "no voice",
  "not in a slot",
]);

/**
 * The audio step's next run for this issue, counted: the same jobs
 * (`loadAudioJobs`), the same voices (`planBubbleVoices` for single bubbles,
 * `prepareGroupRender` for groups) and the same request text
 * (`buildTtsRequest`). A group the step would skip for another reason (not
 * one run, mixed speakers, a member with no text) is in none of the counts.
 */
export async function estimateIssueAudio(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<AudioEstimate> {
  const [{ jobs }, book] = await Promise.all([
    loadAudioJobs(client, bookId, issueId),
    loadBookCast(client, bookId),
  ]);
  const out: AudioEstimate = { lines: 0, jobs: 0, characters: 0, waiting: 0 };

  const singles: string[] = [];
  for (const job of jobs) {
    if ("bubbleId" in job) {
      singles.push(job.bubbleId);
      continue;
    }
    const plan = await prepareGroupRender({
      client,
      bookId,
      issueId,
      groupId: job.groupId,
      book,
    });
    if (!("skipped" in plan)) {
      out.lines += plan.memberIds.length;
      out.jobs++;
      out.characters += plan.request.text.length;
    } else if (plan.skipped === "single") {
      singles.push(...job.bubbleIds);
    } else if (plan.skipped === "no-voice" && WAITING.has(plan.reason)) {
      out.waiting += job.bubbleIds.length;
    }
  }
  if (singles.length === 0) return out;

  const rows: (BubbleAudioRow & { character_id: string | null })[] = [];
  for (const ids of chunk(singles, 100)) {
    const { data, error } = await client
      .from("bubbles")
      .select(
        "id, speaker, character_id, text_with_cues, ocr_text, audio_storage_path, ignored, silent",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
  }

  const plan = planBubbleVoices(rows, book, issueId);
  for (const s of plan.skipped)
    if (s.lookup && !s.lookup.ok && WAITING.has(s.lookup.reason)) out.waiting++;
  const overrides = await loadVoiceOverrides(
    client,
    plan.toSend.map((s) => s.lookup.elevenLabsId),
  );
  for (const { bubble, lookup } of plan.toSend) {
    const request = buildTtsRequest({
      text: (bubble.text_with_cues ?? bubble.ocr_text)!,
      voiceId: lookup.elevenLabsId,
      override: overrides.get(lookup.elevenLabsId),
    });
    out.lines++;
    out.jobs++;
    out.characters += request.text.length;
  }
  return out;
}
