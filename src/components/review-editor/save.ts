// What a Save sends: the pending edits between the baseline (the rows as last loaded or saved) and the document.
import type { SaveEdits, SpeakerEdit } from "~/app/api/apply-fixes/write-rules";
import {
  pageBubbleIds,
  pagePanels,
  visibleBubbles,
  type BubbleDoc,
  type Doc,
} from "./model";

/**
 * Who a bubble's Save says speaks: the picked cast id, or no id and the
 * label it was loaded with. The Save route turns it into `character_id` and
 * `speaker` with `bubbleSpeaker`, the display name beside a picked id.
 */
function speakerOf(b: BubbleDoc): SpeakerEdit {
  return b.speakerId
    ? { characterId: b.speakerId, label: null }
    : { characterId: null, label: b.rawSpeaker };
}

function sameSpeaker(a: SpeakerEdit, b: SpeakerEdit): boolean {
  return a.characterId === b.characterId && a.label === b.label;
}

/** The cues a bubble stores: its `cues` while its text is the text they were written for. */
export function cuesOf(b: BubbleDoc): string | null {
  return b.cues && b.cues.forText === b.text ? b.cues.value : null;
}

function sameRect(a: BubbleDoc["rect"], b: BubbleDoc["rect"]): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** A page's live bubbles in play order, and the panel each sits in. */
function playOrder(doc: Doc, page: number) {
  const ids = visibleBubbles(doc, pageBubbleIds(doc, page)).map((b) => b.id);
  const panelOf = new Map<string, string | null>();
  for (const p of pagePanels(doc, page))
    for (const id of p.bubbleIds) panelOf.set(id, p.id);
  return { ids, panelOf };
}

/**
 * The rows a Save writes to turn `base` into `doc`. Characters added to the
 * cast since `base` go as `cast.add`, by the id their bubbles name and the
 * typed name (#416), whether or not a bubble still names them. A bubble is in the
 * database when the baseline holds it and does not mark it deleted, so a
 * bubble restored (or un-deleted by an undo) after a Save goes back in as an
 * insert under its own id. Play order is written as `sort_order` for every
 * live bubble of a page whose order changed, and `panel_id` wherever a
 * bubble's panel changed; the same for panels and their order on the page.
 * `text_with_cues` is written as `cuesOf` the bubble whenever its text or
 * its cues differ from the baseline: the cues it holds while its text is the
 * exact text they were written for, and null otherwise. So a text edit clears
 * them, an accepted analyze proposal writes its own, an undo of that accept
 * writes back what was there, and a text edit undone back to the original
 * words writes the original cues again.
 * `groupId` is written as `group_id` whenever it differs (#451); the Save
 * route works out which group clips that leaves stale.
 * `auto` has no column and is not written.
 */
export function buildSave(base: Doc, doc: Doc): SaveEdits {
  const saved = new Set(base.addedCast.map((c) => c.id));
  const out: SaveEdits = {
    bubbles: { add: [], update: [], remove: [] },
    cast: {
      add: doc.addedCast
        .filter((c) => !saved.has(c.id))
        .map((c) => ({ id: c.id, name: c.name })),
    },
    panels: { add: [], update: [], remove: [] },
  };
  if (base === doc) return out;

  const inDb = (id: string) => {
    const b = base.bubbles[id];
    return !!b && !b.deleted;
  };
  const live = new Set<string>();

  for (const pageDoc of Object.values(doc.pages)) {
    const page = pageDoc.number;

    // Panels: geometry, order on the page, adds.
    const basePanelIds = (base.pages[page]?.panelIds ?? []).filter(
      (id) => doc.panels[id],
    );
    const panelOrderChanged =
      pageDoc.panelIds.length !== basePanelIds.length ||
      pageDoc.panelIds.some((id, i) => id !== basePanelIds[i]);
    pageDoc.panelIds.forEach((id, i) => {
      const panel = doc.panels[id];
      if (!panel) return;
      const was = base.panels[id];
      if (!was) {
        out.panels.add.push({ id, page, box: panel.rect, sortOrder: i });
        return;
      }
      const edit: { box?: BubbleDoc["rect"]; sortOrder?: number } = {};
      if (!sameRect(was.rect, panel.rect)) edit.box = panel.rect;
      if (panelOrderChanged) edit.sortOrder = i;
      if (Object.keys(edit).length > 0)
        out.panels.update.push({ id, page, ...edit });
    });

    // Bubbles: fields, panel, play order, adds.
    const now = playOrder(doc, page);
    const then = playOrder(base, page);
    for (const id of now.ids) live.add(id);
    const kept = then.ids.filter((id) => now.ids.includes(id));
    const orderChanged =
      now.ids.length !== kept.length || now.ids.some((id, i) => id !== kept[i]);

    now.ids.forEach((id, i) => {
      const b = doc.bubbles[id];
      if (!b) return;
      const panelId = now.panelOf.get(id) ?? null;
      if (!inDb(id)) {
        out.bubbles.add.push({
          id,
          page,
          sortOrder: i,
          panelId,
          box: b.rect,
          confidence: b.confidence,
          text: b.text,
          // A row restored by an undo, or a drawn one with an accepted
          // proposal, keeps its cues. Stored edits from before this field
          // existed have no `cues`.
          textWithCues: cuesOf(b),
          type: b.type,
          speaker: speakerOf(b),
          emotion: b.emotion,
          ignored: b.ignored,
          silent: b.silent,
          kept: b.kept,
          // Stored edits from before #451 have no `groupId`.
          ...(b.groupId ? { groupId: b.groupId } : {}),
        });
        return;
      }
      const was = base.bubbles[id];
      if (!was) return;
      const set: SaveEdits["bubbles"]["update"][number]["set"] = {};
      if (!sameSpeaker(speakerOf(was), speakerOf(b)))
        set.speaker = speakerOf(b);
      if (was.text !== b.text) set.text = b.text;
      if (was.text !== b.text || cuesOf(was) !== cuesOf(b))
        set.textWithCues = cuesOf(b);
      if (was.type !== b.type) set.type = b.type;
      if (was.emotion !== b.emotion) set.emotion = b.emotion;
      if (was.ignored !== b.ignored) set.ignored = b.ignored;
      if (was.silent !== b.silent) set.silent = b.silent;
      if (was.kept !== b.kept) set.kept = b.kept;
      if ((was.groupId ?? null) !== (b.groupId ?? null))
        set.groupId = b.groupId ?? null;
      if (!sameRect(was.rect, b.rect)) set.box = b.rect;
      if ((then.panelOf.get(id) ?? null) !== panelId) set.panelId = panelId;
      if (orderChanged) set.sortOrder = i;
      if (Object.keys(set).length > 0)
        out.bubbles.update.push({ id, page, set });
    });
  }

  for (const b of Object.values(base.bubbles)) {
    if (inDb(b.id) && !live.has(b.id))
      out.bubbles.remove.push({ id: b.id, page: b.page });
  }
  for (const p of Object.values(base.panels)) {
    if (!doc.panels[p.id]) out.panels.remove.push({ id: p.id, page: p.page });
  }
  return out;
}

/** How many rows a Save would write. */
export function saveCount(edits: SaveEdits): number {
  const { bubbles, cast, panels } = edits;
  return (
    (cast?.add.length ?? 0) +
    bubbles.add.length +
    bubbles.update.length +
    bubbles.remove.length +
    panels.add.length +
    panels.update.length +
    panels.remove.length
  );
}
