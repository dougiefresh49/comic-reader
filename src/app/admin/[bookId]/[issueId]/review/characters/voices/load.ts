// Loads one issue for the voices stop: `planVoiceWork` (SELECTs, bucket hash checks, one free ElevenLabs GET for the slot count), the cast, and what the cards show. The writes are in actions.ts.
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { isNoAudio, loadBookCast, voiceFor } from "~/lib/cast";
import { planVoiceWork, type VoiceWorkPlan } from "~/lib/voice-requests";
import {
  readCastlist,
  readVoices,
  VOICE_CLIPS_BUCKET,
  type VoiceRow,
} from "~/lib/voice-slots";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import { readVoicesGate } from "~/server/admin/voices-gate";
import { loadCharacters } from "../load";
import type {
  ItemView,
  LeftWithout,
  OutgoingChoice,
  Portrait,
  VoicesData,
} from "./types";

const SAMPLES = 3;

type RawCandidate = { id: string; name: string; labDefault: boolean };

const ref = (v: VoiceRow) => ({ id: v.id, name: v.display_name });

/** The #349 loader's faces, one per character: its most confident face. */
async function portraits(
  bookId: string,
  issueId: string,
): Promise<Record<string, Portrait>> {
  try {
    const data = await loadCharacters(bookId, issueId);
    if (!data) return {};
    const pages = new Map(data.pages.map((p) => [p.number, p]));
    const out: Record<string, Portrait> = {};
    for (const card of data.cards) {
      const face = [...card.faces].sort(
        (a, b) => b.confidence - a.confidence,
      )[0];
      const page = face ? pages.get(face.page) : undefined;
      if (face && page) out[card.id] = { page, rect: face.rect };
    }
    return out;
  } catch (err) {
    console.error("voices stop loader, the faces:", err);
    return {};
  }
}

export async function loadVoices(
  bookId: string,
  issueId: string,
): Promise<VoicesData | null> {
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, pipeline_step, pipeline_paused, books(name)",
  ).maybeSingle();
  if (issueResult.error) {
    console.error("voices stop loader, the issue:", issueResult.error);
    throw new Error("The voices stop could not read the issue.");
  }
  const issue = issueResult.data as unknown as {
    name: string;
    pipeline_step: string | null;
    pipeline_paused: boolean;
    books: { name: string } | null;
  } | null;
  if (!issue) return null;

  let plan: VoiceWorkPlan | null = null;
  let planError: string | null = null;
  try {
    plan = await planVoiceWork({ supabase: supabaseAdmin }, bookId, issueId);
  } catch (err) {
    console.error("voices stop loader, the plan:", err);
    planError = err instanceof Error ? err.message : String(err);
  }

  const [book, voices, castlist, faces, gate] = await Promise.all([
    loadBookCast(supabaseAdmin, bookId),
    readVoices(supabaseAdmin),
    readCastlist(supabaseAdmin),
    portraits(bookId, issueId),
    readVoicesGate(bookId, issueId),
  ]);
  const lines = await readSpeakerLines(supabaseAdmin, bookId, issueId);
  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const linkedHere = new Set(
    book.rows.map((r) => r.voice_uuid).filter((id): id is string => !!id),
  );
  /** The gate's list (`planCastingTasks`): the screen shows controls for exactly these. */
  const unsettled = new Set(gate.plan.unsettled);
  const openRow = new Map(gate.plan.open.map((t) => [t.characterId, t]));

  /** #350's rule: a voice-lab clone has a source clip and no castlist link in this book. */
  const offerable = (id: string) =>
    Boolean(voiceById.get(id)?.source_clip_path) && !linkedHere.has(id);
  const labOf = (id: string): RawCandidate[] =>
    voices
      .filter((v) => v.status === "archived" && v.character_id === id)
      .map((v) => ({
        id: v.id,
        name: v.display_name,
        labDefault: v.starting_pick,
      }))
      .sort(
        (a, b) =>
          Number(b.labDefault) - Number(a.labDefault) ||
          a.name.localeCompare(b.name),
      );

  /** Castlist rows an archive of `voice` would leave without a voice; the character's own rows in this book do not count when it replaces that voice. */
  const leaves = (
    voice: VoiceRow,
    characterId: string,
    replaces: string | null,
  ): LeftWithout[] =>
    castlist
      .filter(
        (c) =>
          c.voice_uuid === voice.id &&
          !(
            replaces === voice.id &&
            c.book_id === bookId &&
            c.character_id === characterId
          ),
      )
      .map((c) => ({
        bookId: c.book_id,
        issueId: c.issue_id,
        character: c.display_name,
      }));

  const samplesOf = (id: string) =>
    (lines.get(id) ?? [])
      .filter((l) => l.text)
      .slice(0, SAMPLES)
      .map((l) => ({ bubbleId: l.bubbleId, page: l.page, text: l.text }));

  const voiceNow = (id: string) => {
    const v = voiceFor(book, id, issueId);
    const row = v?.voiceUuid ? voiceById.get(v.voiceUuid) : undefined;
    // Active and library voices play; an archived or needs_clip one does not.
    return row && row.status !== "archived" && row.status !== "needs_clip"
      ? ref(row)
      : null;
  };

  /** The castlist voice `voiceFor` finds is a `voices` row that really is archived. */
  const isArchived = (id: string) => {
    const uuid = voiceFor(book, id, issueId)?.voiceUuid;
    return uuid ? voiceById.get(uuid)?.status === "archived" : false;
  };

  const blank = (id: string): Omit<ItemView, "source" | "state"> => ({
    characterId: id,
    name: book.resolve(id)?.display_name ?? id,
    known: book.resolve(id)?.id === id,
    action: "design",
    lines: lines.get(id)?.length ?? 0,
    target: null,
    replaces: null,
    candidates: [],
    hasDescription: false,
    designedVoices: [],
    needsSlot: false,
    outgoing: null,
    choices: [],
    refusals: [],
    warnings: [],
    noDefault: null,
    attention: null,
    noAudio: isNoAudio(book, id, issueId),
    voice: voiceNow(id),
    samples: samplesOf(id),
  });

  const items: ItemView[] = (plan?.items ?? []).map((item) => {
    const replaces = item.replaces?.id ?? null;
    const choices: OutgoingChoice[] = [];
    const offer = (v: VoiceRow, refusals: string[] = []) => {
      if (choices.some((c) => c.id === v.id)) return;
      choices.push({
        ...ref(v),
        leaves: leaves(v, item.characterId, replaces),
        refusals,
      });
    };
    const o = item.outgoing;
    if (o?.kind === "archive") offer(o.voice, o.refusals);
    if (item.replaces) offer(item.replaces);
    for (const v of plan?.spare ?? []) offer(v);

    const archivedId = item.operation?.archived;
    const archived = archivedId ? voiceById.get(archivedId) : undefined;
    const view: ItemView = {
      ...blank(item.characterId),
      name: item.name,
      source: item.source,
      action: item.action,
      state: item.state,
      lines: item.lines,
      target: item.target ? ref(item.target) : null,
      replaces: item.replaces ? ref(item.replaces) : null,
      candidates: item.candidates
        .filter((c) => offerable(c.id))
        .map((c) => ({ ...c, clipUrl: null })),
      hasDescription: item.hasDescription,
      designedVoices: item.designedVoices,
      needsSlot: item.needsSlot,
      outgoing:
        o?.kind === "archive"
          ? {
              kind: "archive",
              ...ref(o.voice),
              order: o.order,
              refusals: o.refusals,
              leaves: o.leavesWithoutVoice,
            }
          : o,
      choices,
      refusals: item.refusals,
      warnings: item.warnings,
      attention: item.operation
        ? {
            phase: item.operation.phase,
            archived: archived ? ref(archived) : null,
          }
        : null,
    };
    // The plan's default clone for a speaker with no voice is its first
    // voice-lab candidate; one already cast in this book is not offered.
    if (
      item.source === "no voice" &&
      item.action === "clone" &&
      item.target &&
      !offerable(item.target.id)
    ) {
      view.noDefault = `${item.target.display_name} is ${linkedHere.has(item.target.id) ? "already cast in this book" : "missing its source clip"}, so it is not offered. Pick a voice below.`;
      view.action = "design";
      view.target = null;
      view.needsSlot = false;
      view.outgoing = null;
    }
    // The screen and the gate read one list: settled here means settled there.
    if (unsettled.has(item.characterId) && view.state === "settled") {
      view.state = "pending";
      view.needsSlot = false;
      view.outgoing = null;
      view.warnings = [
        ...view.warnings,
        "Settled earlier, but it still has no voice.",
      ];
    } else if (!unsettled.has(item.characterId) && view.state !== "settled") {
      view.state = "settled";
    }
    return view;
  });

  // Gate items the plan does not list (or every one, when the plan failed),
  // with the controls that need no plan: a clone or design choice, an
  // active voice, no audio, and Accept or Check again on an open row.
  const listed = new Set(items.map((i) => i.characterId));
  for (const id of gate.plan.unsettled) {
    if (listed.has(id)) continue;
    const row = openRow.get(id);
    items.push({
      ...blank(id),
      source: isArchived(id) ? "archived voice" : "no voice",
      state: row?.operation
        ? "needs attention"
        : row?.status === "in_progress"
          ? "made"
          : "pending",
      candidates: labOf(id)
        .filter((c) => offerable(c.id))
        .map((c) => ({ ...c, clipUrl: null })),
      attention: row?.operation ? { phase: "recorded", archived: null } : null,
      warnings: plan
        ? [
            "The slot plan does not list this item yet: choose a clone or a new voice to plan it, or use an active voice.",
          ]
        : [],
    });
    listed.add(id);
  }

  // "No audio this run" speakers drop out of the plan; list them so the mark can be cleared.
  for (const id of [...lines.keys()].sort()) {
    if (listed.has(id) || !isNoAudio(book, id, issueId)) continue;
    items.push({ ...blank(id), source: "no voice", state: "settled" });
  }

  // Clips for every candidate shown, signed in one call.
  const clipPaths = [
    ...new Set(
      items.flatMap((i) =>
        i.candidates
          .map((c) => voiceById.get(c.id)?.source_clip_path)
          .filter((p): p is string => !!p),
      ),
    ),
  ];
  if (clipPaths.length > 0) {
    const signed = await supabaseAdmin.storage
      .from(VOICE_CLIPS_BUCKET)
      .createSignedUrls(clipPaths, 3600);
    if (signed.error)
      console.error("voices stop loader, the clips:", signed.error);
    const url = new Map(
      (signed.data ?? []).map((s) => [s.path, s.signedUrl] as const),
    );
    for (const item of items)
      for (const c of item.candidates) {
        const path = voiceById.get(c.id)?.source_clip_path;
        c.clipUrl = (path ? url.get(path) : undefined) ?? null;
      }
  }
  return {
    bookId,
    issueId,
    bookName: issue.books?.name ?? bookId,
    issueName: issue.name,
    slots: plan
      ? {
          used: plan.status.voice_slots_used,
          limit: plan.status.voice_limit,
          free: plan.freeNow,
          addEditUsed: plan.status.voice_add_edit_counter,
          addEditMax: plan.status.max_voice_add_edits,
          headroom: plan.addEditHeadroom,
          adds: plan.adds,
          archives: plan.archives,
        }
      : null,
    planError,
    planRefusals: plan?.refusals ?? [],
    items,
    active: voices
      .filter((v) => v.status === "active")
      .map(ref)
      .sort((a, b) => a.name.localeCompare(b.name)),
    portraits: faces,
    blocker: gate.verdict.ok ? null : gate.verdict.reason,
    runPaused:
      issue.pipeline_paused === true && issue.pipeline_step === "casting",
  };
}
