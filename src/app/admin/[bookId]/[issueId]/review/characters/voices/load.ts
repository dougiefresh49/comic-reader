// Loads one issue for the voices stop: `planVoiceWork` (SELECTs, bucket hash checks, one free ElevenLabs GET for the slot count), the cast, and what the cards show. The writes are in actions.ts.
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast, voiceFor } from "~/lib/cast";
import { planVoiceWork, type VoiceWorkPlan } from "~/lib/voice-requests";
import {
  readCastlist,
  readVoices,
  VOICE_CLIPS_BUCKET,
  type VoiceRow,
} from "~/lib/voice-slots";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import { skippedIn } from "~/workflows/steps/voice";
import { canContinueVoices } from "~/server/admin/voices-gate";
import { loadCharacters } from "../load";
import type {
  Candidate,
  ItemView,
  LeftWithout,
  OutgoingChoice,
  Portrait,
  VoicesData,
} from "./types";

const SAMPLES = 3;

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
    "name, books(name)",
  ).maybeSingle();
  if (issueResult.error) {
    console.error("voices stop loader, the issue:", issueResult.error);
    throw new Error("The voices stop could not read the issue.");
  }
  const issue = issueResult.data as unknown as {
    name: string;
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

  const [book, voices, castlist, faces, verdict] = await Promise.all([
    loadBookCast(supabaseAdmin, bookId),
    readVoices(supabaseAdmin),
    readCastlist(supabaseAdmin),
    portraits(bookId, issueId),
    canContinueVoices(bookId, issueId),
  ]);
  const lines = await readSpeakerLines(supabaseAdmin, book, bookId, issueId);
  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const linkedHere = new Set(
    book.rows.map((r) => r.voice_uuid).filter((id): id is string => !!id),
  );

  // Clips for every candidate, signed in one call.
  const candidateIds = new Set(
    (plan?.items ?? []).flatMap((i) => i.candidates.map((c) => c.id)),
  );
  const clipPaths = [...candidateIds]
    .map((id) => voiceById.get(id)?.source_clip_path)
    .filter((p): p is string => !!p);
  const clipUrl = new Map<string, string>();
  if (clipPaths.length > 0) {
    const signed = await supabaseAdmin.storage
      .from(VOICE_CLIPS_BUCKET)
      .createSignedUrls(clipPaths, 3600);
    if (signed.error)
      console.error("voices stop loader, the clips:", signed.error);
    for (const s of signed.data ?? [])
      if (s.path && s.signedUrl) clipUrl.set(s.path, s.signedUrl);
  }

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
            (c.character_id ?? book.resolve(c.character)?.id) === characterId
          ),
      )
      .map((c) => ({
        bookId: c.book_id,
        issueId: c.issue_id,
        character: c.character,
      }));

  const samplesOf = (id: string) =>
    (lines.get(id) ?? [])
      .filter((l) => l.text)
      .slice(0, SAMPLES)
      .map((l) => ({ bubbleId: l.bubbleId, page: l.page, text: l.text }));

  const voiceNow = (id: string) => {
    const v = voiceFor(book, id, issueId);
    const row = v?.voiceUuid ? voiceById.get(v.voiceUuid) : undefined;
    return row?.status === "active" ? ref(row) : null;
  };

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

    const candidates: Candidate[] = item.candidates
      .filter((c) => {
        const row = voiceById.get(c.id);
        return (
          row?.source_clip_path &&
          (!linkedHere.has(c.id) || c.id === item.target?.id)
        );
      })
      .map((c) => {
        const path = voiceById.get(c.id)?.source_clip_path;
        return { ...c, clipUrl: path ? (clipUrl.get(path) ?? null) : null };
      });

    const archivedId = item.operation?.archived;
    const archived = archivedId ? voiceById.get(archivedId) : undefined;
    return {
      characterId: item.characterId,
      name: item.name,
      known: book.resolve(item.characterId)?.id === item.characterId,
      source: item.source,
      action: item.action,
      state: item.state,
      lines: item.lines,
      target: item.target ? ref(item.target) : null,
      replaces: item.replaces ? ref(item.replaces) : null,
      candidates,
      hasDescription: item.hasDescription,
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
      noAudio: skippedIn(book, item.characterId, issueId),
      voice: voiceNow(item.characterId),
      samples: samplesOf(item.characterId),
    };
  });

  // "No audio this run" speakers drop out of the plan; list them so the mark can be cleared.
  const listed = new Set(items.map((i) => i.characterId));
  for (const id of [...lines.keys()].sort()) {
    if (listed.has(id) || !skippedIn(book, id, issueId)) continue;
    items.push({
      characterId: id,
      name: book.resolve(id)?.display_name ?? id,
      known: book.resolve(id)?.id === id,
      source: "no voice",
      action: "design",
      state: "settled",
      lines: lines.get(id)?.length ?? 0,
      target: null,
      replaces: null,
      candidates: [],
      hasDescription: false,
      needsSlot: false,
      outgoing: null,
      choices: [],
      refusals: [],
      warnings: [],
      attention: null,
      noAudio: true,
      voice: null,
      samples: [],
    });
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
    blocker: verdict.ok ? null : verdict.reason,
  };
}
