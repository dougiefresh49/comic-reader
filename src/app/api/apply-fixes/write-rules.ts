// The one home for what a review edit writes: which columns a bubble or panel edit sets, and what an added row starts with.
// Both writers use it: the old editor's /api/apply-fixes and the v2 editor's Save (/api/apply-fixes/save).
import "server-only";
import { z } from "zod";
import { bubbleSpeaker, type BubbleSpeaker } from "~/lib/bubble-speaker";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { normalizePanelAudioTags } from "~/workflows/steps/vision-rows";

/** A box in page fractions (0..1), top-left corner plus size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Who a bubble's edit says speaks: the picked `characters.id`, or no id and
 * the raw label to keep (null clears it). Written as `character_id` and
 * `speaker` together, through `bubbleSpeaker`.
 */
export interface SpeakerEdit {
  characterId: string | null;
  label: string | null;
}

/** What changed on one bubble. A field left out is not written. */
export interface BubbleEdit {
  speaker?: SpeakerEdit;
  /** `ocr_text`. */
  text?: string;
  textWithCues?: string | null;
  type?: string;
  emotion?: string;
  ignored?: boolean;
  /** Left out by the old editor, which predates the column. */
  silent?: boolean;
  /** The owner said an overlap is not a duplicate. Left out by the old editor. */
  kept?: boolean;
  panelId?: string | null;
  sortOrder?: number;
  box?: Box;
}

/** Page size in pixels when a page has no `pages` row. The loader uses it too. */
export const DEFAULT_PAGE = { width: 1988, height: 3057 };

/** Edits that change what the audio step would say, so the bubble needs new audio. */
const AUDIO_FIELDS = ["speaker", "text", "textWithCues", "type"] as const;

type Row = Record<string, unknown>;

/** What the rules read from the database before they can map an edit. */
export interface WriteContext {
  /** `pages.width` and `pages.height`, for `box_2d` in pixels. */
  pageSize: (page: number) => { width: number; height: number };
  /** `characters.display_name` as read, for each `characters` row among the picked speakers. */
  displayNames: Map<string, string | null>;
  /** The detection confidence each named bubble's `box_2d` holds now. */
  confidence: Map<string, number>;
  /** The page of each named bubble, as stored. */
  bubblePage: Map<string, number>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** Reads what the rules need. Throws on a failed read: nothing has been written yet. */
export async function loadWriteContext(
  bookId: string,
  issueId: string,
  need: {
    speakers: (SpeakerEdit | undefined)[];
    /** Existing bubbles whose stored page and confidence the caller needs. */
    bubbleIds: string[];
  },
): Promise<WriteContext> {
  const ids = Array.from(
    new Set(
      need.speakers.flatMap((s) => (s?.characterId ? [s.characterId] : [])),
    ),
  );
  const [pageResult, charResult] = await Promise.all([
    supabaseAdmin
      .from("pages")
      .select("number, width, height")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    ids.length > 0
      ? supabaseAdmin
          .from("characters")
          .select("id, display_name")
          .in("id", ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pageResult.error)
    throw new Error(`Could not read the pages: ${pageResult.error.message}`);
  if (charResult.error)
    throw new Error(
      `Could not read the characters: ${charResult.error.message}`,
    );

  const sizes = new Map(
    (
      (pageResult.data ?? []) as {
        number: number;
        width: number;
        height: number;
      }[]
    ).map((p) => [p.number, { width: p.width, height: p.height }]),
  );
  const displayNames = new Map(
    (
      (charResult.data ?? []) as { id: string; display_name: string | null }[]
    ).map((c) => [c.id, c.display_name]),
  );

  const confidence = new Map<string, number>();
  const bubblePage = new Map<string, number>();
  for (const ids of chunk(Array.from(new Set(need.bubbleIds)), 100)) {
    const { data, error } = await supabaseAdmin
      .from("bubbles")
      .select("id, page_number, box_2d")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("id", ids);
    if (error) throw new Error(`Could not read the bubbles: ${error.message}`);
    for (const row of (data ?? []) as {
      id: string;
      page_number: number;
      box_2d: { confidence?: unknown } | null;
    }[]) {
      bubblePage.set(row.id, row.page_number);
      const c = row.box_2d?.confidence;
      if (typeof c === "number") confidence.set(row.id, c);
    }
  }

  return {
    pageSize: (page) => sizes.get(page) ?? DEFAULT_PAGE,
    displayNames,
    confidence,
    bubblePage,
  };
}

/**
 * `character_id` and `speaker` for a speaker edit, from `bubbleSpeaker`: a
 * picked `characters` row writes its id and display name. A picked id with
 * no row (a character added in the editor that the characters stop has not
 * created) is kept as a label with no id, as before #463.
 */
function speakerColumns(
  edit: SpeakerEdit | undefined,
  ctx: WriteContext,
): BubbleSpeaker {
  const id = edit?.characterId ?? null;
  if (id && ctx.displayNames.has(id))
    return bubbleSpeaker(
      { id, displayName: ctx.displayNames.get(id) ?? null },
      null,
    );
  return bubbleSpeaker(null, id ?? edit?.label ?? null);
}

function percent(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * A bubble's box as both columns that hold it: `style` in page percents and
 * `box_2d` in page pixels. They are always written together so they never
 * drift apart. `box_2d` keeps the detection confidence it had.
 */
export function boxColumns(
  box: Box,
  page: number,
  ctx: WriteContext,
  confidence: number | undefined,
): { style: Row; box_2d: Row } {
  const { width, height } = ctx.pageSize(page);
  return {
    style: {
      left: percent(box.x),
      top: percent(box.y),
      width: percent(box.w),
      height: percent(box.h),
    },
    box_2d: {
      x: Math.round(box.x * width),
      y: Math.round(box.y * height),
      width: Math.round(box.w * width),
      height: Math.round(box.h * height),
      ...(confidence !== undefined ? { confidence } : {}),
    },
  };
}

/** The columns an edit to an existing bubble writes. Empty when it writes none. */
export function bubbleUpdate(
  id: string,
  page: number,
  edit: BubbleEdit,
  ctx: WriteContext,
): Row {
  const row: Row = {};
  if (edit.speaker !== undefined)
    Object.assign(row, speakerColumns(edit.speaker, ctx));
  if (edit.text !== undefined) row.ocr_text = edit.text;
  if (edit.textWithCues !== undefined) row.text_with_cues = edit.textWithCues;
  if (edit.type !== undefined) row.type = edit.type;
  if (edit.emotion !== undefined) row.emotion = edit.emotion;
  if (edit.ignored !== undefined) row.ignored = edit.ignored;
  if (edit.silent !== undefined) row.silent = edit.silent;
  if (edit.kept !== undefined) row.kept = edit.kept;
  if (edit.panelId !== undefined) row.panel_id = edit.panelId;
  if (edit.sortOrder !== undefined) row.sort_order = edit.sortOrder;
  if (edit.box)
    Object.assign(row, boxColumns(edit.box, page, ctx, ctx.confidence.get(id)));
  const affectsAudio = AUDIO_FIELDS.some((f) => edit[f] !== undefined);
  if (affectsAudio && edit.ignored !== true) row.needs_audio = true;
  // A silent bubble plays nothing: its take is dropped and no new one is
  // wanted. Turned back on, it needs audio again.
  if (edit.silent === true) {
    row.audio_storage_path = null;
    row.needs_audio = false;
  } else if (edit.silent === false && edit.ignored !== true) {
    row.needs_audio = true;
  }
  return row;
}

/**
 * The row for an added bubble. It needs audio and has none: no
 * `audio_storage_path`, so the audio step picks it up.
 */
export function bubbleInsert(
  bookId: string,
  issueId: string,
  bubble: BubbleEdit & {
    page: number;
    sortOrder: number;
    /** A v4 UUID made in the browser. Left out, the database makes one. */
    id?: string;
    legacyId?: string;
    /** The detection confidence a restored row's `box_2d` held. */
    confidence?: number | null;
  },
  ctx: WriteContext,
): Row {
  const hasText = [bubble.text, bubble.textWithCues].some((t) => !!t?.trim());
  return {
    ...(bubble.id ? { id: bubble.id } : {}),
    ...(bubble.legacyId ? { legacy_id: bubble.legacyId } : {}),
    book_id: bookId,
    issue_id: issueId,
    page_number: bubble.page,
    sort_order: bubble.sortOrder,
    ocr_text: bubble.text ?? null,
    text_with_cues: bubble.textWithCues ?? null,
    type: bubble.type ?? "SPEECH",
    ...speakerColumns(bubble.speaker, ctx),
    emotion: bubble.emotion ?? null,
    ignored: bubble.ignored ?? false,
    ...(bubble.silent !== undefined ? { silent: bubble.silent } : {}),
    ...(bubble.kept !== undefined ? { kept: bubble.kept } : {}),
    needs_audio: true,
    needs_ocr: !hasText,
    audio_storage_path: null,
    panel_id: bubble.panelId ?? null,
    ...(bubble.box
      ? boxColumns(bubble.box, bubble.page, ctx, bubble.confidence ?? undefined)
      : { style: null, box_2d: null }),
  };
}

/** The row for an added panel, under a `panel_id` label from `newPanelLabels`. */
export function panelInsert(
  bookId: string,
  issueId: string,
  panel: { id: string; page: number; box: Box; sortOrder: number },
  label: string,
): Row {
  return {
    id: panel.id,
    book_id: bookId,
    issue_id: issueId,
    page_number: panel.page,
    panel_id: label,
    sort_order: panel.sortOrder,
    bounding_box: { ...panel.box },
    source: "manual",
    // A complete value, not the column default `{}` (#222).
    audio_tags: { ...normalizePanelAudioTags(null) },
  };
}

/** The columns an edit to an existing panel writes. */
export function panelUpdate(edit: { box?: Box; sortOrder?: number }): Row {
  const row: Row = {};
  if (edit.box) row.bounding_box = { ...edit.box };
  if (edit.sortOrder !== undefined) row.sort_order = edit.sortOrder;
  return row;
}

/**
 * `panel_id` labels for added panels, one per entry of `pages`, in the
 * ingest's `p<page>-<n>` shape. Each takes the number after the highest one
 * its page already uses and skips any label already taken in the issue, so
 * a page whose labels have gaps or run past the panel count never collides.
 */
export function newPanelLabels(
  taken: Iterable<string>,
  pages: number[],
): string[] {
  const used = new Set(taken);
  return pages.map((page) => {
    const prefix = `p${String(page).padStart(2, "0")}-`;
    let n = 0;
    for (const label of used) {
      if (!label.startsWith(prefix)) continue;
      const k = Number(label.slice(prefix.length));
      if (Number.isInteger(k) && k > n) n = k;
    }
    let label: string;
    do {
      n += 1;
      label = `${prefix}${String(n).padStart(2, "0")}`;
    } while (used.has(label));
    used.add(label);
    return label;
  });
}

// ------------------------------------------------------------ the v2 Save

const uuid = z.string().uuid();
const page = z.number().int().min(0);
const order = z.number().int().min(0);
const box = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});
const bubbleEdit = z
  .object({
    speaker: z
      .object({
        characterId: z.string().min(1).nullable(),
        label: z.string().nullable(),
      })
      .strict()
      .optional(),
    text: z.string().optional(),
    textWithCues: z.string().nullable().optional(),
    type: z
      .enum(["SPEECH", "NARRATION", "CAPTION", "SFX", "BACKGROUND"])
      .optional(),
    emotion: z.string().optional(),
    ignored: z.boolean().optional(),
    silent: z.boolean().optional(),
    kept: z.boolean().optional(),
    panelId: uuid.nullable().optional(),
    sortOrder: order.optional(),
    box: box.optional(),
  })
  .strict();

/** What the v2 editor's Save sends: every pending edit of one issue. */
export const saveRequestSchema = z.object({
  bookId: z.string().min(1),
  issueId: z.string().min(1),
  bubbles: z.object({
    add: z.array(
      bubbleEdit
        .extend({
          id: uuid,
          page,
          sortOrder: order,
          box,
          confidence: z.number().finite().nullable().optional(),
        })
        .strict(),
    ),
    update: z.array(z.object({ id: uuid, page, set: bubbleEdit })),
    remove: z.array(z.object({ id: uuid, page })),
  }),
  panels: z.object({
    add: z.array(z.object({ id: uuid, page, box, sortOrder: order })),
    update: z.array(
      z.object({
        id: uuid,
        page,
        box: box.optional(),
        sortOrder: order.optional(),
      }),
    ),
    remove: z.array(z.object({ id: uuid, page })),
  }),
});

export type SaveRequest = z.infer<typeof saveRequestSchema>;
/** The edits part of a Save, without the book and issue. */
export type SaveEdits = Omit<SaveRequest, "bookId" | "issueId">;

/** What a Save answers with when it landed. A failure answers `{ error }`. */
export interface SaveResult {
  /** Rows written: inserts, updates and deletes. */
  written: number;
  /** Bubbles that now need audio. */
  needsAudio: number;
}
