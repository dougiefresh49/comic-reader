"use server";

/**
 * The casting page's immediate writes: the Faces work (each saves the
 * moment it is made and answers with a line the screen shows), the free
 * voice preview, and the two pipeline pauses' buttons. Everything else on
 * the page is staged and goes through `casting-actions.ts` at Confirm.
 * Faces and exemplars are written here, by the row that was clicked (#349:
 * never "the first detection on that page").
 */
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { addToCast, createCharacter, loadBookCast, voiceFor } from "~/lib/cast";
import {
  VOICE_CLIPS_BUCKET,
  clipObjectPath,
  readVoice,
} from "~/lib/voice-slots";
import { audioUrl } from "~/lib/storage";
import { elevenLabsFetch, getElevenLabsClient } from "~/lib/elevenlabs-client";
import { recordElevenLabsCall } from "~/lib/llm-usage";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import { VOICE_SAMPLE_LINE, voiceSamplePath } from "~/lib/voice-sample";
import { slugify } from "~/lib/character-id";
import { deleteExemplars } from "~/lib/exemplar-store";
import {
  canApproveCharacters,
  readUnknownDetections,
} from "~/server/admin/characters-gate";
import { canContinueVoices } from "~/server/admin/voices-gate";
import { requireAdmin } from "~/server/admin/require-admin";
import { hookToken } from "~/lib/ingest-hooks";

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * `voicePreview`'s and `makeVoiceSample`'s answer: a playable URL and where
 * it came from ("clip", "this issue", "this book", "from <book>", "sample"),
 * or null when the voice has no audio anywhere, with whether Make a sample
 * can render one; or a failure.
 */
export type PreviewResult =
  | { ok: true; url: string; from: string }
  | { ok: true; url: null; canMakeSample: boolean }
  | { ok: false; error: string };

/** Who an unknown group, a face or a wiki name is named as: a `characters` row, or a new one by name. */
export type NameTarget =
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string };

interface Scope {
  bookId: string;
  issueId: string;
}

function revalidate({ bookId, issueId }: Scope) {
  revalidatePath(`/admin/${bookId}/${issueId}/review/characters`, "page");
}

function fail(what: string, err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`characters stop, ${what}:`, err);
  return { ok: false, error: message };
}

function must(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/**
 * The `characters.id` the target means, creating the row when the name is
 * new. A typed name that already names a row (id, display name or alias)
 * is that row, never a second one.
 */
async function resolveTarget(
  bookId: string,
  target: NameTarget,
  franchiseId: string | null,
): Promise<{ id: string; name: string; created: boolean }> {
  const book = await loadBookCast(supabaseAdmin, bookId);
  if (target.kind === "existing") {
    const row = book.resolve(target.id);
    if (row?.id !== target.id) throw new Error(`no character "${target.id}"`);
    return { id: row.id, name: row.display_name ?? row.id, created: false };
  }
  const name = target.name.trim();
  const id = slugify(name);
  if (!id) throw new Error("a name is needed");
  const row = book.resolve(name);
  if (row) {
    return { id: row.id, name: row.display_name ?? row.id, created: false };
  }
  await createCharacter(supabaseAdmin, { id, displayName: name, franchiseId });
  return { id, name, created: true };
}

/** One detection of this issue, with its page and character, or a throw. */
async function readDetection(scope: Scope, detectionId: string) {
  const { data, error } = await supabaseAdmin
    .from("panel_character_detections")
    .select("id, character_id, panels!inner(book_id, issue_id, page_number)")
    .eq("id", detectionId)
    .eq("panels.book_id", scope.bookId)
    .eq("panels.issue_id", scope.issueId)
    .maybeSingle();
  must("reading the face", error);
  const row = data as unknown as {
    id: string;
    character_id: string | null;
    panels: { page_number: number } | null;
  } | null;
  if (!row) throw new Error("that face is not in this issue");
  return {
    id: row.id,
    characterId: row.character_id,
    page: row.panels?.page_number ?? 0,
  };
}

/** Removes exemplar crops from Storage; a failure is a message naming what is left behind, never a throw. */
async function removeCrops(paths: string[]): Promise<string | null> {
  if (paths.length === 0) return null;
  const { error } = await supabaseAdmin.storage
    .from("face-exemplars")
    .remove(paths);
  return error
    ? `face-exemplars remove failed (${error.message}), orphaned crops: ${paths.join(", ")}`
    : null;
}

/** The ids of the character's detections in this issue, by page. */
async function detectionsOf(
  scope: Scope,
  characterId: string,
): Promise<{ id: string; page: number }[]> {
  const { data, error } = await supabaseAdmin
    .from("panel_character_detections")
    .select("id, panels!inner(book_id, issue_id, page_number)")
    .eq("character_id", characterId)
    .eq("panels.book_id", scope.bookId)
    .eq("panels.issue_id", scope.issueId);
  must("reading the character's faces", error);
  return (
    (data ?? []) as unknown as {
      id: string;
      panels: { page_number: number } | null;
    }[]
  ).map((d) => ({ id: d.id, page: d.panels?.page_number ?? 0 }));
}

/**
 * The exemplar rule's second half, for the exemplars with no `detection_id`
 * on the page a face just left (the face's row is already written). When the
 * old character has no other face left on that page, the loose exemplar is
 * that face: it moves and is confirmed for the new character, or is deleted
 * on reject. Otherwise it stays in place, unconfirmed, because nothing says
 * which face it was.
 */
async function settleLooseExemplars(
  scope: Scope,
  characterId: string | null,
  page: number,
  outcome: { kind: "move"; to: string } | { kind: "reject" },
): Promise<string | null> {
  if (!characterId) return null;
  const otherFaces = (await detectionsOf(scope, characterId)).some(
    (d) => d.page === page,
  );
  const patch = otherFaces
    ? { is_confirmed: false }
    : outcome.kind === "move"
      ? { character_id: outcome.to, suggested_name: null, is_confirmed: true }
      : null;
  if (patch) {
    const { error } = await supabaseAdmin
      .from("character_face_exemplars")
      .update(patch)
      .eq("book_id", scope.bookId)
      .eq("source_issue", scope.issueId)
      .eq("character_id", characterId)
      .eq("page_number", page)
      .is("detection_id", null);
    must("settling the page's exemplars", error);
    return null;
  }
  const { data, error } = await supabaseAdmin
    .from("character_face_exemplars")
    .delete()
    .eq("book_id", scope.bookId)
    .eq("source_issue", scope.issueId)
    .eq("character_id", characterId)
    .eq("page_number", page)
    .is("detection_id", null)
    .select("crop_path");
  must("dropping the page's exemplar", error);
  return removeCrops(
    ((data ?? []) as { crop_path: string }[]).map((r) => r.crop_path),
  );
}

/** The client's ids that are still unnamed detections of this issue; anything else is stale or not ours. */
async function unnamedHere(scope: Scope, ids: string[]): Promise<string[]> {
  const here = new Set(
    (await readUnknownDetections(scope.bookId, scope.issueId)).map((d) => d.id),
  );
  return ids.filter((id) => here.has(id));
}

/**
 * The ids of this issue's loose, unnamed exemplars (no `character_id`, no
 * `detection_id`) whose `suggested_name` is one of the group's, compared
 * slugified: the same match the loader uses to show them under the group.
 */
async function looseUnnamedIds(
  scope: Scope,
  suggestedNames: string[],
): Promise<string[]> {
  if (suggestedNames.length === 0) return [];
  const names = new Set(suggestedNames.map(slugify));
  const { data, error } = await supabaseAdmin
    .from("character_face_exemplars")
    .select("id, suggested_name")
    .eq("book_id", scope.bookId)
    .eq("source_issue", scope.issueId)
    .is("character_id", null)
    .is("detection_id", null)
    .not("suggested_name", "is", null);
  must("reading the group's exemplars", error);
  return ((data ?? []) as { id: string; suggested_name: string | null }[])
    .filter((e) => e.suggested_name && names.has(slugify(e.suggested_name)))
    .map((e) => e.id);
}

/** The success line, with a crop warning appended when Storage kept a file. */
function done(message: string, warning: string | null): ActionResult {
  return { ok: true, message: warning ? `${message} ${warning}` : message };
}

/** Names an unknown face group: `character_id` on its detections and exemplars, the exemplars confirmed, the character in the cast. */
export async function nameGroup(args: {
  scope: Scope;
  detectionIds: string[];
  suggestedNames: string[];
  target: NameTarget;
  franchiseId: string | null;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, suggestedNames } = args;
    const detectionIds = await unnamedHere(scope, args.detectionIds);
    const who = await resolveTarget(
      scope.bookId,
      args.target,
      args.franchiseId,
    );
    if (detectionIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("panel_character_detections")
        .update({ character_id: who.id, suggested_name: null })
        .in("id", detectionIds)
        .is("character_id", null);
      must("naming the faces", error);
      const byDetection = await supabaseAdmin
        .from("character_face_exemplars")
        .update({
          character_id: who.id,
          suggested_name: null,
          is_confirmed: true,
        })
        .eq("book_id", scope.bookId)
        .eq("source_issue", scope.issueId)
        .is("character_id", null)
        .in("detection_id", detectionIds);
      must("naming the faces' exemplars", byDetection.error);
    }
    const looseIds = await looseUnnamedIds(scope, suggestedNames);
    if (looseIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("character_face_exemplars")
        .update({
          character_id: who.id,
          suggested_name: null,
          is_confirmed: true,
        })
        .in("id", looseIds)
        .is("character_id", null);
      must("naming the group's exemplars", error);
    }
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    const n = detectionIds.length;
    return {
      ok: true,
      message: `${n} ${n === 1 ? "face is" : "faces are"} now ${who.name}${who.created ? ", a new character" : ""}.`,
    };
  } catch (err) {
    return fail("naming a group", err);
  }
}

/** "Not a character": the group's detections and exemplars are deleted, crops included. */
export async function rejectGroup(args: {
  scope: Scope;
  detectionIds: string[];
  suggestedNames: string[];
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, suggestedNames } = args;
    const detectionIds = await unnamedHere(scope, args.detectionIds);
    const warnings: string[] = [];
    const byDetection = await deleteExemplars(supabaseAdmin, detectionIds);
    if (byDetection) warnings.push(byDetection);
    const looseIds = await looseUnnamedIds(scope, suggestedNames);
    if (looseIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("character_face_exemplars")
        .delete()
        .in("id", looseIds)
        .is("character_id", null)
        .select("crop_path");
      must("dropping the group's exemplars", error);
      const byName = await removeCrops(
        ((data ?? []) as { crop_path: string }[]).map((r) => r.crop_path),
      );
      if (byName) warnings.push(byName);
    }
    if (detectionIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("panel_character_detections")
        .delete()
        .in("id", detectionIds)
        .is("character_id", null);
      must("dropping the faces", error);
    }
    revalidate(scope);
    const n = detectionIds.length;
    return done(
      `Dropped ${n} ${n === 1 ? "face" : "faces"}: not a character.`,
      warnings.length > 0 ? warnings.join(" ") : null,
    );
  } catch (err) {
    return fail("rejecting a group", err);
  }
}

/**
 * Moves the clicked face to another character. Its exemplar follows when its
 * `detection_id` is this face, or when it is loose and this was the old
 * character's only face on the page; either way it is confirmed for the new
 * character. Any other loose exemplar on that page stays, unconfirmed.
 */
/**
 * The writes of one face move: the detection goes to `to`, verified; its
 * exemplar follows, confirmed; the page's loose exemplars settle. Both move
 * actions call this, so a batch writes exactly what a single move does.
 */
async function moveDetection(
  scope: Scope,
  face: { id: string; characterId: string | null; page: number },
  to: string,
  settle = true,
): Promise<void> {
  // Exemplar first: a failed detection write then leaves the face on the old
  // character, so a retry redoes both instead of skipping it as moved.
  const exemplar = await supabaseAdmin
    .from("character_face_exemplars")
    .update({
      character_id: to,
      suggested_name: null,
      is_confirmed: true,
    })
    .eq("book_id", scope.bookId)
    .eq("source_issue", scope.issueId)
    .eq("detection_id", face.id);
  must("moving the face's exemplar", exemplar.error);
  const moved = await supabaseAdmin
    .from("panel_character_detections")
    .update({
      character_id: to,
      suggested_name: null,
      human_verified: true,
    })
    .eq("id", face.id);
  must("moving the face", moved.error);
  // A relabel swept the old character's exemplars before any face moved, so
  // it has none loose to settle; skipping keeps its last write the face's.
  if (!settle) return;
  await settleLooseExemplars(scope, face.characterId, face.page, {
    kind: "move",
    to,
  });
}

/** A face move's answer: its line and the character the faces now belong to, or a failure. */
export type MoveResult =
  | { ok: true; message: string; characterId: string }
  | { ok: false; error: string };

export async function moveFace(args: {
  scope: Scope;
  detectionId: string;
  target: NameTarget;
  franchiseId: string | null;
}): Promise<MoveResult> {
  try {
    await requireAdmin();
    const { scope, detectionId } = args;
    const face = await readDetection(scope, detectionId);
    const who = await resolveTarget(
      scope.bookId,
      args.target,
      args.franchiseId,
    );
    if (face.characterId === who.id)
      return {
        ok: true,
        message: `That face is already ${who.name}.`,
        characterId: who.id,
      };
    await moveDetection(scope, face, who.id);
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    return {
      ok: true,
      message: `Moved the page ${face.page} face to ${who.name}${who.created ? ", a new character" : ""}.`,
      characterId: who.id,
    };
  } catch (err) {
    return fail("moving a face", err);
  }
}

/**
 * Moves a set of faces to one character (#745): every face is read before
 * anything is written (a stale id fails the whole move, not half of it), the
 * target is resolved once and joins the cast before the first face moves,
 * each face is then written as `moveFace` writes it, and the page refreshes
 * once. A face already on the target is left alone and counted; when every
 * face is, nothing is written, as in `moveFace`. Both `moveFaces` and
 * `relabelCharacter` call this, so a relabel writes what a batch move does.
 * With `from` set, a face the reread finds on neither `from` nor the target
 * fails the whole move before anything is written: another session moved it.
 */
async function moveAll(args: {
  scope: Scope;
  detectionIds: string[];
  target: NameTarget;
  franchiseId: string | null;
  from?: string;
}): Promise<{ id: string; message: string }> {
  const { scope, detectionIds, target, from } = args;
  if (detectionIds.length === 0) throw new Error("no faces were picked");
  const faces: Awaited<ReturnType<typeof readDetection>>[] = [];
  for (const detectionId of detectionIds)
    faces.push(await readDetection(scope, detectionId));
  // Checked before `resolveTarget`, which may create the character. A typed
  // new name has no id yet, so only an existing target's faces pass here.
  if (
    from !== undefined &&
    faces.some(
      (f) =>
        f.characterId !== from &&
        !(target.kind === "existing" && f.characterId === target.id),
    )
  )
    throw new Error("a face changed while moving; reload and try again");
  const who = await resolveTarget(scope.bookId, args.target, args.franchiseId);
  const toMove = faces.filter((f) => f.characterId !== who.id);
  const skipped = faces.length - toMove.length;
  if (toMove.length === 0)
    return {
      id: who.id,
      message: `${faces.length === 1 ? "That face is" : "Those faces are"} already ${who.name}.`,
    };
  await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
  if (from !== undefined) {
    // A relabel: the whole character in this issue is the target, so all of
    // its exemplars go, loose ones on pages with no face included. Written
    // before any face moves, so a failed write leaves the faces on `from`
    // and a retry redoes it (exemplar first, as in `moveDetection`).
    const exemplars = await supabaseAdmin
      .from("character_face_exemplars")
      .update({
        character_id: who.id,
        suggested_name: null,
        is_confirmed: true,
      })
      .eq("book_id", scope.bookId)
      .eq("source_issue", scope.issueId)
      .eq("character_id", from);
    must("moving the character's exemplars", exemplars.error);
  }
  for (const face of toMove)
    await moveDetection(scope, face, who.id, from === undefined);
  revalidate(scope);
  const count = (n: number) => `${n} ${n === 1 ? "face" : "faces"}`;
  return {
    id: who.id,
    message:
      `Moved ${count(toMove.length)} to ${who.name}${who.created ? ", a new character" : ""}.` +
      (skipped > 0
        ? ` ${count(skipped)} already ${who.name}, left alone.`
        : ""),
  };
}

/** Moves a selection of faces to one character (#745), through `moveAll`. */
export async function moveFaces(args: {
  scope: Scope;
  detectionIds: string[];
  target: NameTarget;
  franchiseId: string | null;
}): Promise<MoveResult> {
  try {
    await requireAdmin();
    const { id, message } = await moveAll(args);
    return { ok: true, message, characterId: id };
  } catch (err) {
    return fail("moving faces", err);
  }
}

/**
 * "This is character X" (#846): every face of `fromId` in this issue moves
 * to the target through `moveAll`, the ids gathered here so the client never
 * sends the list. The old character, its voices, its castlist rows and its
 * aliases are left as they are, and no alias is written (lead calls 1 and 2
 * on #846).
 */
export async function relabelCharacter(args: {
  scope: Scope;
  fromId: string;
  target: NameTarget;
  franchiseId: string | null;
}): Promise<MoveResult> {
  try {
    await requireAdmin();
    const { scope, fromId, target, franchiseId } = args;
    const faces = await detectionsOf(scope, fromId);
    if (faces.length === 0)
      throw new Error(`${fromId} has no faces in this issue to move`);
    const moved = await moveAll({
      scope,
      detectionIds: faces.map((f) => f.id),
      target,
      franchiseId,
      from: fromId,
    });
    return { ok: true, message: moved.message, characterId: moved.id };
  } catch (err) {
    return fail("relabelling a character", err);
  }
}

/**
 * The writes of one face reject: its exemplar (by `detection_id`, crop
 * included) and the detection are deleted, then the page's loose exemplars
 * settle. Both reject actions call this, so a batch writes exactly what a
 * single reject does. Returns the crop warnings, never throws on them.
 */
async function rejectDetection(
  scope: Scope,
  face: { id: string; characterId: string | null; page: number },
): Promise<string[]> {
  const warnings: string[] = [];
  const byDetection = await deleteExemplars(supabaseAdmin, [face.id]);
  if (byDetection) warnings.push(byDetection);
  const dropped = await supabaseAdmin
    .from("panel_character_detections")
    .delete()
    .eq("id", face.id);
  must("dropping the face", dropped.error);
  const loose = await settleLooseExemplars(scope, face.characterId, face.page, {
    kind: "reject",
  });
  if (loose) warnings.push(loose);
  return warnings;
}

/**
 * Rejects the clicked face: its exemplar (by `detection_id`, crop included)
 * and the detection are deleted. A loose exemplar on that page goes too when
 * this was the character's only face there; otherwise it stays, unconfirmed.
 */
export async function rejectFace(args: {
  scope: Scope;
  detectionId: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, detectionId } = args;
    const face = await readDetection(scope, detectionId);
    const warnings = await rejectDetection(scope, face);
    revalidate(scope);
    return done(
      `Dropped the page ${face.page} face.`,
      warnings.length > 0 ? warnings.join(" ") : null,
    );
  } catch (err) {
    return fail("rejecting a face", err);
  }
}

/**
 * Rejects a selection of faces (#749): every face is read before anything is
 * written (a stale id fails the whole reject, not half of it), each face is
 * then written as `rejectFace` writes it, one after another, and the page
 * refreshes once.
 */
export async function rejectFaces(args: {
  scope: Scope;
  detectionIds: string[];
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, detectionIds } = args;
    if (detectionIds.length === 0) throw new Error("no faces were picked");
    const faces: Awaited<ReturnType<typeof readDetection>>[] = [];
    for (const detectionId of detectionIds)
      faces.push(await readDetection(scope, detectionId));
    const warnings: string[] = [];
    for (const face of faces)
      warnings.push(...(await rejectDetection(scope, face)));
    revalidate(scope);
    const n = faces.length;
    return done(
      `Dropped ${n} ${n === 1 ? "face" : "faces"}.`,
      warnings.length > 0 ? warnings.join(" ") : null,
    );
  } catch (err) {
    return fail("rejecting faces", err);
  }
}

/**
 * "Faces are right": confirms the exemplars whose face is known, meaning
 * those with a `detection_id` of the character's detections in this issue.
 * A loose exemplar (no `detection_id`) is never confirmed here: when it is
 * unconfirmed, a move or reject left it that way on purpose, and it stays
 * out of the matcher until it is dealt with; when it is already confirmed it
 * stays confirmed. Its detections here become human-verified.
 */
export async function confirmFaces(args: {
  scope: Scope;
  characterId: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId } = args;
    const faces = await detectionsOf(scope, characterId);
    let confirmed = 0;
    if (faces.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("character_face_exemplars")
        .update({ is_confirmed: true })
        .eq("book_id", scope.bookId)
        .eq("source_issue", scope.issueId)
        .eq("character_id", characterId)
        .in(
          "detection_id",
          faces.map((f) => f.id),
        )
        .select("id");
      must("confirming the faces' exemplars", error);
      confirmed += data?.length ?? 0;
    }
    if (faces.length > 0) {
      const { error } = await supabaseAdmin
        .from("panel_character_detections")
        .update({ human_verified: true })
        .in(
          "id",
          faces.map((f) => f.id),
        );
      must("verifying the faces", error);
    }
    revalidate(scope);
    return {
      ok: true,
      message:
        confirmed === 0
          ? "Faces marked right; no exemplar here to confirm."
          : `Confirmed ${confirmed} ${confirmed === 1 ? "exemplar" : "exemplars"} for later issues.`,
    };
  } catch (err) {
    return fail("confirming faces", err);
  }
}

/**
 * A playable preview of a voice (#745, owner call O1, option B), read-only
 * and called on the first Play: a signed URL to the voice's source clip
 * when it has one (as the loader signs an archived clone's), else the audio
 * of one bubble in this book already rendered in that voice, else null.
 * A bubble whose `voice_id` records this voice comes first, this issue
 * first (#748). Audio rendered before `voice_id` existed reads null
 * (unknown): only those bubbles are matched the old way, through the
 * castlist rows of the book that hold the voice, each (issue, character)
 * pair checked against the render chain (`voiceFor`), this issue first. A
 * bubble whose `voice_id` names another voice never plays for this one.
 * Past this book (#880): a bubble rendered in the voice in any other book,
 * then the sample `makeVoiceSample` stored, then the voice's own ElevenLabs
 * `preview_url` (a free read). Each answer says where its audio came from.
 */
export async function voicePreview(args: {
  scope: Scope;
  voiceId: string;
}): Promise<PreviewResult> {
  try {
    await requireAdmin();
    const { scope, voiceId } = args;
    const voice = await readVoice(supabaseAdmin, voiceId);
    if (!voice) return { ok: true, url: null, canMakeSample: false };
    if (voice.source_clip_path) {
      const signed = await supabaseAdmin.storage
        .from(VOICE_CLIPS_BUCKET)
        .createSignedUrl(clipObjectPath(voice.source_clip_path), 3600);
      if (signed.data?.signedUrl)
        return { ok: true, url: signed.data.signedUrl, from: "clip" };
      // A clip that will not sign falls through to a rendered bubble.
      console.warn(
        `characters stop, signing ${voice.source_clip_path}:`,
        signed.error?.message,
      );
    }
    const rendered = (issueId?: string) => {
      const q = supabaseAdmin
        .from("bubbles")
        .select("issue_id, audio_storage_path")
        .eq("book_id", scope.bookId)
        .eq("voice_id", voiceId)
        .eq("needs_audio", false)
        .not("audio_storage_path", "is", null);
      return (issueId ? q.eq("issue_id", issueId) : q).limit(1).maybeSingle();
    };
    for (const issueId of [scope.issueId, undefined]) {
      const found = await rendered(issueId);
      must("reading a bubble rendered in this voice", found.error);
      const hit = found.data as {
        issue_id: string;
        audio_storage_path: string | null;
      } | null;
      if (hit?.audio_storage_path)
        return {
          ok: true,
          url: audioUrl(scope.bookId, hit.issue_id, hit.audio_storage_path),
          from: hit.issue_id === scope.issueId ? "this issue" : "this book",
        };
    }
    const book = await loadBookCast(supabaseAdmin, scope.bookId);
    const pairs = book.rows
      .filter(
        (r) =>
          r.voice_uuid === voiceId &&
          voiceFor(book, r.character_id, r.issue_id)?.voiceUuid === voiceId,
      )
      .sort((a, b) =>
        a.issue_id === scope.issueId
          ? -1
          : b.issue_id === scope.issueId
            ? 1
            : 0,
      );
    for (const r of pairs) {
      const bubble = await supabaseAdmin
        .from("bubbles")
        .select("audio_storage_path")
        .eq("book_id", scope.bookId)
        .eq("issue_id", r.issue_id)
        .eq("character_id", r.character_id)
        .is("voice_id", null)
        .eq("needs_audio", false)
        .not("audio_storage_path", "is", null)
        .limit(1)
        .maybeSingle();
      must("reading a rendered bubble", bubble.error);
      const row = bubble.data as { audio_storage_path: string | null } | null;
      if (row?.audio_storage_path)
        return {
          ok: true,
          url: audioUrl(scope.bookId, r.issue_id, row.audio_storage_path),
          from: r.issue_id === scope.issueId ? "this issue" : "this book",
        };
    }
    const elsewhere = await supabaseAdmin
      .from("bubbles")
      .select("book_id, issue_id, audio_storage_path")
      .eq("voice_id", voiceId)
      .neq("book_id", scope.bookId)
      .eq("needs_audio", false)
      .not("audio_storage_path", "is", null)
      .limit(1)
      .maybeSingle();
    must("reading a bubble rendered in this voice elsewhere", elsewhere.error);
    const other = elsewhere.data as {
      book_id: string;
      issue_id: string;
      audio_storage_path: string | null;
    } | null;
    if (other?.audio_storage_path) {
      const named = await supabaseAdmin
        .from("books")
        .select("name")
        .eq("id", other.book_id)
        .maybeSingle();
      return {
        ok: true,
        url: audioUrl(other.book_id, other.issue_id, other.audio_storage_path),
        from: `from ${(named.data as { name: string } | null)?.name ?? other.book_id}`,
      };
    }
    try {
      const stored = await storedSample(voice.id);
      if (stored) return { ok: true, url: stored, from: "sample" };
    } catch (err) {
      // A sample that will not sign falls through to ElevenLabs' own.
      console.warn(`characters stop, reading ${voice.id}'s sample:`, err);
    }
    const live = canRenderIn(voice);
    if (live) {
      const preview = await elevenLabsPreviewUrl(live);
      if (preview) return { ok: true, url: preview, from: "sample" };
    }
    return { ok: true, url: null, canMakeSample: live !== null };
  } catch (err) {
    return fail("previewing a voice", err);
  }
}

/** The ElevenLabs id a sample can be rendered in: a voice that is not archived and has one; else null. */
function canRenderIn(voice: {
  status: string;
  current_elevenlabs_id: string | null;
}): string | null {
  return voice.status === "archived" ? null : voice.current_elevenlabs_id;
}

/**
 * A signed URL to the voice's stored sample (`makeVoiceSample`), null when
 * there is none. Any Storage error other than "not there" throws, so a
 * caller about to render never mistakes it for a missing sample.
 */
async function storedSample(voiceId: string): Promise<string | null> {
  const store = supabaseAdmin.storage.from(VOICE_CLIPS_BUCKET);
  const path = voiceSamplePath(voiceId);
  const found = await store.exists(path);
  if (!found.data) return null;
  const signed = await store.createSignedUrl(path, 3600);
  if (!signed.data?.signedUrl)
    throw new Error(
      `signing ${VOICE_CLIPS_BUCKET}/${path}: ${signed.error?.message ?? "no URL"}`,
    );
  return signed.data.signedUrl;
}

/**
 * The voice's own sample on ElevenLabs (`GET /v1/voices/{id}`
 * `preview_url`), a free read. Null when it has none; a failed or non-OK
 * read is logged and is null too, never a failed preview.
 */
async function elevenLabsPreviewUrl(
  elevenLabsId: string,
): Promise<string | null> {
  try {
    const res = await elevenLabsFetch(
      `/v1/voices/${encodeURIComponent(elevenLabsId)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      console.warn(
        `characters stop, ElevenLabs voice ${elevenLabsId}: HTTP ${res.status}`,
      );
      return null;
    }
    const body = (await res.json()) as { preview_url?: unknown };
    return typeof body.preview_url === "string" && body.preview_url
      ? body.preview_url
      : null;
  } catch (err) {
    console.warn(`characters stop, ElevenLabs voice ${elevenLabsId}:`, err);
    return null;
  }
}

/**
 * Make a sample (#880): renders `VOICE_SAMPLE_LINE` once in the voice on
 * `TTS_MODEL` and stores it at `voiceSamplePath` in `comic-voice-clips`, so
 * every later preview plays the stored file for free. Idempotent: a sample
 * already stored is returned without rendering, and an upload that lost a
 * race to another render returns the one that won. Refuses an archived
 * voice or one with no ElevenLabs id. Writes no `voices`, `castlist` or
 * `bubbles` row and never touches the ElevenLabs voice itself.
 */
export async function makeVoiceSample(args: {
  scope: Scope;
  voiceId: string;
}): Promise<PreviewResult> {
  try {
    await requireAdmin();
    const { scope, voiceId } = args;
    const voice = await readVoice(supabaseAdmin, voiceId);
    if (!voice) throw new Error("that voice is gone");
    const elevenLabsId = canRenderIn(voice);
    if (!elevenLabsId)
      throw new Error(
        `${voice.display_name} has no live ElevenLabs voice to make a sample in`,
      );
    const existing = await storedSample(voice.id);
    if (existing) return { ok: true, url: existing, from: "sample" };

    const overrides = await loadVoiceOverrides(supabaseAdmin, [elevenLabsId]);
    const request = buildTtsRequest({
      text: VOICE_SAMPLE_LINE,
      voiceId: elevenLabsId,
      override: overrides.get(elevenLabsId),
    });
    const tts = await getElevenLabsClient();
    const response = await recordElevenLabsCall(
      {
        step: "voice-sample",
        bookId: scope.bookId,
        issueId: scope.issueId,
        model: TTS_MODEL,
      },
      request.text.length,
      () => tts.textToSpeech.convertWithTimestamps(elevenLabsId, request),
    );

    const path = voiceSamplePath(voice.id);
    const up = await supabaseAdmin.storage
      .from(VOICE_CLIPS_BUCKET)
      .upload(path, Buffer.from(response.audioBase64, "base64"), {
        contentType: "audio/mpeg",
        upsert: false,
      });
    // Already there: another click or tab stored one first; play that one.
    if (up.error && !/exist|duplicate/i.test(up.error.message))
      throw new Error(
        `upload ${VOICE_CLIPS_BUCKET}/${path}: ${up.error.message}`,
      );
    const url = await storedSample(voice.id);
    if (!url)
      throw new Error(`${VOICE_CLIPS_BUCKET}/${path} is missing after upload`);
    return { ok: true, url, from: "sample" };
  } catch (err) {
    return fail("making a voice sample", err);
  }
}

/** Approve: the gate first (it seeds the cast), then the `cluster-review` hook resumes. */
export async function approveCharacters(scope: Scope): Promise<ActionResult> {
  try {
    await requireAdmin();
    const verdict = await canApproveCharacters(scope.bookId, scope.issueId);
    if (!verdict.ok) {
      revalidate(scope);
      return { ok: false, error: verdict.reason };
    }
    const token = hookToken(scope.bookId, scope.issueId, "cluster-review");
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
        error: `The cast is approved, but no paused run took it: ${message}`,
      };
    }
    revalidate(scope);
    return {
      ok: true,
      message: "Approved. The pipeline is reading the pages.",
    };
  } catch (err) {
    return fail("approving", err);
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
        error: `Every voice is settled, but no paused run took it: ${message}`,
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
