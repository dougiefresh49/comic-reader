"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { isDryRun } from "~/lib/fakes/dry-run";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  BubbleRenderError,
  renderBubbleAudio,
  type BubbleRenderResult,
} from "~/lib/render-bubble-audio";
import {
  GroupRenderError,
  renderGroupAudio,
  type GroupRenderResult,
} from "~/lib/render-group-audio";

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string;
}

type Step = "generate" | "upload" | "switch" | "unconfirmed" | "refresh";

const PIPELINE_AGAIN =
  " The next pipeline audio run will generate this bubble again and spend credits.";

/**
 * The error for a failure at or after the paid ElevenLabs call: what the
 * reader plays now, and that a retry spends credits again. The reader of
 * this text is the owner in the review editor. `unconfirmed` is a switch
 * call with no usable answer from the database, so it may have saved;
 * `readerRoute` is the reader page to check it on.
 */
function afterSpendError(
  step: Step,
  bubbleId: string,
  hadAudio: boolean,
  message: string,
  readerRoute = "",
) {
  const saved =
    step === "generate"
      ? `Generating audio for bubble ${bubbleId} failed (${message}), and ElevenLabs may have charged for it.`
      : step === "upload"
        ? `Audio for bubble ${bubbleId} was generated and paid for, but the Storage upload failed (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
        : step === "switch"
          ? `Audio for bubble ${bubbleId} was generated and paid for, but its word timings and audio path did not save (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
          : step === "unconfirmed"
            ? `Audio for bubble ${bubbleId} was generated and paid for, but saving its word timings and audio path got no usable answer from the database (${message}), so it may still have saved. ${hadAudio ? "The reader plays either the old take or the new one, each with its own timings." : "The bubble has either no audio or the new take with its own timings."} Open ${readerRoute} and tap the bubble to hear which.${hadAudio ? "" : " If it has no audio, the next pipeline audio run will generate this bubble again and spend credits."}`
            : `The new audio and word timings for bubble ${bubbleId} are saved, but the page refresh failed (${message}), so the reader may ${hadAudio ? "play the old take" : "show this bubble with no audio"} for up to a day.`;
  return {
    ok: false as const,
    error: `${saved} Regenerating will spend ElevenLabs credits again.`,
  };
}

/**
 * Regenerate a joined group's audio (#451): one clip for every member,
 * through `renderGroupAudio`, the same render the audio step makes. The
 * members stay on their old clips until `switch_group_audio_take` commits.
 */
async function regenerateGroup(
  args: Args,
  b: { id: string; audio_storage_path: string | null; page_number: number },
  groupId: string,
): Promise<
  | { ok: false; error: string }
  | { ok: true; audioStoragePath: string; memberIds: string[] }
> {
  const hadAudio = b.audio_storage_path != null;
  const readerRoute = `/book/${args.bookId}/${args.issueId}/${b.page_number}`;
  const who = `${b.id}'s group`;
  let result: GroupRenderResult;
  try {
    result = await renderGroupAudio({
      client: supabaseAdmin,
      bookId: args.bookId,
      issueId: args.issueId,
      groupId,
      step: "review-editor:regenerate-group",
    });
  } catch (e) {
    if (!(e instanceof GroupRenderError))
      return { ok: false, error: (e as Error).message };
    if (e.stage === "unconfirmed") {
      try {
        revalidatePath(readerRoute);
      } catch (re) {
        console.warn(
          `[regenerate-audio] could not refresh ${readerRoute} (${(re as Error).message})`,
        );
      }
    }
    return afterSpendError(e.stage, who, hadAudio, e.message, readerRoute);
  }

  if ("rendered" in result) {
    try {
      revalidatePath(readerRoute);
    } catch (e) {
      return afterSpendError("refresh", who, hadAudio, (e as Error).message);
    }
    return {
      ok: true,
      audioStoragePath: result.path,
      memberIds: result.memberIds,
    };
  }
  const nothingSpent = " Nothing was spent.";
  switch (result.skipped) {
    case "single":
      return {
        ok: false,
        error: `The group no longer has two active balloons, so nothing was rendered. Reload the editor and regenerate again.${nothingSpent}`,
      };
    case "no-text":
      return {
        ok: false,
        error: `Balloon ${result.memberId} in this group has no text, so the group was not rendered.${nothingSpent}`,
      };
    case "inactive-member":
      return {
        ok: false,
        error: `Balloon ${result.memberId} in this group is silent or ignored, so the group was not rendered. Split it off the group, save, then regenerate.${nothingSpent}`,
      };
    case "non-adjacent":
      return {
        ok: false,
        error: `This group is not one run of balloons side by side in one panel (${result.detail}), so it was not rendered. Split off the stray balloon, save, then regenerate.${nothingSpent}`,
      };
    case "mixed-speakers":
      return {
        ok: false,
        error: `The balloons in this group have different speakers (${result.detail}), so it was not rendered. Pick one speaker for the group, save, then regenerate.${nothingSpent}`,
      };
    case "no-voice":
      return {
        ok: false,
        error: `The group's first balloon has no voice to render with (${result.detail}).${nothingSpent}`,
      };
    case "stale-group":
      return {
        ok: false,
        error: `The group changed while its audio was rendering (${result.detail}). ElevenLabs charged for the take, and it was not stored, so the reader plays what it played before. Regenerating will spend ElevenLabs credits again.`,
      };
  }
}

export async function regenerateAudio(args: Args) {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  if (!process.env.ELEVENLABS_API_KEY) {
    return { ok: false, error: "ELEVENLABS_API_KEY not configured" };
  }
  if (isDryRun()) {
    return {
      ok: false,
      error:
        "DRY_RUN is set, so the client would return silent audio. Unset it to regenerate for real.",
    };
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.bubbleId,
    );
  const bubbleQ = supabaseAdmin
    .from("bubbles")
    .select(
      "id, legacy_id, speaker, character_id, ocr_text, text_with_cues, type, ignored, audio_storage_path, page_number, book_id, issue_id, group_id",
    )
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId);
  const { data: bubble, error: bErr } = await (isUuid
    ? bubbleQ.eq("id", args.bubbleId).maybeSingle()
    : bubbleQ.eq("legacy_id", args.bubbleId).maybeSingle());

  if (bErr || !bubble) {
    return { ok: false, error: bErr?.message ?? "Bubble not found" };
  }
  type BubbleRow = {
    id: string;
    legacy_id: string | null;
    speaker: string | null;
    character_id: string | null;
    ocr_text: string | null;
    text_with_cues: string | null;
    type: string;
    ignored: boolean | null;
    audio_storage_path: string | null;
    page_number: number;
    group_id: string | null;
  };
  const b = bubble as BubbleRow;

  if (b.ignored) {
    return { ok: false, error: "Bubble is ignored — cannot regenerate audio" };
  }

  // A member of a joined group (#451) with two or more active members
  // renders the whole group as one clip.
  if (b.group_id) {
    const { count, error: gErr } = await supabaseAdmin
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId)
      .eq("group_id", b.group_id)
      .eq("ignored", false)
      .eq("silent", false);
    if (gErr) return { ok: false, error: gErr.message };
    if ((count ?? 0) >= 2) return regenerateGroup(args, b, b.group_id);
  }
  if (!b.speaker && !b.character_id) {
    return { ok: false, error: "No speaker assigned" };
  }
  // A concrete URL with no type: its tag is the page's own pathname tag.
  const readerRoute = `/book/${args.bookId}/${args.issueId}/${b.page_number}`;
  const hadAudio = b.audio_storage_path != null;

  let result: BubbleRenderResult;
  try {
    result = await renderBubbleAudio({
      client: supabaseAdmin,
      bookId: args.bookId,
      issueId: args.issueId,
      bubble: b,
      step: "review:regenerate-audio",
    });
  } catch (e) {
    if (!(e instanceof BubbleRenderError))
      return { ok: false, error: (e as Error).message };
    if (e.stage === "unconfirmed") {
      // The switch may have saved: revalidate the reader page, so a cached
      // one would show which.
      try {
        revalidatePath(readerRoute);
      } catch (re) {
        console.warn(
          `[regenerate-audio] could not refresh ${readerRoute} (${(re as Error).message})`,
        );
      }
    }
    return afterSpendError(e.stage, b.id, hadAudio, e.message, readerRoute);
  }
  if ("skipped" in result) {
    return {
      ok: false,
      error: result.skipped === "no-text" ? "Empty text" : result.detail,
    };
  }

  try {
    revalidatePath(readerRoute);
  } catch (e) {
    return afterSpendError("refresh", b.id, hadAudio, (e as Error).message);
  }
  return {
    ok: true,
    audioStoragePath: result.path,
    memberIds: [b.id],
  };
}
