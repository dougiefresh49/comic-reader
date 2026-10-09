/**
 * One render for a group of joined balloons (#451): the members' texts joined
 * into one line, spoken once in the lead's voice, stored as one clip that
 * every member points at. The audio step, the review editor's regenerate and
 * `scripts/backfill-balloon-groups.ts` all call this one function, so a group
 * sounds the same whichever of them renders it.
 *
 * The voice is the audio step's: `renderVoice` on the lead's `character_id`,
 * the voice's stored settings (`loadVoiceOverrides`) and `buildTtsRequest`.
 * The clip goes to a path no earlier clip used (`upsert: false`), so a
 * per-balloon clip is never overwritten (decision row 386), and
 * `switch_group_audio_take` moves every member to it in one transaction.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupLeadId, joinGroupText } from "~/lib/balloon-groups";
import { loadBookCast, renderVoice, type BookCast } from "~/lib/cast";
import { getElevenLabsClient } from "~/lib/elevenlabs-client";
import { recordElevenLabsCall } from "~/lib/llm-usage";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import {
  normalizeAlignment,
  type AlignmentRaw,
} from "~/workflows/steps/audio-plan";

const AUDIO_BUCKET = "comic-audio";

export type GroupRenderResult =
  | {
      rendered: true;
      leadId: string;
      memberIds: string[];
      /** The clip's file name, as `audio_storage_path` stores it. */
      path: string;
      /** Characters billed: the request text, voice prefix included. */
      characters: number;
      /** The lead's `audio_storage_path` before the switch. */
      previousPath: string | null;
    }
  /** Fewer than two active members: the caller renders the bubble alone. */
  | { skipped: "single" }
  /** A member has no text to speak. */
  | { skipped: "no-text"; memberId: string }
  /**
   * The group holds an ignored or silent row. `switch_group_audio_take` only
   * takes the exact group, and a silent or ignored balloon must not carry the
   * clip, so the owner splits it off first.
   */
  | { skipped: "inactive-member"; memberId: string }
  /**
   * The active members are not one run: not all in one panel, or another
   * voiced balloon sits between two of them in play order.
   */
  | { skipped: "non-adjacent"; detail: string }
  /** The active members have different speakers; a group has one. */
  | { skipped: "mixed-speakers"; detail: string }
  /** The lead's speaker has no voice to render with (`renderVoice`'s miss). */
  | { skipped: "no-voice"; leadId: string; detail: string }
  /**
   * The rows stopped forming this group between the read and the switch (an
   * editor split or re-join). The call was paid for; the clip was removed.
   */
  | { skipped: "stale-group"; detail: string };

/**
 * A failure at or after the paid call. `stage` says what the reader plays
 * now: before "switch" nothing changed; "unconfirmed" means the switch got
 * no usable answer and may have landed.
 */
export class GroupRenderError extends Error {
  constructor(
    readonly stage: "generate" | "upload" | "switch" | "unconfirmed",
    message: string,
    readonly memberIds: string[],
  ) {
    super(message);
    this.name = "GroupRenderError";
  }
}

/** The RPC's own raises for rows that no longer form the group. */
const STALE = /stale render|is not the first member|group members .* found/i;

export async function renderGroupAudio({
  client,
  bookId,
  issueId,
  groupId,
  step,
  book,
}: {
  /** A service-role client: the switch RPC is granted to service_role only. */
  client: SupabaseClient;
  bookId: string;
  issueId: string;
  groupId: string;
  /** The `llm_calls.step` the spend is recorded under. */
  step: string;
  /** The book's cast when the caller has it loaded already. */
  book?: BookCast;
}): Promise<GroupRenderResult> {
  const { data, error } = await client
    .from("bubbles")
    .select(
      "id, sort_order, panel_id, character_id, text_with_cues, ocr_text, ignored, silent",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("group_id", groupId)
    .order("sort_order")
    .order("id");
  if (error) throw new Error(`group ${groupId}: ${error.message}`);
  const rows = (data ?? []) as {
    id: string;
    sort_order: number;
    panel_id: string | null;
    character_id: string | null;
    text_with_cues: string | null;
    ocr_text: string | null;
    ignored: boolean;
    silent: boolean;
  }[];
  const members = rows.filter((r) => !r.ignored && !r.silent);
  if (members.length < 2) return { skipped: "single" };

  // A group is one run: consecutive voiced balloons in play order inside one
  // panel, unvoiced ones skipped, the same rule as the editor's.
  const panelId = members[0]!.panel_id;
  if (!panelId || members.some((m) => m.panel_id !== panelId))
    return {
      skipped: "non-adjacent",
      detail: "the members are not all in one panel",
    };
  const { data: panelRows, error: panelErr } = await client
    .from("bubbles")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("panel_id", panelId)
    .eq("ignored", false)
    .eq("silent", false)
    .order("sort_order")
    .order("id");
  if (panelErr) throw new Error(`group ${groupId}: ${panelErr.message}`);
  const order = ((panelRows ?? []) as { id: string }[]).map((r) => r.id);
  const at = order.indexOf(members[0]!.id);
  if (at === -1 || members.some((m, i) => order[at + i] !== m.id))
    return {
      skipped: "non-adjacent",
      detail: "another balloon sits between members in play order",
    };

  const speakers = new Set(members.map((m) => m.character_id));
  if (speakers.size > 1)
    return {
      skipped: "mixed-speakers",
      detail: [...speakers].map((s) => s ?? "(none)").join(", "),
    };

  // Kept as the last guard: the editor and the Save split an ignored or
  // silent balloon off its group, so a group should never hold one.
  const inactive = rows.find((r) => r.ignored || r.silent);
  if (inactive) return { skipped: "inactive-member", memberId: inactive.id };

  const texts: string[] = [];
  for (const m of members) {
    const t = (m.text_with_cues ?? m.ocr_text)?.trim();
    if (!t) return { skipped: "no-text", memberId: m.id };
    texts.push(t);
  }
  const text = joinGroupText(texts);
  const memberIds = members.map((m) => m.id);
  const leadId = groupLeadId(
    members.map((m) => ({ id: m.id, sortOrder: m.sort_order })),
  );
  const lead = members.find((m) => m.id === leadId)!;

  const cast = book ?? (await loadBookCast(client, bookId));
  const voice = renderVoice(cast, lead.character_id, issueId);
  if (!voice.ok) return { skipped: "no-voice", leadId, detail: voice.detail };
  const voiceId = voice.elevenLabsId;
  const overrides = await loadVoiceOverrides(client, [voiceId]);
  const request = buildTtsRequest({
    text,
    voiceId,
    override: overrides.get(voiceId),
  });

  let response;
  try {
    const tts = await getElevenLabsClient();
    response = await recordElevenLabsCall(
      { step, bookId, issueId, model: TTS_MODEL },
      request.text.length,
      () => tts.textToSpeech.convertWithTimestamps(voiceId, request),
    );
  } catch (e) {
    throw new GroupRenderError("generate", (e as Error).message, memberIds);
  }

  const path = `${leadId}-group-${randomUUID().slice(0, 8)}.mp3`;
  const remotePath = `${bookId}/${issueId}/${path}`;
  const { error: upErr } = await client.storage
    .from(AUDIO_BUCKET)
    .upload(remotePath, Buffer.from(response.audioBase64, "base64"), {
      contentType: "audio/mpeg",
      upsert: false,
    });
  if (upErr) throw new GroupRenderError("upload", upErr.message, memberIds);

  const removeClip = async () => {
    const { error: rmErr } = await client.storage
      .from(AUDIO_BUCKET)
      .remove([remotePath])
      .catch((e: Error) => ({ error: e }));
    if (rmErr)
      console.warn(
        `[group-audio] could not remove unused ${remotePath} (${rmErr.message})`,
      );
  };

  let switched;
  try {
    switched = await client.rpc("switch_group_audio_take", {
      p_book_id: bookId,
      p_issue_id: issueId,
      p_group_id: groupId,
      p_member_ids: memberIds,
      p_lead_id: leadId,
      p_audio_storage_path: path,
      p_voice_id: voice.voiceUuid,
      p_alignment: normalizeAlignment(
        response.alignment as AlignmentRaw | null | undefined,
      ),
      p_normalized_alignment: normalizeAlignment(
        response.normalizedAlignment as AlignmentRaw | null | undefined,
      ),
    });
  } catch (e) {
    throw new GroupRenderError("unconfirmed", (e as Error).message, memberIds);
  }
  const { error: switchErr, status } = switched;
  const previous = switched.data as string | null;
  if (switchErr) {
    // Only a coded answer below 500 proves the rollback; otherwise the
    // transaction may still commit, so the clip stays.
    if (!switchErr.code || status === 0 || status >= 500)
      throw new GroupRenderError("unconfirmed", switchErr.message, memberIds);
    await removeClip();
    if (STALE.test(switchErr.message))
      return { skipped: "stale-group", detail: switchErr.message };
    throw new GroupRenderError("switch", switchErr.message, memberIds);
  }

  return {
    rendered: true,
    leadId,
    memberIds,
    path,
    characters: request.text.length,
    previousPath: previous ?? null,
  };
}
