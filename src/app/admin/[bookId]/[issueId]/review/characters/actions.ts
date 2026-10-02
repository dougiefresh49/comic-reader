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
  createCharacter,
  loadBookCast,
  removeFromCast,
  renameCharacter as renameCharacterRow,
  seedCast,
} from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import { canApproveCharacters } from "~/server/admin/characters-gate";

export type ActionResult =
  | { ok: true; message: string }
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

function fail(what: string, err: unknown): ActionResult {
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
  franchise: string | null,
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
  await createCharacter(supabaseAdmin, { id, displayName: name, franchise });
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

/**
 * The exemplar rule's second half: an exemplar with no `detection_id` on the
 * page a face just left stays with its character and is set unconfirmed,
 * because nothing says which face it was.
 */
async function unconfirmLooseExemplars(
  scope: Scope,
  characterId: string | null,
  page: number,
): Promise<void> {
  if (!characterId) return;
  const { error } = await supabaseAdmin
    .from("character_face_exemplars")
    .update({ is_confirmed: false })
    .eq("book_id", scope.bookId)
    .eq("source_issue", scope.issueId)
    .eq("character_id", characterId)
    .eq("page_number", page)
    .is("detection_id", null);
  must("unconfirming the page's exemplars", error);
}

/** Names an unknown face group: `character_id` on its detections and exemplars, the exemplars confirmed, the character in the cast. */
export async function nameGroup(args: {
  scope: Scope;
  detectionIds: string[];
  suggestedNames: string[];
  target: NameTarget;
  franchise: string | null;
}): Promise<ActionResult> {
  try {
    const { scope, detectionIds, suggestedNames } = args;
    const who = await resolveTarget(scope.bookId, args.target, args.franchise);
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
    if (suggestedNames.length > 0) {
      const { error } = await supabaseAdmin
        .from("character_face_exemplars")
        .update({
          character_id: who.id,
          suggested_name: null,
          is_confirmed: true,
        })
        .eq("book_id", scope.bookId)
        .eq("source_issue", scope.issueId)
        .is("character_id", null)
        .in("suggested_name", suggestedNames);
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

/** "Not a character": the group's detections and exemplars are deleted. */
export async function rejectGroup(args: {
  scope: Scope;
  detectionIds: string[];
  suggestedNames: string[];
}): Promise<ActionResult> {
  try {
    const { scope, detectionIds, suggestedNames } = args;
    if (detectionIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("character_face_exemplars")
        .delete()
        .eq("book_id", scope.bookId)
        .eq("source_issue", scope.issueId)
        .is("character_id", null)
        .in("detection_id", detectionIds);
      must("dropping the faces' exemplars", error);
    }
    if (suggestedNames.length > 0) {
      const { error } = await supabaseAdmin
        .from("character_face_exemplars")
        .delete()
        .eq("book_id", scope.bookId)
        .eq("source_issue", scope.issueId)
        .is("character_id", null)
        .in("suggested_name", suggestedNames);
      must("dropping the group's exemplars", error);
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
    return {
      ok: true,
      message: `Dropped ${n} ${n === 1 ? "face" : "faces"}: not a character.`,
    };
  } catch (err) {
    return fail("rejecting a group", err);
  }
}

/**
 * Moves the clicked face to another character. Its exemplar follows only when
 * its `detection_id` is this face, and is confirmed for the new character;
 * a loose exemplar on that page stays and is set unconfirmed.
 */
export async function moveFace(args: {
  scope: Scope;
  detectionId: string;
  target: NameTarget;
  franchise: string | null;
}): Promise<ActionResult> {
  try {
    const { scope, detectionId } = args;
    const face = await readDetection(scope, detectionId);
    const who = await resolveTarget(scope.bookId, args.target, args.franchise);
    if (face.characterId === who.id)
      return { ok: true, message: `That face is already ${who.name}.` };
    const moved = await supabaseAdmin
      .from("panel_character_detections")
      .update({
        character_id: who.id,
        suggested_name: null,
        human_verified: true,
      })
      .eq("id", detectionId);
    must("moving the face", moved.error);
    const exemplar = await supabaseAdmin
      .from("character_face_exemplars")
      .update({
        character_id: who.id,
        suggested_name: null,
        is_confirmed: true,
      })
      .eq("book_id", scope.bookId)
      .eq("source_issue", scope.issueId)
      .eq("detection_id", detectionId);
    must("moving the face's exemplar", exemplar.error);
    await unconfirmLooseExemplars(scope, face.characterId, face.page);
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

/** Rejects the clicked face: its exemplar (by `detection_id`) and the detection are deleted; a loose exemplar on that page stays, unconfirmed. */
export async function rejectFace(args: {
  scope: Scope;
  detectionId: string;
}): Promise<ActionResult> {
  try {
    const { scope, detectionId } = args;
    const face = await readDetection(scope, detectionId);
    const exemplar = await supabaseAdmin
      .from("character_face_exemplars")
      .delete()
      .eq("book_id", scope.bookId)
      .eq("source_issue", scope.issueId)
      .eq("detection_id", detectionId);
    must("dropping the face's exemplar", exemplar.error);
    const dropped = await supabaseAdmin
      .from("panel_character_detections")
      .delete()
      .eq("id", detectionId);
    must("dropping the face", dropped.error);
    await unconfirmLooseExemplars(scope, face.characterId, face.page);
    revalidate(scope);
    return { ok: true, message: `Dropped the page ${face.page} face.` };
  } catch (err) {
    return fail("rejecting a face", err);
  }
}

/** "Faces are right": confirms the character's exemplars in this issue, and marks its detections here as human-verified. */
export async function confirmFaces(args: {
  scope: Scope;
  characterId: string;
}): Promise<ActionResult> {
  try {
    const { scope, characterId } = args;
    const exemplars = await supabaseAdmin
      .from("character_face_exemplars")
      .update({ is_confirmed: true })
      .eq("book_id", scope.bookId)
      .eq("source_issue", scope.issueId)
      .eq("character_id", characterId)
      .select("id");
    must("confirming the exemplars", exemplars.error);
    const panels = await supabaseAdmin
      .from("panels")
      .select("id")
      .eq("book_id", scope.bookId)
      .eq("issue_id", scope.issueId);
    must("reading the panels", panels.error);
    const panelIds = ((panels.data ?? []) as { id: string }[]).map((p) => p.id);
    if (panelIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("panel_character_detections")
        .update({ human_verified: true })
        .eq("character_id", characterId)
        .in("panel_id", panelIds);
      must("verifying the faces", error);
    }
    revalidate(scope);
    const n = exemplars.data?.length ?? 0;
    return {
      ok: true,
      message:
        n === 0
          ? "Faces marked right; no exemplar here to confirm."
          : `Confirmed ${n} ${n === 1 ? "exemplar" : "exemplars"} for later issues.`,
    };
  } catch (err) {
    return fail("confirming faces", err);
  }
}

/** Adds a character with no face: an existing row, or a new one by name. */
export async function addCharacter(args: {
  scope: Scope;
  target: NameTarget;
  franchise: string | null;
}): Promise<ActionResult> {
  try {
    const { scope } = args;
    const who = await resolveTarget(scope.bookId, args.target, args.franchise);
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

/** Takes a character out of this issue. The cast is seeded first, so a member the proposal brought in has a row to say no on. */
export async function removeCharacter(args: {
  scope: Scope;
  characterId: string;
  name: string;
}): Promise<ActionResult> {
  try {
    const { scope, characterId } = args;
    await seedCast(supabaseAdmin, scope.bookId, scope.issueId);
    const n = await removeFromCast(
      supabaseAdmin,
      scope.bookId,
      scope.issueId,
      characterId,
    );
    revalidate(scope);
    return n === 0
      ? { ok: false, error: `${args.name} has no castlist row here to remove.` }
      : { ok: true, message: `${args.name} is out of this issue.` };
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
 * A wiki name with no `characters` row becomes one (a new character) or
 * joins an existing one as an alias, so the next read resolves it; either
 * way the character is in the cast.
 */
export async function nameWikiSuggestion(args: {
  scope: Scope;
  name: string;
  target: NameTarget;
  franchise: string | null;
}): Promise<ActionResult> {
  try {
    const { scope } = args;
    const wikiName = args.name.trim();
    const who = await resolveTarget(scope.bookId, args.target, args.franchise);
    if (!who.created && slugify(who.name) !== slugify(wikiName)) {
      const { data, error } = await supabaseAdmin
        .from("characters")
        .select("aliases")
        .eq("id", who.id)
        .maybeSingle();
      must("reading the aliases", error);
      const aliases = (data?.aliases ?? []) as string[];
      if (!aliases.some((a) => slugify(a) === slugify(wikiName))) {
        const { error: writeError } = await supabaseAdmin
          .from("characters")
          .update({ aliases: [...aliases, wikiName] })
          .eq("id", who.id);
        must("adding the alias", writeError);
      }
    }
    await addToCast(supabaseAdmin, scope.bookId, scope.issueId, who.id);
    revalidate(scope);
    return {
      ok: true,
      message: who.created
        ? `${who.name} is a new character, in the cast.`
        : `${wikiName} now means ${who.name}, in the cast.`,
    };
  } catch (err) {
    return fail("naming a wiki name", err);
  }
}

/** Approve: the gate first (it seeds the cast), then the `cluster-review` hook resumes. */
export async function approveCharacters(scope: Scope): Promise<ActionResult> {
  try {
    const verdict = await canApproveCharacters(scope.bookId, scope.issueId);
    if (!verdict.ok) {
      revalidate(scope);
      return { ok: false, error: verdict.reason };
    }
    const token = `ingest:${scope.bookId}/${scope.issueId}/cluster-review`;
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
