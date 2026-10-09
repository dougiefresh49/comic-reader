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
        };
    }
    return { ok: true, url: null };
  } catch (err) {
    return fail("previewing a voice", err);
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
