"use server";

/**
 * The voices stop's writes (#353). Every way of settling an item goes
 * through `settle`; Run goes through `carryOut` with the voice the owner
 * named; "needs attention" goes through `reconcile`. Choosing a clone or a
 * design records it as a voice request first (`storeVoiceRequest`), so the
 * plan shows the slot it takes before Run is clicked.
 *
 * Spends, each only on the owner's click: Run (an ElevenLabs add, perhaps an
 * archive, and for a design with no stored description one GEMINI_MEDIUM
 * call), Restore (an ElevenLabs add), and a sample play (short TTS).
 */
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast, storeVoiceRequest, voiceFor } from "~/lib/cast";
import { getElevenLabsClient } from "~/lib/elevenlabs-client";
import { recordElevenLabsCall } from "~/lib/llm-usage";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import {
  carryOut,
  planVoiceWork,
  reconcile,
  settle,
  type CarryOutResult,
  type SettleOutcome,
  type VoiceWorkAction,
} from "~/lib/voice-requests";
import { readVoice } from "~/lib/voice-slots";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import { clearNoAudio as clearNoAudioRows } from "~/server/admin/casting";
import { canContinueVoices } from "~/server/admin/voices-gate";
import { requireAdmin } from "~/server/admin/require-admin";
import { hookToken } from "~/lib/ingest-hooks";
import {
  executeVoiceOperation,
  planVoiceOperation,
} from "~/app/admin/voices/actions";

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

interface Scope {
  bookId: string;
  issueId: string;
}

/** The item as the screen last saw it; the server checks it against a fresh plan before spending. */
export interface ItemRef {
  characterId: string;
  action: VoiceWorkAction;
  targetId: string | null;
  /** The character's active designed voices on the plan the page showed (#458). */
  designedVoices: string[];
}

function revalidate({ bookId, issueId }: Scope) {
  revalidatePath(
    `/admin/${bookId}/${issueId}/review/characters/voices`,
    "page",
  );
}

function fail(what: string, err: unknown): ActionResult {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`voices stop, ${what}:`, err);
  return { ok: false, error: message };
}

/** The key `settle` and `reconcile` take; the target is read by id. */
async function itemKey(scope: Scope, item: ItemRef) {
  const target = item.targetId
    ? await readVoice(supabaseAdmin, item.targetId)
    : null;
  return {
    bookId: scope.bookId,
    issueId: scope.issueId,
    characterId: item.characterId,
    action: item.action,
    target,
  };
}

async function settleWith(
  scope: Scope,
  item: ItemRef,
  outcome: SettleOutcome,
  message: string,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    await settle(supabaseAdmin, await itemKey(scope, item), outcome);
    revalidate(scope);
    return { ok: true, message };
  } catch (err) {
    revalidate(scope);
    return fail("settling", err);
  }
}

/** An active voice, no slot: settles the item. */
export async function pickActiveVoice(args: {
  scope: Scope;
  item: ItemRef;
  voice: { id: string; name: string };
}): Promise<ActionResult> {
  return settleWith(
    args.scope,
    args.item,
    { kind: "pick", voiceUuid: args.voice.id },
    `${args.voice.name} it is.`,
  );
}

/** "No audio this run": `no_audio` on the issue's castlist row, through `settle`. */
export async function noAudio(args: {
  scope: Scope;
  item: ItemRef;
}): Promise<ActionResult> {
  const { bookId } = args.scope;
  const id = args.item.characterId;
  try {
    await requireAdmin();
    const hit = (await loadBookCast(supabaseAdmin, bookId)).resolve(id);
    if (hit?.id !== id)
      // The key is no character id: the page is stale, never skip `settle` for it.
      return {
        ok: false,
        error: `"${id}" is not a character id${hit ? `; it names ${hit.display_name ?? hit.id}` : ""}. Reload the page.`,
      };
  } catch (err) {
    revalidate(args.scope);
    return fail("no audio", err);
  }
  return settleWith(
    args.scope,
    args.item,
    { kind: "no audio" },
    "No audio this run.",
  );
}

/** Takes the "no audio this run" mark off; the item is voice work again. */
export async function clearNoAudio(args: {
  scope: Scope;
  characterId: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const rows = await clearNoAudioRows(
      args.scope.bookId,
      args.scope.issueId,
      args.characterId,
    );
    revalidate(args.scope);
    return rows > 0
      ? { ok: true, message: "Cleared. It needs a voice again." }
      : { ok: false, error: "No mark to clear." };
  } catch (err) {
    return fail("clearing no audio", err);
  }
}

/** Records the choice of a voice-lab clone or a new designed voice; Run makes it. */
export async function chooseVoice(args: {
  scope: Scope;
  characterId: string;
  choice:
    | { kind: "clone"; voice: { id: string; name: string } }
    | {
        kind: "design";
      };
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    await storeVoiceRequest(
      supabaseAdmin,
      args.scope.bookId,
      args.scope.issueId,
      args.characterId,
      args.choice.kind === "clone"
        ? { action: "clone", targetVoiceUuid: args.choice.voice.id }
        : { action: "design" },
    );
    revalidate(args.scope);
    return {
      ok: true,
      message:
        args.choice.kind === "clone"
          ? `${args.choice.voice.name} chosen. Check the plan, then Run.`
          : "A new designed voice chosen. Check the plan, then Run.",
    };
  } catch (err) {
    return fail("choosing", err);
  }
}

function describe(result: CarryOutResult): ActionResult {
  switch (result.status) {
    case "done":
      return {
        ok: true,
        message: [
          `Made. ${result.archived ? `${result.archived.name} archived. ` : ""}Play a line, then accept it or run again.`,
          ...result.warnings,
        ].join(" "),
      };
    case "refused":
      return { ok: false, error: `Refused: ${result.reasons.join("; ")}` };
    case "failed":
      return {
        ok: false,
        error: `Not made: ${result.reasons.join("; ")}${result.restored ? ` (${result.restored} restored)` : ""}`,
      };
    case "needs attention":
      return {
        ok: false,
        error: `Needs attention: ${result.reasons.join("; ")}${result.archived ? ` ${result.archived.name} is archived.` : ""}`,
      };
  }
}

/**
 * Run: carries the item out, archiving only the voice the owner named
 * (null: a free slot). Refused when the item changed since the screen
 * loaded, so the plan he saw is the plan that runs.
 */
export async function runItem(args: {
  scope: Scope;
  item: ItemRef;
  archiveVoiceId: string | null;
}): Promise<ActionResult> {
  const { scope, item } = args;
  try {
    await requireAdmin();
    const deps = { supabase: supabaseAdmin };
    const plan = await planVoiceWork(deps, scope.bookId, scope.issueId);
    const fresh = plan.items.find((i) => i.characterId === item.characterId);
    // A designed voice the page did not show was made since it loaded,
    // perhaps by another issue's run from the same stored row (#458).
    const seen = new Set(item.designedVoices);
    if (
      !fresh ||
      fresh.action !== item.action ||
      (fresh.target?.id ?? null) !== item.targetId ||
      fresh.designedVoices.some((id) => !seen.has(id))
    ) {
      revalidate(scope);
      return {
        ok: false,
        error: "The item changed since this page loaded. Check the plan again.",
      };
    }
    // Run is offered only on a pending item that takes a slot.
    if (fresh.state !== "pending" || !fresh.needsSlot) {
      revalidate(scope);
      return {
        ok: false,
        error: `Refused: the item is ${fresh.state}${fresh.refusals.length ? `: ${fresh.refusals.join("; ")}` : ""}.`,
      };
    }
    // Casting-step clones need a target; request-sourced ones already have one.
    if (
      fresh.source !== "request" &&
      fresh.action !== "design" &&
      !fresh.target
    )
      return { ok: false, error: "Refused: no voice to clone." };
    // carryOut's claim writes the request on the item's row (inserting or
    // converting a casting-step row) and gives it back as it found it when
    // the run is refused or fails, so a made voice stays listed as "made"
    // until accepted.
    const result = await carryOut(
      deps,
      { ...fresh, designedVoices: item.designedVoices },
      { archiveVoiceId: args.archiveVoiceId },
    );
    revalidate(scope);
    return describe(result);
  } catch (err) {
    // Nothing to undo here; carryOut released before throwing.
    revalidate(scope);
    return fail("running", err);
  }
}

/** Accepts the voice Run made: settles the item. */
export async function acceptVoice(args: {
  scope: Scope;
  item: ItemRef;
}): Promise<ActionResult> {
  return settleWith(args.scope, args.item, { kind: "accept" }, "Accepted.");
}

/** Run again: the made voice stays active, the item goes back to pending with the next voice to try. */
export async function runAgain(args: {
  scope: Scope;
  item: ItemRef;
  targetVoiceId: string | null;
}): Promise<ActionResult> {
  return settleWith(
    args.scope,
    args.item,
    {
      kind: "rerun",
      ...(args.targetVoiceId ? { targetVoiceUuid: args.targetVoiceId } : {}),
    },
    "Back to pending. Check the plan, then Run.",
  );
}

/** "Needs attention": settles the recorded operation from what ElevenLabs shows. Free. */
export async function checkAgain(args: {
  scope: Scope;
  item: ItemRef;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const result = await reconcile(
      { supabase: supabaseAdmin },
      await itemKey(args.scope, args.item),
    );
    revalidate(args.scope);
    return describe(result);
  } catch (err) {
    revalidate(args.scope);
    return fail("checking", err);
  }
}

/** Restore: brings an archived voice back from its bucket copy, through /admin/voices' guarded restore. */
export async function restoreVoice(args: {
  scope: Scope;
  voiceId: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const planned = await planVoiceOperation(args.voiceId, "restore");
    if (!planned.ok) return { ok: false, error: planned.error };
    if (!planned.plan.eligible)
      return {
        ok: false,
        error: `Refused: ${planned.plan.refusals.join("; ")}`,
      };
    const done = await executeVoiceOperation(
      args.voiceId,
      "restore",
      planned.plan.token,
    );
    revalidate(args.scope);
    return done.ok
      ? { ok: true, message: `${planned.plan.voiceName} restored.` }
      : { ok: false, error: done.message };
  } catch (err) {
    return fail("restoring", err);
  }
}

/**
 * Plays one of the character's first three lines in this issue in its
 * voice now. Short test audio; nothing is saved to `bubbles` or Storage.
 */
export async function playSample(args: {
  scope: Scope;
  characterId: string;
  bubbleId: string;
}): Promise<{ ok: true; audio: string } | { ok: false; error: string }> {
  const { bookId, issueId } = args.scope;
  try {
    await requireAdmin();
    const book = await loadBookCast(supabaseAdmin, bookId);
    const line = (await readSpeakerLines(supabaseAdmin, bookId, issueId))
      .get(args.characterId)
      ?.filter((l) => l.text)
      .slice(0, 3)
      .find((l) => l.bubbleId === args.bubbleId);
    if (!line)
      return {
        ok: false,
        error: "That line is not one of the character's first three here.",
      };
    // Only an active voice plays; an archived one is off the account.
    const voiceId = voiceFor(book, args.characterId, issueId)?.elevenLabsId;
    if (!voiceId)
      return { ok: false, error: "The character has no voice to play." };
    const overrides = await loadVoiceOverrides(supabaseAdmin, [voiceId]);
    const request = buildTtsRequest({
      text: line.text,
      voiceId,
      override: overrides.get(voiceId),
    });
    const client = await getElevenLabsClient();
    const response = await recordElevenLabsCall(
      { step: "voices-stop:sample", bookId, issueId, model: TTS_MODEL },
      request.text.length,
      () => client.textToSpeech.convertWithTimestamps(voiceId, request),
    );
    return { ok: true, audio: response.audioBase64 };
  } catch (err) {
    console.error("voices stop, sample:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Continue: the gate first, then the `casting` hook resumes and the run goes on to audio. */
export async function continueRun(scope: Scope): Promise<ActionResult> {
  try {
    await requireAdmin();
    const verdict = await canContinueVoices(scope.bookId, scope.issueId);
    if (!verdict.ok) {
      revalidate(scope);
      return { ok: false, error: verdict.reason };
    }
    const token = hookToken(scope.bookId, scope.issueId, "casting");
    try {
      const { resumeHook } = await import(
        /* webpackIgnore: true */
        /* turbopackIgnore: true */
        "workflow/api"
      );
      await resumeHook(token, { approved: true });
    } catch (err) {
      revalidate(scope);
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Every item is settled, but no paused run took it: ${message}`,
      };
    }
    revalidate(scope);
    return {
      ok: true,
      message: "Continued. The pipeline is making the audio.",
    };
  } catch (err) {
    return fail("continuing", err);
  }
}
