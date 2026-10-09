// Loads one issue for the casting page: the proposed cast with each one's lines, every face, the exemplars and the voices. SELECTs only; the writes are in actions.ts and casting-actions.ts.
import "server-only";
import { readAliases } from "~/lib/character-aliases";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { DEFAULT_PAGE } from "~/app/api/apply-fixes/write-rules";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  isRoleId,
  loadBookCast,
  proposeCast,
  readBookFranchises,
  ROLE_IDS,
  voiceFor,
  castRow,
  isNoAudio,
  type RoleId,
} from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import { chunk } from "~/lib/chunk";
import { readVoices, type VoiceRow } from "~/lib/voice-slots";
import { isProtectedVoice } from "~/lib/voice-slots/types";
import { audioUrl } from "~/lib/storage";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import { readVoicesGate } from "~/server/admin/voices-gate";
import {
  unknownFaceGroups,
  type UnknownDetection,
} from "~/server/admin/characters-gate";
import type {
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  LooseExemplar,
  PageView,
  PauseView,
  Rect,
  SampleLine,
  UnknownGroupView,
  VoiceOption,
  VoiceView,
} from "./types";

interface IssueRow {
  name: string;
  number: number;
  /** Slugs of the wiki names this issue's Needs a name section hides (#751). */
  dismissed_wiki_names: string[];
  pipeline_step: string | null;
  pipeline_paused: boolean;
  books: { name: string } | null;
}

interface PageRow {
  number: number;
  width: number;
  height: number;
}

interface PanelRow {
  id: string;
  page_number: number;
  bounding_box: Rect | null;
}

interface DetectionRow extends UnknownDetection {
  panel_id: string;
  character_id: string | null;
  identification_confidence: number;
  human_verified: boolean;
  face_bbox: Partial<Rect> | null;
}

interface ExemplarRow {
  id: string;
  character_id: string | null;
  suggested_name: string | null;
  detection_id: string | null;
  page_number: number;
  crop_path: string;
  is_confirmed: boolean | null;
}

interface CharacterRow {
  id: string;
  display_name: string | null;
}

/** First lines shown in the panel. */
const SAMPLES = 3;

/** The rows of one read, or a throw: a cut-short list would hide faces. */
function rows<T>(
  what: string,
  result: { data: unknown; error: unknown; count?: number | null },
): T[] {
  if (result.error) {
    console.error(`casting page loader, ${what}:`, result.error);
    throw new Error(`The casting page could not read ${what}.`);
  }
  const data = (result.data ?? []) as T[];
  if (typeof result.count === "number" && result.count > data.length) {
    throw new Error(
      `The casting page read ${data.length} of ${result.count} ${what}.`,
    );
  }
  return data;
}

function exemplarUrl(cropPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/face-exemplars/${cropPath}`;
}

export async function loadCharacters(
  bookId: string,
  issueId: string,
): Promise<CharactersData | null> {
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, number, dismissed_wiki_names, pipeline_step, pipeline_paused, books(name)",
  ).maybeSingle();
  if (issueResult.error) {
    console.error("casting page loader, the issue:", issueResult.error);
    throw new Error("The casting page could not read the issue.");
  }
  const issue = issueResult.data as unknown as IssueRow | null;
  if (!issue) return null;

  const [
    book,
    proposal,
    pageResult,
    panelResult,
    exemplarResult,
    charResult,
    voiceRows,
    franchises,
    lines,
  ] = await Promise.all([
    loadBookCast(supabaseAdmin, bookId),
    proposeCast(supabaseAdmin, bookId, issueId),
    supabaseAdmin
      .from("pages")
      .select("number, width, height", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    supabaseAdmin
      .from("panels")
      .select("id, page_number, bounding_box", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    // `source_issue` is this issue, so the seeded exemplars of #101
    // (`source_issue = 'seed'`) never reach this screen.
    supabaseAdmin
      .from("character_face_exemplars")
      .select(
        "id, character_id, suggested_name, detection_id, page_number, crop_path, is_confirmed",
        { count: "exact" },
      )
      .eq("book_id", bookId)
      .eq("source_issue", issueId)
      .order("page_number"),
    supabaseAdmin
      .from("characters")
      .select("id, display_name", { count: "exact" })
      .order("id"),
    readVoices(supabaseAdmin),
    readBookFranchises(supabaseAdmin, bookId),
    readSpeakerLines(supabaseAdmin, bookId, issueId),
  ]);
  const pageRows = rows<PageRow>("pages", pageResult);
  const panelRows = rows<PanelRow>("panels", panelResult);
  const exemplarRows = rows<ExemplarRow>("face exemplars", exemplarResult);
  const charRows = rows<CharacterRow>("characters", charResult);
  const aliasesOf = await readAliases(
    supabaseAdmin,
    charRows.map((c) => c.id),
    bookId,
  );

  const detectionRows: DetectionRow[] = [];
  for (const ids of chunk(
    panelRows.map((p) => p.id),
    60,
  )) {
    const result = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, panel_id, character_id, cluster_id, suggested_name, identification_confidence, human_verified, face_bbox",
        { count: "exact" },
      )
      .in("panel_id", ids)
      .order("created_at");
    detectionRows.push(...rows<DetectionRow>("face detections", result));
  }

  // Pages: the `pages` rows, plus any page a panel mentions.
  const dims = new Map(pageRows.map((p) => [p.number, p]));
  const pageNumbers = new Set<number>(pageRows.map((p) => p.number));
  for (const p of panelRows) pageNumbers.add(p.page_number);
  const pages: PageView[] = [...pageNumbers]
    .sort((a, b) => a - b)
    .map((number) => {
      const d = dims.get(number) ?? DEFAULT_PAGE;
      return {
        number,
        width: d.width,
        height: d.height,
        imageUrl: pageImageUrl(bookId, issueId, number),
      };
    });

  // Faces: a detection's box is panel-relative; the page box is what the screen draws.
  const panelById = new Map(panelRows.map((p) => [p.id, p]));
  const exemplarByDetection = new Map(
    exemplarRows
      .filter((e) => e.detection_id)
      .map((e) => [e.detection_id!, e] as const),
  );
  const faceOf = (d: DetectionRow): FaceView | null => {
    const panel = panelById.get(d.panel_id);
    if (!panel) return null;
    const box = panel.bounding_box ?? { x: 0, y: 0, w: 1, h: 1 };
    const f = d.face_bbox ?? {};
    const e = exemplarByDetection.get(d.id);
    return {
      id: d.id,
      page: panel.page_number,
      rect: {
        x: box.x + (f.x ?? 0) * box.w,
        y: box.y + (f.y ?? 0) * box.h,
        w: (f.w ?? 0.1) * box.w,
        h: (f.h ?? 0.1) * box.h,
      },
      confidence: d.identification_confidence,
      verified: d.human_verified,
      exemplar: e
        ? {
            id: e.id,
            confirmed: e.is_confirmed ?? false,
            cropUrl: exemplarUrl(e.crop_path),
          }
        : null,
    };
  };
  const byPage = (a: FaceView, b: FaceView) => a.page - b.page;
  const looseOf = (e: ExemplarRow): LooseExemplar => ({
    id: e.id,
    page: e.page_number,
    confirmed: e.is_confirmed ?? false,
    cropUrl: exemplarUrl(e.crop_path),
  });
  const loose = exemplarRows.filter((e) => !e.detection_id);

  // Group 1: the unknown face groups, as the gate groups them.
  const unnamed = detectionRows.filter((d) => d.character_id === null);
  const unknown: UnknownGroupView[] = unknownFaceGroups(unnamed).map((g) => {
    const names = new Set(g.suggestedNames.map(slugify));
    return {
      key: g.key,
      suggestedNames: g.suggestedNames,
      faces: g.detections
        .map(faceOf)
        .filter((f): f is FaceView => f !== null)
        .sort(byPage),
      looseExemplars: loose
        .filter(
          (e) =>
            e.character_id === null &&
            e.suggested_name &&
            names.has(slugify(e.suggested_name)),
        )
        .map(looseOf),
    };
  });
  unknown.sort(
    (a, b) =>
      b.faces.length - a.faces.length ||
      (a.faces[0]?.page ?? 0) - (b.faces[0]?.page ?? 0),
  );

  // The cast cards.
  const voiceName = new Map(voiceRows.map((v) => [v.id, v.display_name]));
  const displayName = (id: string) => book.resolve(id)?.display_name ?? id;
  // A member with no castlist row yet gets the voice `seedCast` will start it
  // with: its latest active `voices` row, so the card does not change on Approve.
  const startingVoice = new Map<string, VoiceRow>();
  for (const v of voiceRows
    .filter((v) => v.status === "active" && v.character_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!startingVoice.has(v.character_id!))
      startingVoice.set(v.character_id!, v);
  }
  const voiceView = (id: string): VoiceView | null => {
    // A "no audio" row is silent: no voice of its own, and no fallback (#410).
    if (isNoAudio(book, id, issueId)) return null;
    // A removed member's card still shows the voice it would come back with.
    const removed = castRow(book, id, issueId)?.in_issue === false;
    const v = voiceFor(book, id, removed ? undefined : issueId);
    if (!v) {
      const starting = startingVoice.get(id);
      return starting
        ? { name: starting.display_name, borrowedFrom: null, uuid: starting.id }
        : null;
    }
    const name = voiceName.get(v.voiceUuid) ?? v.elevenLabsId;
    if (!name) return null;
    return {
      name,
      borrowedFrom: v.from === id ? null : displayName(v.from),
      uuid: v.voiceUuid,
    };
  };

  const characterIds = new Set(charRows.map((c) => c.id));
  const facesByCharacter = new Map<string, FaceView[]>();
  for (const d of detectionRows) {
    if (!d.character_id) continue;
    const f = faceOf(d);
    if (!f) continue;
    facesByCharacter.set(d.character_id, [
      ...(facesByCharacter.get(d.character_id) ?? []),
      f,
    ]);
  }

  // The first lines' rendered audio, one read for every card.
  const sampleIds = [...lines.values()].flatMap((list) =>
    list
      .filter((l) => l.text)
      .slice(0, SAMPLES)
      .map((l) => l.bubbleId),
  );
  const audioOf = new Map<string, string>();
  for (const ids of chunk(sampleIds, 100)) {
    const result = await supabaseAdmin
      .from("bubbles")
      .select("id, audio_storage_path, needs_audio")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("id", ids);
    for (const b of rows<{
      id: string;
      audio_storage_path: string | null;
      needs_audio: boolean | null;
    }>("rendered lines", result))
      if (b.audio_storage_path && !b.needs_audio)
        audioOf.set(b.id, audioUrl(bookId, issueId, b.audio_storage_path));
  }
  const pageRange = (numbers: number[]): string | null => {
    if (numbers.length === 0) return null;
    const lo = Math.min(...numbers);
    const hi = Math.max(...numbers);
    return lo === hi ? `${lo}` : `${lo}–${hi}`;
  };

  const cardOf = (
    id: string,
    name: string,
    group: CharacterCard["group"],
    extra: Pick<CharacterCard, "sources" | "wikiNames" | "removed">,
  ): CharacterCard => {
    const faces = (facesByCharacter.get(id) ?? []).sort(byPage);
    const said = lines.get(id) ?? [];
    const samples: SampleLine[] = said
      .filter((l) => l.text)
      .slice(0, SAMPLES)
      .map((l) => ({
        bubbleId: l.bubbleId,
        page: l.page,
        text: l.text,
        audioUrl: audioOf.get(l.bubbleId) ?? null,
      }));
    return {
      id,
      name,
      group,
      ...extra,
      known: characterIds.has(id),
      noAudio: castRow(book, id, issueId)?.no_audio === true,
      faces,
      looseExemplars: loose.filter((e) => e.character_id === id).map(looseOf),
      voice: voiceView(id),
      lines: said.length,
      pages: pageRange(
        said.length > 0 ? said.map((l) => l.page) : faces.map((f) => f.page),
      ),
      samples,
    };
  };

  const cards: CharacterCard[] = [];
  const earlierCast: CharacterCard[] = [];
  for (const m of proposal.members) {
    const mine = castRow(book, m.id, issueId);
    const removed = mine?.in_issue === false;
    // In this issue: a face, a wiki mention, or a row in this issue's cast
    // (Add, or a seeded cast). Cast before: the rest of the book's cast.
    const group = isRoleId(m.id)
      ? "role"
      : m.sources.includes("faces") ||
          m.sources.includes("wiki") ||
          mine?.in_issue === true
        ? "here"
        : "before";
    const card = cardOf(m.id, m.name, group, {
      sources: m.sources,
      wikiNames: m.wikiNames,
      removed,
    });
    // A character cast before with no sign here and taken out of this issue
    // has no card; + Add offers it.
    if (group === "before" && removed) earlierCast.push(card);
    else cards.push(card);
  }
  // Group order first, so the comparator is one consistent order; then names
  // A to Z, and the roles in their fixed order.
  const rank: Record<CharacterCard["group"], number> = {
    here: 0,
    before: 1,
    role: 2,
  };
  cards.sort((a, b) => {
    if (a.group !== b.group) return rank[a.group] - rank[b.group];
    if (a.group === "role")
      return (
        ROLE_IDS.indexOf(a.id as RoleId) - ROLE_IDS.indexOf(b.id as RoleId)
      );
    return a.name.localeCompare(b.name);
  });

  const voices: VoiceOption[] = voiceRows
    .filter((v) => v.status !== "needs_clip")
    .map((v) => ({
      id: v.id,
      name: v.display_name,
      status: v.status,
      characterId: v.character_id,
      kind:
        v.status === "library"
          ? "library"
          : v.appearance_id || (v.source_clip_path && !v.design_prompt)
            ? "clone"
            : "designed",
      labPick: v.starting_pick === true,
      protected: isProtectedVoice(v),
    }));

  const known: KnownCharacter[] = charRows.map((c) => ({
    id: c.id,
    name: c.display_name ?? c.id,
    aliases: aliasesOf.get(c.id) ?? [],
  }));

  // A wiki name dismissed for this issue (#751) is not offered.
  const dismissedSlugs = new Set(issue.dismissed_wiki_names);
  const wikiNames = proposal.suggestions
    .filter((s) => !dismissedSlugs.has(slugify(s.name)))
    .map((s) => s.name);

  let pause: PauseView | null = null;
  if (issue.pipeline_paused && issue.pipeline_step === "review-clusters") {
    const inCast = cards.filter((c) => !c.removed).length;
    const faces = unnamed.length;
    pause = {
      step: "review-clusters",
      blocker:
        unknown.length > 0
          ? `${unknown.length} unknown face ${unknown.length === 1 ? "group" : "groups"} (${faces} ${faces === 1 ? "face" : "faces"}) still ${unknown.length === 1 ? "needs" : "need"} a name, or "Not a character".`
          : inCast === 0
            ? "The cast is empty: add at least one character."
            : null,
    };
  } else if (issue.pipeline_paused && issue.pipeline_step === "casting") {
    const gate = await readVoicesGate(bookId, issueId);
    pause = {
      step: "casting",
      blocker: gate.verdict.ok ? null : gate.verdict.reason,
    };
  }

  return {
    bookId,
    issueId,
    bookName: issue.books?.name ?? bookId,
    issueName: issue.name?.trim() ? issue.name : `Issue ${issue.number}`,
    // A character created here takes the book's lowest-position franchise.
    franchiseId: franchises[0]?.id ?? null,
    pages,
    unknown,
    cards,
    earlierCast,
    wikiNames,
    known,
    voices,
    pause,
  };
}
