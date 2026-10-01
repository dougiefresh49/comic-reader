// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The workbench: tree on the left, page on a canvas, the selection's fields on the right.
"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  clearSession,
  protoHref,
  readSession,
  slug,
  storageKey,
  writeSession,
} from "../lib";
import type { CastMember, ProtoData, Rect, SrcPage } from "../types";
import { Canvas, type CanvasHandle, type Tool } from "./Canvas";
import { Inspector, Key, type Actions, type Analysis } from "./Inspector";
import {
  addBubble,
  addCast,
  initDoc,
  isDoc,
  issueFlags,
  moveBubbleTo,
  moveBubbleToPanel,
  movePanelTo,
  pageBubbleIds,
  pageFlags,
  pagePanels,
  panelOf,
  patchBubble,
  setBubbleRect,
  setDismissed,
  setPageApproved,
  setPanelRect,
  setSpeaker,
  shiftBubble,
  shiftPanel,
  visibleBubbles,
  type BubbleDoc,
  type Doc,
  type Sel,
  type VoiceChoice,
} from "./model";
import { initState, reducer, simulateAnalyze } from "./store";
import { Tree } from "./Tree";

interface WorkbenchProps {
  data: ProtoData;
  /** From `?page=`; null means "wherever this tab was last". */
  initialPage: number | null;
}

interface Note {
  n: number;
  text: string;
  tone: "plain" | "warn";
}

const TYPE_KEYS: Record<string, BubbleDoc["type"]> = {
  "1": "SPEECH",
  "2": "NARRATION",
  "3": "CAPTION",
  "4": "SFX",
  "5": "BACKGROUND",
};

const SHEET: { title: string; rows: [string, string][] }[] = [
  {
    title: "Move around",
    rows: [
      ["↓ / J", "Next panel or bubble, runs on into the next page"],
      ["↑ / K", "Previous panel or bubble"],
      ["→ / ]", "Next page"],
      ["← / [", "Previous page"],
      ["N", "Next bubble that needs you, on any page"],
      ["Shift N", "Previous bubble that needs you"],
      ["Esc", "Leave a field, then clear the selection"],
    ],
  },
  {
    title: "Edit the selected bubble",
    rows: [
      ["E", "Edit the text"],
      ["S", "Pick the speaker, Enter takes the nearest face"],
      ["M", "Edit the emotion"],
      ["1 to 5", "Speech, narration, caption, SFX, background"],
      ["X", "Silent: shown, no audio"],
      ["I", "Ignored: not a bubble"],
      ["D", "Dismiss a duplicate"],
      ["Y", "Keep both: not a duplicate"],
    ],
  },
  {
    title: "Order and boxes",
    rows: [
      ["Alt ↑ / ↓", "Earlier or later in play order, crosses panels"],
      ["Shift arrows", "Move the box"],
      ["Alt Shift arrows", "Resize the box"],
      ["B", "Draw a bubble with the mouse"],
      ["Shift B", "Drop a bubble in the current panel"],
      ["Enter / R", "Accept or retry the analyze result"],
    ],
  },
  {
    title: "Page and issue",
    rows: [
      ["A", "Approve the page and go to the next one"],
      ["Shift A", "Approve the issue"],
      ["Cmd Z", "Undo. With Shift, redo"],
      ["Cmd S", "Save"],
    ],
  },
  {
    title: "View",
    rows: [
      ["Space drag", "Pan. The wheel pans too"],
      ["Cmd wheel", "Zoom at the cursor. Also + and -"],
      ["Z", "Zoom to the selected panel"],
      ["0", "Fit the page"],
      ["F", "Show only what needs you"],
      [", and .", "Fold the left and right drawers"],
      ["?", "This sheet"],
    ],
  },
];

/** Drives one bubble's simulated analyze: a second of stillness, then a second of "work". */
function AnalysisDriver({
  id,
  phase,
  rectKey,
  busy,
  onAdvance,
}: {
  id: string;
  phase: Analysis["phase"];
  rectKey: string;
  busy: boolean;
  onAdvance: (id: string, to: "running" | "ready") => void;
}) {
  useEffect(() => {
    if (phase === "ready" || busy) return;
    const timer = window.setTimeout(
      () => onAdvance(id, phase === "still" ? "running" : "ready"),
      phase === "still" ? 1000 : 1100,
    );
    return () => window.clearTimeout(timer);
  }, [id, phase, rectKey, busy, onAdvance]);
  return null;
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
      <path
        d={dir === "left" ? "M5.5 1L2 4l3.5 3" : "M2.5 1L6 4 2.5 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

const BAR_BUTTON =
  "flex h-6 items-center gap-1.5 rounded-sm border border-neutral-800 px-2 text-neutral-300 hover:border-neutral-600 hover:text-white disabled:text-neutral-600 disabled:hover:border-neutral-800";

export function Workbench({ data, initialPage }: WorkbenchProps) {
  const firstPage = data.pages[0]?.number ?? 1;
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initState(
      initDoc(data),
      initialPage && data.pages.some((p) => p.number === initialPage)
        ? initialPage
        : firstPage,
    ),
  );
  const { doc, page: pageNumber, sel } = state;

  const [tool, setTool] = useState<Tool>("select");
  const [hover, setHover] = useState<Sel | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [picker, setPicker] = useState<{
    open: boolean;
    addName: string | null;
  }>({ open: false, addName: null });
  const [analysis, setAnalysis] = useState<Record<string, Analysis>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [sheet, setSheet] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const emotionRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);

  const docKey = storageKey("doc", data.bookId, data.issueId);
  const viewKey = storageKey("view", data.bookId, data.issueId);

  const say = useCallback((text: string, tone: Note["tone"] = "plain") => {
    setNote((prev) => ({ n: (prev?.n ?? 0) + 1, text, tone }));
  }, []);

  // ------------------------------------------------------------- derived

  const pagesByNumber = useMemo(
    () => new Map<number, SrcPage>(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );
  const page = pagesByNumber.get(pageNumber) ?? data.pages[0];

  const cast = useMemo<CastMember[]>(() => {
    const added: CastMember[] = doc.addedCast.map((c, i) => ({
      id: c.id,
      name: c.name,
      aliases: [],
      kind: "character",
      tint: data.cast.length + i,
      voice: c.voice.kind === "borrow" ? c.voice.voice : "New voice",
      faceCount: 0,
      pages: [],
      portrait: null,
    }));
    return [
      ...[...data.cast.filter((c) => c.kind === "character"), ...added].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
      ...data.cast.filter((c) => c.kind === "role"),
    ];
  }, [data.cast, doc.addedCast]);
  const castById = useMemo(() => new Map(cast.map((c) => [c.id, c])), [cast]);

  const panels = useMemo(() => pagePanels(doc, pageNumber), [doc, pageNumber]);
  const flags = useMemo(() => pageFlags(doc, pageNumber), [doc, pageNumber]);
  const allFlags = useMemo(() => issueFlags(doc), [doc]);
  const bubbles = useMemo(
    () => visibleBubbles(doc, pageBubbleIds(doc, pageNumber)),
    [doc, pageNumber],
  );
  const numbers = useMemo(
    () => new Map(bubbles.map((b, i) => [b.id, i + 1])),
    [bubbles],
  );
  /** Tree order: each panel, then its bubbles, then the bubbles outside every panel. */
  const rows = useMemo<Sel[]>(() => {
    const out: Sel[] = [];
    for (const p of panels) {
      out.push({ kind: "panel", id: p.id });
      for (const b of visibleBubbles(doc, p.bubbleIds))
        out.push({ kind: "bubble", id: b.id });
    }
    for (const b of visibleBubbles(doc, doc.pages[pageNumber]?.looseIds ?? []))
      out.push({ kind: "bubble", id: b.id });
    return out;
  }, [doc, panels, pageNumber]);

  const flagsByPage = useMemo(() => {
    const out = new Map<number, number>();
    for (const f of allFlags) out.set(f.page, (out.get(f.page) ?? 0) + 1);
    return out;
  }, [allFlags]);
  const pageApproved = useCallback(
    (n: number, d: Doc = doc) =>
      (d.pages[n]?.approved ?? false) && !flagsByPage.has(n),
    [doc, flagsByPage],
  );
  const approvedCount = data.pages.filter((p) => pageApproved(p.number)).length;

  const selBubble = sel?.kind === "bubble" ? doc.bubbles[sel.id] : undefined;
  const selPanel = sel?.kind === "panel" ? doc.panels[sel.id] : undefined;
  const focusPanel = selPanel ?? (selBubble ? panelOf(doc, selBubble) : null);
  const focusPanelId = focusPanel?.id ?? null;
  const faces = useMemo(
    () =>
      selBubble && focusPanelId
        ? data.faces.filter((f) => f.panelId === focusPanelId)
        : [],
    [data.faces, focusPanelId, selBubble],
  );

  const emotions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of data.bubbles) {
      const e = b.emotion.trim().toLowerCase();
      if (e && e.length <= 14 && !e.includes(","))
        counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([e]) => e);
  }, [data.bubbles]);

  // ------------------------------------------------------------- effects

  // Restore what this tab last saved and where it was. Runs once, after mount.
  useEffect(() => {
    const savedDoc = readSession<{ doc?: unknown }>(docKey)?.doc;
    const view = readSession<{
      page?: number;
      selByPage?: Record<number, Sel | null>;
    }>(viewKey);
    dispatch({
      type: "hydrate",
      doc: isDoc(savedDoc) ? savedDoc : undefined,
      page: initialPage ?? view?.page,
      selByPage: view?.selByPage,
    });
    setHydrated(true);
  }, [docKey, viewKey, initialPage]);

  // The page lives in the URL and the selection in the tab, so a refresh lands in place.
  useEffect(() => {
    if (!hydrated) return;
    writeSession(viewKey, {
      page: pageNumber,
      selByPage: { ...state.selByPage, [pageNumber]: sel },
    });
    const url = new URL(window.location.href);
    if (url.searchParams.get("page") !== String(pageNumber)) {
      url.searchParams.set("page", String(pageNumber));
      window.history.replaceState(null, "", url);
    }
  }, [hydrated, viewKey, pageNumber, sel, state.selByPage]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 4200);
    return () => window.clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    if (state.lastHistory) say(state.lastHistory.text);
  }, [state.lastHistory, say]);

  // Neighbouring pages load ahead so a page turn shows art at once.
  useEffect(() => {
    for (const n of [pageNumber + 1, pageNumber - 1]) {
      const next = pagesByNumber.get(n);
      if (next) new window.Image().src = next.imageUrl;
    }
  }, [pageNumber, pagesByNumber]);

  const selId = sel?.id ?? null;
  useEffect(() => {
    setPicker({ open: false, addName: null });
  }, [selId, pageNumber]);

  // Bring the selection into view when it is off screen.
  const selRect = selBubble?.rect ?? selPanel?.rect ?? null;
  const selRectKey = selRect
    ? `${selId}:${selRect.x}:${selRect.y}:${selRect.w}:${selRect.h}`
    : null;
  const selRectRef = useRef(selRect);
  useEffect(() => {
    selRectRef.current = selRect;
  });
  useEffect(() => {
    if (selRectRef.current) canvasRef.current?.reveal(selRectRef.current);
  }, [selRectKey]);

  // ------------------------------------------------------------- actions

  const apply = useCallback(
    (
      label: string,
      recipe: (d: Doc) => Doc,
      opts?: { coalesce?: string; select?: Sel | null; page?: number },
    ) => dispatch({ type: "apply", label, recipe, ...opts }),
    [],
  );

  const select = useCallback((next: Sel | null) => {
    dispatch({ type: "select", sel: next });
  }, []);

  const goto = useCallback((n: number, next?: Sel | null) => {
    dispatch({ type: "page", page: n, sel: next });
  }, []);

  const turnPage = (dir: -1 | 1) => {
    const index = data.pages.findIndex((p) => p.number === pageNumber);
    const next = data.pages[index + dir];
    if (next) goto(next.number);
  };

  const stepRow = (dir: -1 | 1) => {
    const at = sel
      ? rows.findIndex((r) => r.kind === sel.kind && r.id === sel.id)
      : -1;
    const next = rows[at === -1 ? (dir === 1 ? 0 : rows.length - 1) : at + dir];
    if (next) {
      select(next);
      return;
    }
    // Past the end of the page: carry on into the neighbouring page.
    const index = data.pages.findIndex((p) => p.number === pageNumber);
    const neighbour = data.pages[index + dir];
    if (!neighbour) return;
    const ids = visibleBubbles(doc, pageBubbleIds(doc, neighbour.number));
    const panelIds = doc.pages[neighbour.number]?.panelIds ?? [];
    const firstPanel = panelIds[0];
    const last = ids[ids.length - 1];
    goto(
      neighbour.number,
      dir === 1
        ? firstPanel
          ? { kind: "panel", id: firstPanel }
          : null
        : last
          ? { kind: "bubble", id: last.id }
          : null,
    );
  };

  const stepFlag = (dir: -1 | 1) => {
    if (allFlags.length === 0) {
      say("Nothing needs you.");
      return;
    }
    const order = pageBubbleIds(doc, pageNumber);
    const here = sel?.kind === "bubble" ? order.indexOf(sel.id) : -1;
    const position = (f: (typeof allFlags)[number]) =>
      f.page * 10000 + (f.page === pageNumber ? order.indexOf(f.bubbleId) : 0);
    const current =
      pageNumber * 10000 + (here === -1 ? (dir === 1 ? -1 : 9999) : here);
    const sorted = allFlags.slice().sort((a, b) => position(a) - position(b));
    const next =
      dir === 1
        ? (sorted.find((f) => position(f) > current) ?? sorted[0])
        : (sorted
            .slice()
            .reverse()
            .find((f) => position(f) < current) ?? sorted[sorted.length - 1]);
    if (next) goto(next.page, { kind: "bubble", id: next.bubbleId });
  };

  const startAnalysis = (id: string, phase: Analysis["phase"]) =>
    setAnalysis((prev) => ({
      ...prev,
      [id]: { phase, attempt: prev[id]?.attempt ?? 0, proposal: null },
    }));

  const drawBubble = (rect: Rect) => {
    counter.current += 1;
    const id = `new-${Date.now().toString(36)}-${counter.current}`;
    apply("add bubble", (d) => addBubble(d, id, pageNumber, rect), {
      select: { kind: "bubble", id },
    });
    startAnalysis(id, "still");
    setTool("select");
    setRightOpen(true);
  };

  const dropBubble = () => {
    const host = focusPanel ?? panels[0];
    const w = 0.14;
    const h = 0.05;
    drawBubble(
      host
        ? {
            x: host.rect.x + host.rect.w / 2 - w / 2,
            y: host.rect.y + host.rect.h / 2 - h / 2,
            w,
            h,
          }
        : { x: 0.5 - w / 2, y: 0.5 - h / 2, w, h },
    );
  };

  const setRect = (target: Sel, rect: Rect, coalesce?: string) => {
    apply(
      target.kind === "panel" ? "panel box change" : "bubble box change",
      (d) =>
        target.kind === "panel"
          ? setPanelRect(d, target.id, rect)
          : setBubbleRect(d, target.id, rect),
      { coalesce },
    );
    // A moved box that is still waiting for analyze starts its still-timer again.
    if (target.kind === "bubble" && doc.bubbles[target.id]?.pending)
      startAnalysis(target.id, "still");
  };

  // Reads the document through a ref so an unrelated edit does not restart a timer.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const advance = useCallback(
    (id: string, to: "running" | "ready") => {
      setAnalysis((prev) => {
        const run = prev[id];
        const current = docRef.current;
        const bubble = current.bubbles[id];
        if (!run || !bubble) return prev;
        if (to === "running") return { ...prev, [id]: { ...run, phase: to } };
        return {
          ...prev,
          [id]: {
            ...run,
            phase: "ready",
            proposal: simulateAnalyze(
              bubble,
              panelOf(current, bubble)?.id ?? null,
              data.faces,
              run.attempt,
            ),
          },
        };
      });
    },
    [data.faces],
  );

  const accept = (id: string) => {
    const proposal = analysis[id]?.proposal;
    if (!proposal) return;
    apply("accept analyze result", (d) =>
      patchBubble(d, id, {
        text: proposal.text,
        emotion: proposal.emotion,
        speakerId: proposal.speakerId,
        rawSpeaker: null,
        pending: false,
      }),
    );
    setAnalysis((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    say("Accepted the simulated result. Audio stays a separate step.");
  };

  const retry = (id: string) =>
    setAnalysis((prev) => {
      const run = prev[id];
      return run
        ? {
            ...prev,
            [id]: {
              phase: "running",
              attempt: run.attempt + 1,
              proposal: null,
            },
          }
        : prev;
    });

  const dismiss = (ids: string[]) => {
    // Land on the next flagged bubble so D, D, D clears a page of duplicates.
    const order = pageBubbleIds(doc, pageNumber).filter(
      (id) => flags.has(id) && !ids.includes(id),
    );
    const all = pageBubbleIds(doc, pageNumber);
    const from = sel?.kind === "bubble" ? all.indexOf(sel.id) : -1;
    const next = order.find((id) => all.indexOf(id) > from) ?? order[0] ?? null;
    apply(
      ids.length === 1
        ? "dismiss duplicate"
        : `dismiss ${ids.length} duplicates`,
      (d) => setDismissed(d, ids, true),
      {
        select:
          sel?.kind === "bubble" && ids.includes(sel.id)
            ? next
              ? { kind: "bubble", id: next }
              : null
            : sel,
      },
    );
    say(
      ids.length === 1
        ? "Dismissed. It stays under Dismissed duplicates in the tree."
        : `Dismissed ${ids.length} duplicates.`,
    );
  };

  const approvePage = () => {
    if (flags.size > 0) {
      const first = pageBubbleIds(doc, pageNumber).find((id) => flags.has(id));
      if (first) select({ kind: "bubble", id: first });
      say(
        `Page ${pageNumber} is blocked: ${flags.size} ${
          flags.size === 1 ? "bubble needs" : "bubbles need"
        } you. This is the first.`,
        "warn",
      );
      return;
    }
    if (doc.pages[pageNumber]?.approved) {
      say(`Page ${pageNumber} is already approved.`);
      return;
    }
    const next = data.pages.find(
      (p) => p.number !== pageNumber && !pageApproved(p.number),
    );
    apply("approve page", (d) => setPageApproved(d, pageNumber, true), {
      page: next?.number,
      select: next ? (state.selByPage[next.number] ?? null) : null,
    });
    say(
      next
        ? `Page ${pageNumber} approved. Now on page ${next.number}.`
        : `Page ${pageNumber} approved. Every page is approved: Shift A approves the issue.`,
    );
  };

  const approveIssue = () => {
    const firstFlag = allFlags[0];
    if (firstFlag) {
      goto(firstFlag.page, { kind: "bubble", id: firstFlag.bubbleId });
      say(
        `The issue is blocked: ${allFlags.length} ${
          allFlags.length === 1 ? "bubble needs" : "bubbles need"
        } you. This is the first.`,
        "warn",
      );
      return;
    }
    const open = data.pages.find((p) => !pageApproved(p.number));
    if (open) {
      goto(open.number, null);
      say(`Page ${open.number} is not approved yet.`, "warn");
      return;
    }
    apply("approve issue", (d) => ({ ...d, issueApproved: true }), {
      select: null,
    });
    say("Issue approved. Nothing was written: this is a prototype.");
  };

  const save = () => {
    dispatch({ type: "saved" });
    writeSession(docKey, { v: 1, doc });
    say(
      "Saved. Page, selection and values stay as they are. Nothing was written: this is a prototype.",
    );
  };

  const discard = () => {
    clearSession(docKey);
    setAnalysis({});
    dispatch({ type: "discard" });
    say("Edits discarded. Back to the rows as loaded.");
  };

  const openField = (
    field: "text" | "emotion" | "speaker",
    addName?: string,
  ) => {
    if (!selBubble) return;
    setRightOpen(true);
    if (field === "speaker") {
      setPicker({ open: true, addName: addName ?? null });
      return;
    }
    window.requestAnimationFrame(() => {
      // Text keeps what is there, caret at the end; the short emotion is replaced.
      if (field === "text") {
        const el = textRef.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
        return;
      }
      emotionRef.current?.focus();
      emotionRef.current?.select();
    });
  };

  const actions: Actions = {
    select,
    patch: (id, patch, label, coalesce) =>
      apply(label, (d) => patchBubble(d, id, patch), { coalesce }),
    setSpeaker: (id, castId) => {
      apply("speaker change", (d) => setSpeaker(d, id, castId));
      setPicker({ open: false, addName: null });
    },
    addCast: (name: string, voice: VoiceChoice, bubbleId, raw) => {
      let id = slug(name) || "character";
      while (castById.has(id)) id = `${id}-2`;
      const single = raw && !/,|&|\/|\band\b/i.test(raw) ? raw : undefined;
      apply("add character", (d) =>
        setSpeaker(addCast(d, { id, name, voice }, single), bubbleId, id),
      );
      setPicker({ open: false, addName: null });
      say(
        voice.kind === "new"
          ? `${name} joins the cast with a new voice, made after the pages are approved.`
          : `${name} joins the cast, borrowing the voice ${voice.voice}.`,
      );
    },
    openPicker: (addName) => openField("speaker", addName),
    closePicker: () => setPicker({ open: false, addName: null }),
    dismiss,
    keep: (id) => apply("keep both", (d) => patchBubble(d, id, { kept: true })),
    moveToPanel: (id, panelId) =>
      apply("move to panel", (d) => moveBubbleToPanel(d, id, panelId)),
    shift: (target, dir) =>
      apply(dir === -1 ? "move earlier" : "move later", (d) =>
        target.kind === "panel"
          ? shiftPanel(d, target.id, dir)
          : shiftBubble(d, target.id, dir),
      ),
    setRect,
    analyze: (id) => startAnalysis(id, "running"),
    accept,
    retry,
    zoomTo: (rect) => canvasRef.current?.zoomTo(rect),
    goto,
    approvePage,
    unapprovePage: () =>
      apply("undo page approval", (d) => setPageApproved(d, pageNumber, false)),
    approveIssue,
  };

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT");
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && key === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod) return;
      if (sheet) {
        if (key === "Escape" || key === "?") setSheet(false);
        return;
      }
      if (typing) {
        if (key === "Escape") t.blur();
        return;
      }

      const done = () => e.preventDefault();
      const arrow =
        key === "ArrowUp"
          ? [0, -1]
          : key === "ArrowDown"
            ? [0, 1]
            : key === "ArrowLeft"
              ? [-1, 0]
              : key === "ArrowRight"
                ? [1, 0]
                : null;

      if (arrow && e.shiftKey && sel && selRect) {
        // Nudge: Shift moves the box, Alt+Shift resizes it.
        const step = 0.0025;
        const dx = (arrow[0] ?? 0) * step;
        const dy = (arrow[1] ?? 0) * step;
        setRect(
          sel,
          e.altKey
            ? { ...selRect, w: selRect.w + dx, h: selRect.h + dy }
            : { ...selRect, x: selRect.x + dx, y: selRect.y + dy },
          `nudge:${sel.id}`,
        );
        return done();
      }
      if (arrow && e.altKey && sel && arrow[1] !== 0) {
        actions.shift(sel, arrow[1] === -1 ? -1 : 1);
        return done();
      }
      if (e.altKey) return;

      switch (key) {
        case "?":
          setSheet(true);
          return done();
        case "Escape":
          if (picker.open) setPicker({ open: false, addName: null });
          else if (tool === "draw") setTool("select");
          else select(null);
          return done();
        case "ArrowDown":
        case "j":
          stepRow(1);
          return done();
        case "ArrowUp":
        case "k":
          stepRow(-1);
          return done();
        case "ArrowRight":
        case "]":
        case "PageDown":
          turnPage(1);
          return done();
        case "ArrowLeft":
        case "[":
        case "PageUp":
          turnPage(-1);
          return done();
        case "n":
          stepFlag(e.shiftKey ? -1 : 1);
          return done();
        case "a":
          if (e.shiftKey) approveIssue();
          else approvePage();
          return done();
        case "b":
          if (e.shiftKey) dropBubble();
          else setTool((prev) => (prev === "draw" ? "select" : "draw"));
          return done();
        case "v":
          setTool("select");
          return done();
        case "f":
          setOnlyFlagged((v) => !v);
          return done();
        case ",":
          setLeftOpen((v) => !v);
          return done();
        case ".":
          setRightOpen((v) => !v);
          return done();
        case "0":
          canvasRef.current?.fit();
          return done();
        case "+":
        case "=":
          canvasRef.current?.zoomBy(1.25);
          return done();
        case "-":
          canvasRef.current?.zoomBy(0.8);
          return done();
        case "z":
          if (focusPanel) canvasRef.current?.zoomTo(focusPanel.rect);
          return done();
        case " ":
          return done();
      }

      if (!selBubble) return;
      const b = selBubble;
      const run = analysis[b.id];
      switch (key) {
        case "Enter":
          if (run?.phase === "ready") accept(b.id);
          else openField("text");
          return done();
        case "e":
          openField("text");
          return done();
        case "s":
          openField("speaker");
          return done();
        case "m":
          openField("emotion");
          return done();
        case "r":
          if (run?.phase === "ready") retry(b.id);
          return done();
        case "x":
          actions.patch(
            b.id,
            { silent: !b.silent },
            b.silent ? "unmark silent" : "mark silent",
          );
          return done();
        case "i":
          actions.patch(
            b.id,
            { ignored: !b.ignored },
            b.ignored ? "unmark ignored" : "mark ignored",
          );
          return done();
        case "d":
          if (flags.get(b.id)?.some((f) => f.kind === "duplicate"))
            dismiss([b.id]);
          else say("Not flagged as a duplicate. I marks it ignored.", "warn");
          return done();
        case "y":
          if (flags.get(b.id)?.some((f) => f.kind === "duplicate"))
            actions.keep(b.id);
          return done();
      }
      const type = TYPE_KEYS[key];
      if (type) {
        actions.patch(b.id, { type }, "type change");
        return done();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // -------------------------------------------------------------- render

  if (!page) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-[13px] text-neutral-400">
        This issue has no pages.
      </div>
    );
  }

  const dirty = doc !== state.saved;
  const edited = doc !== state.base;
  const pageIndex = data.pages.findIndex((p) => p.number === pageNumber);
  const hints: [string, string][] = selBubble
    ? [
        ["↑↓", "step"],
        ["S", "speaker"],
        ["E", "text"],
        ["X", "silent"],
        ...(flags.get(selBubble.id)?.some((f) => f.kind === "duplicate")
          ? ([
              ["D", "dismiss"],
              ["Y", "keep"],
            ] as [string, string][])
          : []),
        ["N", "next flag"],
      ]
    : selPanel
      ? [
          ["↑↓", "step"],
          ["Alt ↑↓", "reorder"],
          ["Z", "zoom to panel"],
          ["Shift B", "drop a bubble"],
        ]
      : [
          ["↓", "first panel"],
          ["N", "next flag"],
          ["A", "approve page"],
          ["B", "draw a bubble"],
          ["← →", "pages"],
        ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-[12px] text-neutral-200">
      {Object.entries(analysis).map(([id, run]) => {
        const b = doc.bubbles[id];
        if (!b || b.dismissed) return null;
        return (
          <AnalysisDriver
            key={id}
            id={id}
            phase={run.phase}
            rectKey={`${b.rect.x}:${b.rect.y}:${b.rect.w}:${b.rect.h}:${run.attempt}`}
            busy={busyId === id}
            onAdvance={advance}
          />
        );
      })}

      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-800 px-3">
        <nav className="flex items-center gap-1.5 text-neutral-500">
          <Link
            href={protoHref("", data.bookId, data.issueId)}
            className="hover:text-neutral-100"
          >
            {data.bookName}, {data.issueName}
          </Link>
          <span>/</span>
          <Link
            href={protoHref("/characters", data.bookId, data.issueId)}
            className="hover:text-neutral-100"
          >
            Characters
          </Link>
          <span>/</span>
          <span className="text-neutral-100">Pages</span>
        </nav>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            title="Previous page (←)"
            disabled={pageIndex <= 0}
            onClick={() => turnPage(-1)}
            className={BAR_BUTTON + " px-1.5"}
          >
            <Chevron dir="left" />
          </button>
          <span className="min-w-[84px] text-center text-neutral-100 tabular-nums">
            Page {pageNumber} of {data.pages.length}
          </span>
          <button
            type="button"
            aria-label="Next page"
            title="Next page (→)"
            disabled={pageIndex >= data.pages.length - 1}
            onClick={() => turnPage(1)}
            className={BAR_BUTTON + " px-1.5"}
          >
            <Chevron dir="right" />
          </button>
        </div>

        <div className="flex overflow-hidden rounded-sm border border-neutral-800">
          {(
            [
              ["select", "Select", "V"],
              ["draw", "Draw bubble", "B"],
            ] as const
          ).map(([id, label, k]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
              className={`flex h-6 items-center gap-1.5 px-2 ${
                tool === id
                  ? "bg-neutral-200 text-neutral-950"
                  : "text-neutral-400 hover:text-neutral-100"
              }`}
            >
              {label}
              <span
                className={
                  tool === id ? "text-neutral-600" : "text-neutral-600"
                }
              >
                {k}
              </span>
            </button>
          ))}
        </div>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => stepFlag(1)}
          className={`flex h-6 items-center gap-1.5 rounded-sm border px-2 ${
            allFlags.length > 0
              ? "border-amber-400/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
              : "border-neutral-800 text-emerald-300"
          }`}
        >
          {allFlags.length > 0 ? (
            <>
              {allFlags.length} need you
              <span className="text-amber-200/60">
                {flags.size} on this page
              </span>
              <Key>N</Key>
            </>
          ) : (
            "Nothing needs you"
          )}
        </button>
        <button
          type="button"
          disabled={state.past.length === 0}
          onClick={() => dispatch({ type: "undo" })}
          className={BAR_BUTTON}
          title="Undo (Cmd Z)"
        >
          Undo
          {state.past.length > 0 && (
            <span className="text-neutral-500 tabular-nums">
              {state.past.length}
            </span>
          )}
        </button>
        <button
          type="button"
          disabled={state.future.length === 0}
          onClick={() => dispatch({ type: "redo" })}
          className={BAR_BUTTON}
          title="Redo (Shift Cmd Z)"
        >
          Redo
        </button>
        <button
          type="button"
          onClick={save}
          title="Save (Cmd S)"
          className={`flex h-6 items-center gap-1.5 rounded-sm px-2.5 ${
            dirty
              ? "bg-neutral-100 font-medium text-neutral-950 hover:bg-white"
              : "border border-neutral-800 text-neutral-500"
          }`}
        >
          {dirty ? "Save" : "Saved"}
        </button>
        <button
          type="button"
          onClick={() => setSheet(true)}
          className={BAR_BUTTON}
        >
          Keys <span className="text-neutral-500">?</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {leftOpen && (
          <aside className="flex w-[304px] shrink-0 flex-col border-r border-neutral-800">
            <div className="border-b border-neutral-800 p-2">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-neutral-500">
                <span>Pages</span>
                <span>
                  {approvedCount} of {data.pages.length} approved
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {data.pages.map((p) => {
                  const count = flagsByPage.get(p.number) ?? 0;
                  const ok = pageApproved(p.number);
                  return (
                    <button
                      key={p.number}
                      type="button"
                      tabIndex={-1}
                      onClick={() => goto(p.number)}
                      title={
                        count > 0
                          ? `Page ${p.number}: ${count} need you`
                          : ok
                            ? `Page ${p.number}: approved`
                            : `Page ${p.number}: ready to approve`
                      }
                      className={`relative h-6 w-6 rounded-sm border text-[11px] tabular-nums ${
                        p.number === pageNumber
                          ? "border-neutral-100 bg-neutral-100 font-medium text-neutral-950"
                          : ok
                            ? "border-emerald-400/40 text-emerald-300 hover:border-emerald-300"
                            : count > 0
                              ? "border-amber-400/50 text-amber-200 hover:border-amber-300"
                              : "border-neutral-800 text-neutral-400 hover:border-neutral-500"
                      }`}
                    >
                      {p.number}
                      {count > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-neutral-800 px-2 text-[11px] text-neutral-500">
              <span>Reading order. Drag to reorder.</span>
              <span className="flex-1" />
              <button
                type="button"
                aria-pressed={onlyFlagged}
                onClick={() => setOnlyFlagged((v) => !v)}
                className={`rounded-sm px-1.5 leading-5 ${
                  onlyFlagged
                    ? "bg-amber-400 text-neutral-950"
                    : "text-neutral-400 hover:text-neutral-100"
                }`}
              >
                Needs you only <span className="opacity-60">F</span>
              </button>
            </div>
            <Tree
              doc={doc}
              pageNumber={pageNumber}
              panels={panels}
              flags={flags}
              numbers={numbers}
              castById={castById}
              sel={sel}
              hover={hover}
              onlyFlagged={onlyFlagged}
              onSelect={select}
              onHover={setHover}
              onMoveBubble={(id, panelId, index) =>
                apply(
                  "reorder bubble",
                  (d) => moveBubbleTo(d, id, panelId, index),
                  { select: { kind: "bubble", id } },
                )
              }
              onMovePanel={(id, index) =>
                apply("reorder panel", (d) => movePanelTo(d, id, index), {
                  select: { kind: "panel", id },
                })
              }
              onDismiss={(id) => dismiss([id])}
              onRestore={(id) =>
                apply("restore bubble", (d) => setDismissed(d, [id], false), {
                  select: { kind: "bubble", id },
                })
              }
              onZoomPanel={(id) => {
                const p = doc.panels[id];
                if (p) canvasRef.current?.zoomTo(p.rect);
              }}
            />
          </aside>
        )}

        <main className="relative min-w-0 flex-1">
          <Canvas
            ref={canvasRef}
            page={page}
            panels={panels}
            bubbles={bubbles}
            numbers={numbers}
            flags={flags}
            castById={castById}
            faces={faces}
            sel={sel}
            hover={hover}
            tool={tool}
            onSelect={select}
            onHover={setHover}
            onCommitRect={(target, rect) => setRect(target, rect)}
            onDraw={drawBubble}
            onPickFace={(characterId) => {
              if (selBubble) actions.setSpeaker(selBubble.id, characterId);
            }}
            onBusy={setBusyId}
            onZoom={setZoom}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setLeftOpen((v) => !v)}
            title={leftOpen ? "Fold the tree (,)" : "Show the tree (,)"}
            aria-label={leftOpen ? "Fold the tree" : "Show the tree"}
            className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-sm border border-neutral-700 bg-neutral-950/90 text-neutral-400 hover:text-white"
          >
            <Chevron dir={leftOpen ? "left" : "right"} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? "Fold the fields (.)" : "Show the fields (.)"}
            aria-label={rightOpen ? "Fold the fields" : "Show the fields"}
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-sm border border-neutral-700 bg-neutral-950/90 text-neutral-400 hover:text-white"
          >
            <Chevron dir={rightOpen ? "right" : "left"} />
          </button>
          {tool === "draw" && (
            <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-sm border border-neutral-700 bg-neutral-950/90 px-2 py-1 text-neutral-200">
              Drag a box around the balloon. It sorts itself into its panel. Esc
              cancels.
            </div>
          )}
          {note && (
            <div
              role="status"
              className={`pointer-events-none absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-sm border px-3 py-1.5 text-center ${
                note.tone === "warn"
                  ? "border-amber-400/60 bg-neutral-950 text-amber-200"
                  : "border-neutral-600 bg-neutral-950 text-neutral-100"
              }`}
            >
              {note.text}
            </div>
          )}
        </main>

        {rightOpen && (
          <aside className="w-[328px] shrink-0 overflow-y-auto border-l border-neutral-800">
            <Inspector
              data={data}
              doc={doc}
              page={page}
              sel={sel}
              panels={panels}
              flags={flags}
              allFlags={allFlags}
              numbers={numbers}
              cast={cast}
              castById={castById}
              pagesByNumber={pagesByNumber}
              analysis={analysis}
              picker={picker}
              emotions={emotions}
              textRef={textRef}
              emotionRef={emotionRef}
              actions={actions}
            />
          </aside>
        )}
      </div>

      {/* The left pad keeps the hints clear of the Next.js dev badge. */}
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-800 pr-3 pl-16 text-[11px] text-neutral-500">
        <div className="flex items-center gap-2.5">
          {hints.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1">
              <Key>{k}</Key>
              {label}
            </span>
          ))}
        </div>
        <span className="flex-1" />
        <span>
          Prototype. Edits stay in this browser tab; nothing is written.
        </span>
        {edited && (
          <button
            type="button"
            onClick={discard}
            className="text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
          >
            Discard edits
          </button>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Zoom out"
            onClick={() => canvasRef.current?.zoomBy(0.8)}
            className="size-5 rounded-sm text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            -
          </button>
          <span className="w-9 text-center text-neutral-300 tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Zoom in"
            onClick={() => canvasRef.current?.zoomBy(1.25)}
            className="size-5 rounded-sm text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            +
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => canvasRef.current?.fit()}
            className="rounded-sm px-1.5 leading-5 text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            Fit
          </button>
        </div>
      </footer>

      {sheet && (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80"
          onClick={() => setSheet(false)}
        >
          <div
            className="max-h-[86vh] w-[860px] max-w-[94vw] overflow-y-auto rounded border border-neutral-700 bg-neutral-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center">
              <h2 className="text-[13px] font-medium text-neutral-100">Keys</h2>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setSheet(false)}
                className={BAR_BUTTON}
              >
                Close <span className="text-neutral-500">Esc</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-3">
              {SHEET.map((group) => (
                <section key={group.title}>
                  <h3 className="mb-1.5 text-[11px] tracking-wide text-neutral-500 uppercase">
                    {group.title}
                  </h3>
                  <dl className="space-y-1">
                    {group.rows.map(([k, label]) => (
                      <div key={k} className="flex items-baseline gap-2">
                        <dt className="w-[92px] shrink-0 text-neutral-100">
                          {k}
                        </dt>
                        <dd className="text-neutral-400">{label}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
