"use server";

/**
 * The characters stop's writes. Each one saves the moment it is made and
 * answers with a line the screen shows. Cast membership and names go
 * through `~/lib/cast`; faces and exemplars are written here, by the row
 * that was clicked (#349: never "the first detection on that page").
 */
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  addToCast,
  cancelVoiceRequest,
  castRow,
  clearSettledTasks,
  createCharacter,
  loadBookCast,
  readVoiceRequests,
  removeFromCast,
  renameCharacter as renameCharacterRow,
  setIssueVoice,
  setVoice,
  storeVoiceRequest,
  swapIssueVoice,
  voiceFor,
  type VoiceRequest,
} from "~/lib/cast";
import {
  VOICE_CLIPS_BUCKET,
  clipObjectPath,
  readVoice,
  voiceForAppearance,
} from "~/lib/voice-slots";
import { audioUrl } from "~/lib/storage";
import { addAlias } from "~/lib/character-aliases";
import { slugify } from "~/lib/character-id";
import { deleteExemplars } from "~/lib/exemplar-store";
import {
  canApproveCharacters,
  readUnknownDetections,
} from "~/server/admin/characters-gate";
import { requireAdmin } from "~/server/admin/require-admin";
import { hookToken } from "~/lib/ingest-hooks";
import type { CardGroup } from "./types";

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** `pickAppearance`'s answer: on a pick that stored a request, the voice this issue's row had before it, for Undo. */
export type PickResult =
  | { ok: true; message: string; previousVoiceUuid?: string | null }
  | { ok: false; error: string };

/** `voicePreview`'s answer: a playable URL, null when the voice has no stored audio, or a failure. */
export type PreviewResult =
  | { ok: true; url: string | null }
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
): Promise<void> {
  const moved = await supabaseAdmin
    .from("panel_character_detections")
    .update({
      character_id: to,
      suggested_name: null,
      human_verified: true,
    })
    .eq("id", face.id);
  must("moving the face", moved.error);
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
  await settleLooseExemplars(scope, face.characterId, face.page, {
    kind: "move",
    to,
  });
}

export async function moveFace(args: {
  scope: Scope;
  detectionId: string;
  target: NameTarget;
  franchiseId: string | null;
}): Promise<ActionResult> {
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
      return { ok: true, message: `That face is already ${who.name}.` };
    await moveDetection(scope, face, who.id);
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    return {
      ok: true,
      message: `Moved the page ${face.page} face to ${who.name}${who.created ? ", a new character" : ""}.`,
    };
  } catch (err) {
    return fail("moving a face", err);
  }
}

/**
 * Moves a selection of faces to one character (#745): every face is read
 * before anything is written (a stale id fails the whole move, not half of
 * it), the target is resolved once and joins the cast before the first
 * face moves, each face is then written as `moveFace` writes it, and the
 * page refreshes once. A face already on the target is left alone and
 * counted; when every face is, nothing is written, as in `moveFace`.
 */
export async function moveFaces(args: {
  scope: Scope;
  detectionIds: string[];
  target: NameTarget;
  franchiseId: string | null;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, detectionIds } = args;
    if (detectionIds.length === 0) throw new Error("no faces were picked");
    const faces: Awaited<ReturnType<typeof readDetection>>[] = [];
    for (const detectionId of detectionIds)
      faces.push(await readDetection(scope, detectionId));
    const who = await resolveTarget(
      scope.bookId,
      args.target,
      args.franchiseId,
    );
    const toMove = faces.filter((f) => f.characterId !== who.id);
    const skipped = faces.length - toMove.length;
    if (toMove.length === 0)
      return {
        ok: true,
        message: `${faces.length === 1 ? "That face is" : "Those faces are"} already ${who.name}.`,
      };
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    for (const face of toMove) await moveDetection(scope, face, who.id);
    revalidate(scope);
    const count = (n: number) => `${n} ${n === 1 ? "face" : "faces"}`;
    return {
      ok: true,
      message:
        `Moved ${count(toMove.length)} to ${who.name}${who.created ? ", a new character" : ""}.` +
        (skipped > 0
          ? ` ${count(skipped)} already ${who.name}, left alone.`
          : ""),
    };
  } catch (err) {
    return fail("moving faces", err);
  }
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
    const warnings: string[] = [];
    const byDetection = await deleteExemplars(supabaseAdmin, [detectionId]);
    if (byDetection) warnings.push(byDetection);
    const dropped = await supabaseAdmin
      .from("panel_character_detections")
      .delete()
      .eq("id", detectionId);
    must("dropping the face", dropped.error);
    const loose = await settleLooseExemplars(
      scope,
      face.characterId,
      face.page,
      { kind: "reject" },
    );
    if (loose) warnings.push(loose);
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

/** Adds a character with no face: an existing row, or a new one by name. */
export async function addCharacter(args: {
  scope: Scope;
  target: NameTarget;
  franchiseId: string | null;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope } = args;
    const who = await resolveTarget(
      scope.bookId,
      args.target,
      args.franchiseId,
    );
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    return {
      ok: true,
      message: `${who.name} is in the cast${who.created ? ", as a new character" : ""}.`,
    };
  } catch (err) {
    return fail("adding a character", err);
  }
}

/** Takes a character out of this issue. Only that character's castlist row is written: updated, or inserted with `in_issue` false when it has none (#417). */
export async function removeCharacter(args: {
  scope: Scope;
  characterId: string;
  name: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId } = args;
    await removeFromCast(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
    );
    revalidate(scope);
    return { ok: true, message: `${args.name} is out of this issue.` };
  } catch (err) {
    return fail("removing a character", err);
  }
}

export async function renameCharacter(args: {
  scope: Scope;
  characterId: string;
  name: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const name = args.name.trim();
    if (!name) return { ok: false, error: "A name is needed." };
    await renameCharacterRow(supabaseAdmin, args.characterId, name);
    revalidate(args.scope);
    return { ok: true, message: `Renamed to ${name}.` };
  } catch (err) {
    return fail("renaming a character", err);
  }
}

/**
 * A name no `characters` row knows (a wiki name, or a castlist text) becomes
 * a character or joins one as an alias, so the next read resolves it and the
 * suggestion clears; either way the character is in the cast. The alias is
 * written unless the name already resolves to that character (`addAlias`).
 */
export async function nameSuggestion(args: {
  scope: Scope;
  name: string;
  target: NameTarget;
  franchiseId: string | null;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope } = args;
    const wikiName = args.name.trim();
    if (!slugify(wikiName)) throw new Error("a name is needed");
    // A stale suggestion (the name means a character now) is refused before
    // resolveTarget can create a row that addAlias would then refuse.
    const means = (await loadBookCast(supabaseAdmin, scope.bookId)).resolve(
      wikiName,
    );
    if (
      means &&
      !(args.target.kind === "existing" && args.target.id === means.id)
    )
      throw new Error(
        `"${wikiName}" already means ${means.display_name ?? means.id}; reload the page`,
      );
    const who = await resolveTarget(
      scope.bookId,
      args.target,
      args.franchiseId,
    );
    await addAlias(supabaseAdmin, who.id, wikiName);
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    return {
      ok: true,
      message: who.created
        ? `${who.name} is a new character, in the cast.`
        : `${wikiName} now means ${who.name}, in the cast.`,
    };
  } catch (err) {
    return fail("naming a suggestion", err);
  }
}

/**
 * "Another active voice": written at once to the character's castlist rows in
 * every issue of the book. A pending voice request for this issue is
 * cancelled first; when that throws, nothing else is written. A cast member
 * with no castlist row in the book yet gets one here first.
 */
export async function setActiveVoice(args: {
  scope: Scope;
  characterId: string;
  name: string;
  group: CardGroup;
  voiceUuid: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId, voiceUuid } = args;
    const row = await readVoice(supabaseAdmin, voiceUuid);
    if (row?.status !== "active")
      return { ok: false, error: "That voice is not active any more." };
    const pending = (
      await readVoiceRequests(supabaseAdmin, scope.bookId, scope.issueId)
    ).some((r) => r.characterId === characterId && r.status === "pending");
    if (pending)
      await cancelVoiceRequest(
        supabaseAdmin,
        scope.bookId,
        scope.issueId,
        characterId,
      );
    let n = await setVoice(supabaseAdmin, scope.bookId, characterId, voiceUuid);
    if (n === 0 && (args.group === "here" || args.group === "role")) {
      await addToCast(supabaseAdmin, scope.bookId, scope.issueId, characterId);
      n = await setVoice(supabaseAdmin, scope.bookId, characterId, voiceUuid);
    }
    revalidate(scope);
    if (n === 0)
      return {
        ok: false,
        error: `${args.name} has no castlist row in this book to take the voice.`,
      };
    return {
      ok: true,
      message: `${args.name} now has ${row.display_name}, in every issue of the book.${pending ? " The voice request is withdrawn." : ""}`,
    };
  } catch (err) {
    return fail("setting a voice", err);
  }
}

/** A voice-lab clone or a new designed voice: stored as a request, made at the voices stop. */
export async function requestVoice(args: {
  scope: Scope;
  characterId: string;
  name: string;
  request: VoiceRequest;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId } = args;
    let request: VoiceRequest;
    let wants: string;
    if (args.request.action === "clone") {
      const target = args.request.targetVoiceUuid;
      const row = await readVoice(supabaseAdmin, target);
      if (
        row?.status !== "archived" ||
        row.character_id !== characterId ||
        !row.source_clip_path
      )
        return {
          ok: false,
          error: `That voice-lab clone is not on file for ${args.name}.`,
        };
      // A lab candidate is linked to no castlist row of this book (load.ts).
      const book = await loadBookCast(supabaseAdmin, scope.bookId);
      if (book.rows.some((r) => r.voice_uuid === target))
        return {
          ok: false,
          error: "That voice-lab clone is already a voice in this book.",
        };
      request = { action: "clone", targetVoiceUuid: target };
      wants = `a voice-lab clone: ${row.display_name}`;
    } else if (args.request.action === "design") {
      request = { action: "design" };
      wants = "a new designed voice";
    } else {
      return { ok: false, error: "Not a voice request." };
    }
    await storeVoiceRequest(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
      request,
    );
    revalidate(scope);
    return {
      ok: true,
      message: `${args.name} wants ${wants}. It is made at the voices stop.`,
    };
  } catch (err) {
    return fail("requesting a voice", err);
  }
}

/**
 * An appearance from "Its voices" (#458): the voice that holds it, or a new
 * `needs_clip` voice for it, becomes a clone request and this issue's voice.
 * Picking the same appearance again creates no second voice and no second
 * request (`voiceForAppearance`, and the request's upsert).
 */
export async function pickAppearance(args: {
  scope: Scope;
  characterId: string;
  name: string;
  appearanceId: string;
}): Promise<PickResult> {
  try {
    await requireAdmin();
    const { scope, characterId, appearanceId } = args;
    const { data, error } = await supabaseAdmin
      .from("appearances")
      .select("character_id, works(title, year), characters(display_name)")
      .eq("id", appearanceId)
      .maybeSingle();
    must("reading the appearance", error);
    const row = data as {
      character_id: string;
      works: { title: string; year: number } | null;
      characters: { display_name: string | null } | null;
    } | null;
    if (row?.character_id !== characterId || !row.works)
      return {
        ok: false,
        error: `That appearance is not on file for ${args.name}.`,
      };
    const { voice } = await voiceForAppearance(supabaseAdmin, {
      characterId,
      appearanceId,
      // The shape the backfill gives a needs_clip voice: "Bulk (1993)".
      displayName: `${row.characters?.display_name ?? args.name} (${row.works.year})`,
    });
    // The appearance's voice moved on since the page loaded: no clone
    // request. Active, it is this issue's voice; archived, it is chosen as
    // the picker chooses an archived voice.
    if (voice.status === "active") {
      await setIssueVoice(
        supabaseAdmin,
        scope.bookId,
        scope.issueId,
        characterId,
        voice.id,
      );
      revalidate(scope);
      return {
        ok: true,
        message: `${voice.display_name} is already active: ${args.name} uses it in this issue.`,
      };
    }
    if (voice.status === "archived")
      return voice.character_id === characterId &&
        (await loadBookCast(supabaseAdmin, scope.bookId)).rows.some(
          (r) => r.voice_uuid === voice.id,
        )
        ? castArchivedVoice({ ...args, voiceUuid: voice.id })
        : requestVoice({
            ...args,
            request: { action: "clone", targetVoiceUuid: voice.id },
          });
    if (voice.status !== "needs_clip")
      return {
        ok: false,
        error: `${voice.display_name} is ${voice.status}; pick it another way.`,
      };
    const before = castRow(
      await loadBookCast(supabaseAdmin, scope.bookId),
      characterId,
      scope.issueId,
    );
    await storeVoiceRequest(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
      { action: "clone", targetVoiceUuid: voice.id },
    );
    await setIssueVoice(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
      voice.id,
    );
    revalidate(scope);
    const previous = before?.voice_uuid ?? null;
    return {
      ok: true,
      message: `${args.name} wants a voice-lab clone from ${row.works.title} (${row.works.year}). It is made at the voices stop once voice-lab sends the clip.`,
      // What Undo puts back on this issue's row; a repeat pick has nothing new.
      ...(previous === voice.id ? {} : { previousVoiceUuid: previous }),
    };
  } catch (err) {
    return fail("asking voice-lab for a clip", err);
  }
}

/**
 * An archived voice of the character that a castlist row of this book
 * already references (#458): it is cast for this issue and the voices stop
 * restores it, as it does any cast voice out of a slot. It is not a new
 * clone, which is why #350 kept such voices out of the clone list.
 */
export async function castArchivedVoice(args: {
  scope: Scope;
  characterId: string;
  name: string;
  voiceUuid: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId, voiceUuid } = args;
    const voice = await readVoice(supabaseAdmin, voiceUuid);
    if (voice?.status !== "archived" || voice.character_id !== characterId)
      return {
        ok: false,
        error: `That archived voice is not on file for ${args.name}.`,
      };
    const pending = (
      await readVoiceRequests(supabaseAdmin, scope.bookId, scope.issueId)
    ).some((r) => r.characterId === characterId && r.status === "pending");
    if (pending)
      await cancelVoiceRequest(
        supabaseAdmin,
        scope.bookId,
        scope.issueId,
        characterId,
      );
    // A settled task (an old request carried out, or a speaker settled
    // earlier) would read the restore as settled too: the planner would
    // skip it. Only complete or skipped rows with no carryOut record go.
    await clearSettledTasks(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
    );
    await setIssueVoice(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
      voiceUuid,
    );
    revalidate(scope);
    return {
      ok: true,
      message: `${args.name} uses ${voice.display_name} in this issue. It is archived, so the voices stop restores it.${pending ? " The voice request is withdrawn." : ""}`,
    };
  } catch (err) {
    return fail("casting an archived voice", err);
  }
}

/**
 * Undoes a voice request, so the options are back and one can be made again.
 * After an appearance pick, `restoreVoiceUuid` is the voice this issue's
 * row had before it (null for none), from `pickAppearance`'s answer.
 * Undefined (the page was reloaded since the pick) means null: the issue
 * inherits the book's voice for the character. Either goes on the row as a
 * compare-and-set, only while the row still holds the request's
 * `needs_clip` voice, so a newer cast voice is never overwritten.
 */
export async function undoVoiceRequest(args: {
  scope: Scope;
  characterId: string;
  name: string;
  restoreVoiceUuid?: string | null;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { scope, characterId } = args;
    const request = (
      await readVoiceRequests(supabaseAdmin, scope.bookId, scope.issueId)
    ).find((r) => r.characterId === characterId);
    const target =
      request?.action === "clone" && request.targetVoiceUuid
        ? await readVoice(supabaseAdmin, request.targetVoiceUuid)
        : null;
    await cancelVoiceRequest(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
    );
    let note = "";
    if (target?.status === "needs_clip") {
      const to = args.restoreVoiceUuid ?? null;
      const swapped = await swapIssueVoice(
        supabaseAdmin,
        scope.bookId,
        scope.issueId,
        characterId,
        target.id,
        to,
      );
      note = !swapped
        ? " Its voice for this issue was left as it is: it is no longer the requested clip."
        : args.restoreVoiceUuid === undefined
          ? " This issue now inherits the book's voice for the character."
          : " Its voice for this issue is back to what it was.";
    }
    revalidate(scope);
    return {
      ok: true,
      message: `${args.name}'s voice request is undone.${note}`,
    };
  } catch (err) {
    return fail("undoing a voice request", err);
  }
}

/** Approve: the gate first (it seeds the cast), then the `cluster-review` hook resumes. */
/**
 * A playable preview of a voice (#745, owner call O1, option B), read-only
 * and called on the first Play: a signed URL to the voice's source clip
 * when it has one (as the loader signs an archived clone's), else the audio
 * of one bubble in this book already rendered in that voice, else null. A
 * bubble records its character, not its voice, so the castlist rows of the
 * book that hold the voice name the (issue, character) pairs, each checked
 * against the render chain (`voiceFor`), this issue first.
 */
export async function voicePreview(args: {
  scope: Scope;
  voiceId: string;
}): Promise<PreviewResult> {
  try {
    await requireAdmin();
    const { scope, voiceId } = args;
    const voice = await readVoice(supabaseAdmin, voiceId);
    if (!voice) return { ok: true, url: null };
    if (voice.source_clip_path) {
      const signed = await supabaseAdmin.storage
        .from(VOICE_CLIPS_BUCKET)
        .createSignedUrl(clipObjectPath(voice.source_clip_path), 3600);
      if (signed.data?.signedUrl)
        return { ok: true, url: signed.data.signedUrl };
      // A clip that will not sign falls through to a rendered bubble.
      console.warn(
        `characters stop, signing ${voice.source_clip_path}:`,
        signed.error?.message,
      );
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
        };
    }
    return { ok: true, url: null };
  } catch (err) {
    return fail("previewing a voice", err);
  }
}

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
