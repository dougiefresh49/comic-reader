// Editor state: the document, where the owner is, an undo stack of snapshots, and how it all packs into localStorage.
import {
  applyDocPatch,
  diffDoc,
  reconcile,
  repairChanged,
  type BubbleDoc,
  type Doc,
  type DocPatch,
  type Mint,
  type Sel,
} from "./model";

interface HistoryEntry {
  doc: Doc;
  page: number;
  sel: Sel | null;
  label: string;
}

export interface EditorState {
  doc: Doc;
  /** The document as loaded from the database: what the pending edits are measured against. */
  base: Doc;
  past: HistoryEntry[];
  future: HistoryEntry[];
  page: number;
  sel: Sel | null;
  /** Each page remembers what was selected on it. */
  selByPage: Record<number, Sel | null>;
  coalesce: string | null;
  /**
   * The current merged edit's document before `repairGroups` (#451), or
   * null. A merged edit (a typed box field, a nudge, a drag) replays on it,
   * so a half-typed value that briefly breaks a group leaves no new ids.
   */
  raw: Doc | null;
  /** The label of the last undo or redo, for the note. */
  lastHistory: { n: number; text: string } | null;
}

export type EditorAction =
  | {
      type: "apply";
      label: string;
      recipe: (doc: Doc) => Doc;
      /** Consecutive edits with the same key fold into one undo step. */
      coalesce?: string;
      /**
       * Mints group ids for `repairChanged`, run on the result measured from
       * the document before the undo step began. Left out, no repair.
       */
      mint?: Mint;
      select?: Sel | null;
      page?: number;
    }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; sel: Sel | null }
  | { type: "page"; page: number; sel?: Sel | null }
  | { type: "discard" }
  /**
   * A Save landed: the document it sent is the new baseline. Only the
   * baseline moves, so edits made while the Save was in flight stay pending,
   * and the undo history stays: an undo past the save point is measured
   * against the new baseline and shows as a new pending edit.
   */
  | { type: "saved"; base: Doc }
  /**
   * Regenerate cues wrote one row's `text_with_cues` outside Save. The
   * editor was locked while it ran, so nothing changed under it: the new
   * cues go into the baseline, the document and every undo and redo step
   * whose text is the text they were written for, so no step can write
   * older cues for that text back.
   */
  | { type: "cuesWritten"; id: string; cues: NonNullable<BubbleDoc["cues"]> };

const LIMIT = 60;

function exists(doc: Doc, sel: Sel | null): Sel | null {
  if (!sel) return null;
  if (sel.kind === "bubble") {
    const b = doc.bubbles[sel.id];
    return b && !b.deleted ? sel : null;
  }
  return doc.panels[sel.id] ? sel : null;
}

export function initState(doc: Doc, page: number): EditorState {
  return {
    doc,
    base: doc,
    past: [],
    future: [],
    page,
    sel: null,
    selByPage: {},
    coalesce: null,
    raw: null,
    lastHistory: null,
  };
}

export function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      const folds =
        action.coalesce !== undefined &&
        action.coalesce === state.coalesce &&
        state.past.length > 0;
      // A merged edit replays on its unrepaired document and is repaired
      // against the document before the undo step began (#451), so only the
      // step's end state can split a group.
      const stepStart = folds
        ? (state.past[state.past.length - 1]?.doc ?? state.doc)
        : state.doc;
      const raw = action.recipe(folds && state.raw ? state.raw : state.doc);
      const doc = action.mint
        ? repairChanged(stepStart, raw, action.mint)
        : raw;
      const page = action.page ?? state.page;
      const sel =
        action.select !== undefined
          ? exists(doc, action.select)
          : exists(doc, state.sel);
      if (doc === state.doc) {
        return sel === state.sel && page === state.page
          ? state
          : { ...state, sel, page };
      }
      const past = folds
        ? state.past
        : [
            ...state.past,
            {
              doc: state.doc,
              page: state.page,
              sel: state.sel,
              label: action.label,
            },
          ].slice(-LIMIT);
      return {
        ...state,
        doc,
        past,
        future: [],
        page,
        sel,
        selByPage: { ...state.selByPage, [page]: sel },
        coalesce: action.coalesce ?? null,
        raw: action.coalesce !== undefined ? raw : null,
      };
    }
    case "undo": {
      const entry = state.past[state.past.length - 1];
      if (!entry) return state;
      return {
        ...state,
        doc: entry.doc,
        page: entry.page,
        sel: exists(entry.doc, entry.sel),
        past: state.past.slice(0, -1),
        future: [
          ...state.future,
          {
            doc: state.doc,
            page: state.page,
            sel: state.sel,
            label: entry.label,
          },
        ],
        coalesce: null,
        lastHistory: {
          n: (state.lastHistory?.n ?? 0) + 1,
          text: `Undid: ${entry.label}`,
        },
      };
    }
    case "redo": {
      const entry = state.future[state.future.length - 1];
      if (!entry) return state;
      return {
        ...state,
        doc: entry.doc,
        page: entry.page,
        sel: exists(entry.doc, entry.sel),
        future: state.future.slice(0, -1),
        past: [
          ...state.past,
          {
            doc: state.doc,
            page: state.page,
            sel: state.sel,
            label: entry.label,
          },
        ],
        coalesce: null,
        lastHistory: {
          n: (state.lastHistory?.n ?? 0) + 1,
          text: `Redid: ${entry.label}`,
        },
      };
    }
    case "select": {
      const sel = exists(state.doc, action.sel);
      return {
        ...state,
        sel,
        selByPage: { ...state.selByPage, [state.page]: sel },
        coalesce: null,
      };
    }
    case "page": {
      if (!state.doc.pages[action.page]) return state;
      const sel = exists(
        state.doc,
        action.sel !== undefined
          ? action.sel
          : (state.selByPage[action.page] ?? null),
      );
      return {
        ...state,
        page: action.page,
        sel,
        selByPage: {
          ...state.selByPage,
          [state.page]: state.sel,
          [action.page]: sel,
        },
        coalesce: null,
      };
    }
    case "discard":
      return {
        ...initState(state.base, state.page),
        lastHistory: state.lastHistory,
      };
    case "saved":
      return { ...state, base: action.base };
    case "cuesWritten": {
      const { id, cues } = action;
      const take = (doc: Doc): Doc => {
        const b = doc.bubbles[id];
        // A step whose text differs still holds cues for the sent text when
        // its text is later typed back, so those are replaced too.
        if (!b || (b.text !== cues.forText && b.cues?.forText !== cues.forText))
          return doc;
        return { ...doc, bubbles: { ...doc.bubbles, [id]: { ...b, cues } } };
      };
      const takeEntry = (entry: HistoryEntry): HistoryEntry => {
        const doc = take(entry.doc);
        return doc === entry.doc ? entry : { ...entry, doc };
      };
      return {
        ...state,
        base: take(state.base),
        doc: take(state.doc),
        // A merged edit after this replays on the document, not on a raw
        // copy that lacks the new cues.
        raw: null,
        past: state.past.map(takeEntry),
        future: state.future.map(takeEntry),
      };
    }
  }
}

// ------------------------------------------------------- stored in the browser

interface StoredEntry {
  /** Turns the neighbouring newer document into this entry's document. */
  patch: DocPatch | null;
  page: number;
  sel: Sel | null;
  label: string;
}

/**
 * What localStorage holds for one issue. Patches, not snapshots: sixty whole
 * copies of a 300-bubble issue would not fit, and would be slow to write.
 */
export interface StoredState {
  v: 2;
  /**
   * Changes on every write. A tab writes only over the revision it last read
   * or wrote, so a stale tab cannot overwrite another tab's edits.
   */
  rev: string;
  /** The pending edits: turns the loaded rows into the document. */
  edits: DocPatch | null;
  /** Undo stack, oldest first. Each patch steps back from the entry after it. */
  past: StoredEntry[];
  /** Redo stack, next redo last. Each patch steps on from the entry after it. */
  future: StoredEntry[];
  page: number;
  selByPage: Record<number, Sel | null>;
}

function packStack(doc: Doc, stack: HistoryEntry[]): StoredEntry[] {
  const out: StoredEntry[] = [];
  let newer = doc;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (!entry) continue;
    out.unshift({
      patch: diffDoc(newer, entry.doc),
      page: entry.page,
      sel: entry.sel,
      label: entry.label,
    });
    newer = entry.doc;
  }
  return out;
}

function unpackStack(doc: Doc, stored: StoredEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let newer = doc;
  for (let i = stored.length - 1; i >= 0; i--) {
    const entry = stored[i];
    if (!entry) continue;
    newer = applyDocPatch(newer, entry.patch);
    out.unshift({
      doc: newer,
      page: entry.page,
      sel: entry.sel,
      label: entry.label,
    });
  }
  return out;
}

export function packState(state: EditorState, rev: string): StoredState {
  return {
    v: 2,
    rev,
    edits: diffDoc(state.base, state.doc),
    past: packStack(state.doc, state.past),
    future: packStack(state.doc, state.future),
    page: state.page,
    selByPage: { ...state.selByPage, [state.page]: state.sel },
  };
}

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The revision of whatever the key holds, or null when it holds none. */
export function storedRev(raw: string | null): string | null {
  const value = parse(raw);
  if (!value || typeof value !== "object") return null;
  const { rev } = value as { rev?: unknown };
  return typeof rev === "string" ? rev : null;
}

function isStored(value: unknown): value is StoredState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StoredState>;
  return (
    v.v === 2 &&
    typeof v.rev === "string" &&
    Array.isArray(v.past) &&
    Array.isArray(v.future)
  );
}

export interface Restored {
  state: EditorState;
  /** The revision that was read, for the first write to check against. */
  rev: string | null;
  /** A value was stored and could not be restored. The state starts clean. */
  unreadable: boolean;
  /**
   * The rows changed since the edits were stored: the edits were laid over
   * the new rows and the undo history, which no longer fits them, was dropped.
   */
  rowsChanged: boolean;
}

/**
 * The state a reload starts from: the loaded rows with the stored edits and
 * history laid back over them. `page` (from the URL) wins over the stored one.
 */
export function restoreState(
  base: Doc,
  raw: string | null,
  page: number | null,
  firstPage: number,
): Restored {
  const valid = (n: number | null | undefined) =>
    typeof n === "number" && base.pages[n] ? n : null;
  const clean = (unreadable: boolean): Restored => ({
    state: initState(base, valid(page) ?? firstPage),
    rev: storedRev(raw),
    unreadable,
    rowsChanged: false,
  });
  if (raw === null) return clean(false);
  const stored = parse(raw);
  if (!isStored(stored)) return clean(true);
  try {
    const patched = applyDocPatch(base, stored.edits);
    const doc = reconcile(patched);
    let past = doc === patched ? unpackStack(doc, stored.past) : [];
    let future = doc === patched ? unpackStack(doc, stored.future) : [];
    const rowsChanged =
      doc !== patched ||
      [...past, ...future].some((entry) => reconcile(entry.doc) !== entry.doc);
    if (rowsChanged) {
      past = [];
      future = [];
    }
    const at = valid(page) ?? valid(stored.page) ?? firstPage;
    const selByPage = stored.selByPage ?? {};
    return {
      state: {
        ...initState(base, at),
        doc,
        past,
        future,
        selByPage,
        sel: exists(doc, selByPage[at] ?? null),
      },
      rev: stored.rev,
      unreadable: false,
      rowsChanged,
    };
  } catch {
    return clean(true);
  }
}
