// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// Editor state: the document, where the owner is, and an undo stack of snapshots.
import type { Face } from "../types";
import type { BubbleDoc, Doc, Sel } from "./model";

interface HistoryEntry {
  doc: Doc;
  page: number;
  sel: Sel | null;
  label: string;
}

export interface EditorState {
  doc: Doc;
  /** The document as loaded from the database, for "discard edits". */
  base: Doc;
  /** The document at the last save. */
  saved: Doc;
  past: HistoryEntry[];
  future: HistoryEntry[];
  page: number;
  sel: Sel | null;
  /** Each page remembers what was selected on it. */
  selByPage: Record<number, Sel | null>;
  coalesce: string | null;
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
      select?: Sel | null;
      page?: number;
    }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; sel: Sel | null }
  | { type: "page"; page: number; sel?: Sel | null }
  | { type: "saved" }
  | {
      type: "hydrate";
      doc?: Doc;
      page?: number;
      selByPage?: Record<number, Sel | null>;
    }
  | { type: "discard" };

const LIMIT = 60;

function exists(doc: Doc, sel: Sel | null): Sel | null {
  if (!sel) return null;
  if (sel.kind === "bubble") {
    const b = doc.bubbles[sel.id];
    return b && !b.dismissed ? sel : null;
  }
  return doc.panels[sel.id] ? sel : null;
}

export function initState(doc: Doc, page: number): EditorState {
  return {
    doc,
    base: doc,
    saved: doc,
    past: [],
    future: [],
    page,
    sel: null,
    selByPage: {},
    coalesce: null,
    lastHistory: null,
  };
}

export function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      const doc = action.recipe(state.doc);
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
      const folds =
        action.coalesce !== undefined &&
        action.coalesce === state.coalesce &&
        state.past.length > 0;
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
    case "saved":
      return { ...state, saved: state.doc, coalesce: null };
    case "hydrate": {
      const doc = action.doc ?? state.doc;
      const page =
        action.page !== undefined && doc.pages[action.page]
          ? action.page
          : state.page;
      const selByPage = action.selByPage ?? state.selByPage;
      return {
        ...state,
        doc,
        saved: action.doc ? doc : state.saved,
        page,
        selByPage,
        sel: exists(doc, selByPage[page] ?? null),
      };
    }
    case "discard":
      return {
        ...initState(state.base, state.page),
        lastHistory: state.lastHistory,
      };
  }
}

// ------------------------------------------------- simulated analyze

export interface Proposal {
  text: string;
  speakerId: string | null;
  emotion: string;
}

/** Made-up lines: the prototype calls no model and copies no comic text. */
const LINES = [
  "WE NEED TO MOVE. NOW.",
  "DID YOU HEAR THAT?",
  "HOLD ON. I HAVE AN IDEA.",
  "THAT WAS TOO CLOSE.",
  "STAY BEHIND ME.",
  "NOT THIS AGAIN...",
];
const EMOTIONS = [
  "urgent",
  "wary",
  "excited",
  "relieved",
  "determined",
  "annoyed",
];

/**
 * Plausible values for a bubble: the nearest detected face in its panel is
 * the speaker, and each retry steps to the next nearest.
 */
export function simulateAnalyze(
  bubble: BubbleDoc,
  panelId: string | null,
  faces: Face[],
  attempt: number,
): Proposal {
  const cx = bubble.rect.x + bubble.rect.w / 2;
  const cy = bubble.rect.y + bubble.rect.h / 2;
  const nearby = faces
    .filter((f) => f.page === bubble.page && f.characterId)
    .filter((f) => !panelId || f.panelId === panelId)
    .map((f) => ({
      id: f.characterId,
      d: Math.hypot(f.rect.x + f.rect.w / 2 - cx, f.rect.y + f.rect.h / 2 - cy),
    }))
    .sort((a, b) => a.d - b.d);
  const ranked = Array.from(new Set(nearby.map((f) => f.id)));
  const seed = bubble.id.charCodeAt(bubble.id.length - 1) + attempt;
  return {
    text: LINES[seed % LINES.length] ?? "",
    // No face in the panel: the plausible guess is a voice from off the panel.
    speakerId:
      ranked.length > 0
        ? (ranked[attempt % ranked.length] ?? null)
        : "off-panel",
    emotion: EMOTIONS[seed % EMOTIONS.length] ?? "",
  };
}
