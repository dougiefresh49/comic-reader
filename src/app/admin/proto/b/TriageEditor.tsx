// THROWAWAY spike for issue #325 (review editor variant B). State, history, keyboard and the top bar.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeState } from "./Fields";
import {
  buildCast,
  computeSignals,
  needsSpeaker,
  normName,
  panelOf,
  panelsOnPage,
  placeInOrder,
  playOrder,
  shortlist,
  slugify,
  groupPage,
  type CastIndex,
} from "./logic";
import { PageView } from "./PageView";
import { QueueView } from "./QueueView";
import {
  BUBBLE_TYPES,
  type Box,
  type Decision,
  type EditState,
  type Offer,
  type ProtoBubble,
  type ProtoData,
  type Signal,
  type SignalKey,
} from "./types";

type Mode = "queue" | "page";
export type Selection = { kind: "bubble" | "panel"; id: string } | null;

interface HistEntry {
  label: string;
  key?: string;
  doc: EditState;
}
interface Hist {
  doc: EditState;
  past: HistEntry[];
}

export interface Blocked {
  scope: "issue" | number;
  count: number;
  firstId: string;
}

const ALL_SIGNALS: SignalKey[] = [
  "no-speaker",
  "off-list",
  "duplicate",
  "merged",
  "no-panel",
  "new",
  "not-in-panel",
  "low-confidence",
];

const LINES = [
  "WAIT... DID YOU HEAR THAT?",
  "WE'VE GOT COMPANY!",
  "NOT ON MY WATCH.",
  "THAT WAS TOO CLOSE.",
  "COWABUNGA!",
];
const OFFER_EMOTIONS = ["alarmed", "determined", "excited", "wary", "relieved"];

function initState(data: ProtoData): EditState {
  return {
    bubbles: Object.fromEntries(data.bubbles.map((b) => [b.id, b])),
    panels: Object.fromEntries(data.panels.map((p) => [p.id, p])),
    order: data.order,
    decided: {},
    bulkAccepted: {},
    approvedPages: [],
    issueApproved: false,
    addedCast: [],
  };
}

export interface Api {
  data: ProtoData;
  doc: EditState;
  cast: CastIndex;
  signals: Map<string, Signal[]>;
  initialSignals: Map<string, Signal[]>;
  filters: Record<SignalKey, boolean>;
  toggleFilter: (k: SignalKey) => void;
  queueIds: string[];
  looksRight: Record<number, string[]>;
  cursor: string | null;
  setCursor: (id: string | null) => void;
  page: number;
  setPage: (n: number) => void;
  sel: Selection;
  select: (s: Selection) => void;
  zoom: "panel" | "close";
  setZoom: (z: "panel" | "close") => void;
  drawMode: boolean;
  setDrawMode: (v: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  analyze: Record<string, AnalyzeState>;
  warning: string | null;
  blocked: Blocked | null;
  keysFor: (id: string) => SignalKey[];
  patch: (
    id: string,
    patch: Partial<ProtoBubble>,
    label: string,
    key?: string,
  ) => void;
  setSpeaker: (id: string, speaker: string) => void;
  addCharacter: (id: string, name: string) => void;
  movePanel: (id: string, panelId: string) => void;
  accept: (id: string, advance: boolean) => void;
  silent: (id: string, advance: boolean) => void;
  ignore: (id: string, advance: boolean) => void;
  dismissDuplicate: (id: string, advance: boolean) => void;
  keepDismissTwins: (id: string) => void;
  reopen: (id: string) => void;
  acceptLooksRight: (page: number) => void;
  reorder: (id: string, dir: -1 | 1) => void;
  reorderPanel: (id: string, dir: -1 | 1) => void;
  liveBox: (kind: "bubble" | "panel", id: string, box: Box) => void;
  finishDrag: (
    label: string,
    snapshot: EditState,
    kind: "bubble" | "panel",
    id: string,
  ) => void;
  snapshot: () => EditState;
  addBubble: (page: number, box: Box) => void;
  takeOffer: (id: string) => void;
  retryOffer: (id: string) => void;
  approvePage: (page: number) => void;
  goPage: (id?: string) => void;
  goQueue: () => void;
  jumpTo: (id: string) => void;
  shortlistFor: (id: string) => ReturnType<typeof shortlist>;
}

export function TriageEditor({ data }: { data: ProtoData }) {
  const [h, setH] = useState<Hist>(() => ({
    doc: initState(data),
    past: [],
  }));
  const doc = h.doc;
  const cast = useMemo(
    () => buildCast(data.cast, doc.addedCast),
    [data.cast, doc.addedCast],
  );
  const signals = useMemo(() => computeSignals(doc, cast), [doc, cast]);
  const [initialSignals] = useState(() =>
    computeSignals(initState(data), buildCast(data.cast, [])),
  );

  const [mode, setMode] = useState<Mode>("queue");
  const [filters, setFilters] = useState<Record<SignalKey, boolean>>(
    () =>
      Object.fromEntries(ALL_SIGNALS.map((k) => [k, true])) as Record<
        SignalKey,
        boolean
      >,
  );
  const [cursor, setCursorRaw] = useState<string | null>(null);
  const [page, setPageRaw] = useState(1);
  const [selByPage, setSelByPage] = useState<Record<number, Selection>>({});
  const [zoom, setZoom] = useState<"panel" | "close">("panel");
  const [drawMode, setDrawMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [analyze, setAnalyze] = useState<Record<string, AnalyzeState>>({});
  const newCounter = useRef(0);

  const docRef = useRef(doc);
  const castRef = useRef(cast);
  useEffect(() => {
    docRef.current = doc;
    castRef.current = cast;
  }, [doc, cast]);

  const pageCount = data.pages.length;
  const sel = selByPage[page] ?? null;

  // ---- history ----
  const commit = useCallback(
    (label: string, fn: (d: EditState) => EditState, key?: string) => {
      setH((prev) => {
        const next = fn(prev.doc);
        if (next === prev.doc) return prev;
        const last = prev.past[prev.past.length - 1];
        const past =
          key && last?.key === key
            ? prev.past
            : [...prev.past.slice(-39), { label, key, doc: prev.doc }];
        return { doc: next, past };
      });
      setWarning(null);
    },
    [],
  );
  const undo = useCallback(() => {
    setH((prev) => {
      const last = prev.past[prev.past.length - 1];
      if (!last) return prev;
      setToast(`Undid: ${last.label}`);
      return { doc: last.doc, past: prev.past.slice(0, -1) };
    });
  }, []);

  // ---- queue ----
  const keysFor = useCallback(
    (id: string): SignalKey[] => {
      const ks = new Set<SignalKey>();
      for (const s of initialSignals.get(id) ?? []) ks.add(s.key);
      for (const s of signals.get(id) ?? []) ks.add(s.key);
      return [...ks];
    },
    [initialSignals, signals],
  );
  const inQueue = useCallback(
    (id: string) => keysFor(id).some((k) => filters[k]),
    [keysFor, filters],
  );
  const { queueIds, looksRight } = useMemo(() => {
    const q: string[] = [];
    const lr: Record<number, string[]> = {};
    for (const p of data.pages) {
      for (const b of playOrder(doc, p.number)) {
        if (inQueue(b.id)) q.push(b.id);
        else if (!b.ignored) (lr[p.number] ??= []).push(b.id);
      }
    }
    return { queueIds: q, looksRight: lr };
  }, [data.pages, doc, inQueue]);

  const setCursor = useCallback((id: string | null) => {
    setCursorRaw(id);
    setPickerOpen(false);
    setWarning(null);
  }, []);

  // First item on load.
  useEffect(() => {
    if (cursor === null && queueIds[0]) setCursorRaw(queueIds[0]);
  }, [cursor, queueIds]);

  const nextUndecided = useCallback(
    (from: string, alsoDone: string[] = []) => {
      const d = docRef.current.decided;
      const open = (x: string) => !d[x] && !alsoDone.includes(x);
      const i = queueIds.indexOf(from);
      const after = [...queueIds.slice(i + 1), ...queueIds.slice(0, i + 1)];
      return after.find(open) ?? null;
    },
    [queueIds],
  );
  const advanceFrom = useCallback(
    (id: string, alsoDone: string[] = []) => {
      if (mode !== "queue") return;
      const n = nextUndecided(id, [id, ...alsoDone]);
      if (n) setCursor(n);
      else setToast("Queue clear. Nothing else needs a decision.");
    },
    [mode, nextUndecided, setCursor],
  );

  // ---- edits ----
  const setBubble = (
    d: EditState,
    id: string,
    patch: Partial<ProtoBubble>,
  ): EditState => {
    const b = d.bubbles[id];
    if (!b) return d;
    return { ...d, bubbles: { ...d.bubbles, [id]: { ...b, ...patch } } };
  };
  const setDecision = (
    d: EditState,
    id: string,
    dec: Decision | null,
  ): EditState => {
    const decided = { ...d.decided };
    if (dec) decided[id] = dec;
    else delete decided[id];
    return { ...d, decided };
  };

  const patch: Api["patch"] = (id, p, label, key) =>
    commit(label, (d) => setBubble(d, id, p), key);

  const setSpeaker: Api["setSpeaker"] = (id, speaker) =>
    commit(
      `Speaker: ${castRef.current.byId.get(speaker)?.name ?? speaker}`,
      (d) => setBubble(d, id, { speaker, silent: false }),
    );

  const addCharacter: Api["addCharacter"] = (id, name) => {
    const cid = slugify(name) || `character-${Date.now()}`;
    commit(`Add character ${name}`, (d) => {
      const exists = d.addedCast.some((c) => c.id === cid);
      const next = exists
        ? d
        : {
            ...d,
            addedCast: [
              ...d.addedCast,
              { id: cid, name, aliases: [], kind: "added" as const },
            ],
          };
      return setBubble(next, id, { speaker: cid, silent: false });
    });
    setToast(`Added ${name} to the cast (in this browser only).`);
  };

  const movePanel: Api["movePanel"] = (id, panelId) =>
    commit("Move to panel", (d) => {
      const moved = setBubble(d, id, { panelId });
      const b = moved.bubbles[id];
      if (!b) return d;
      return {
        ...moved,
        order: { ...moved.order, [b.page]: placeInOrder(moved, id) },
      };
    });

  const accept: Api["accept"] = (id, advance) => {
    const b = docRef.current.bubbles[id];
    if (!b) return;
    if (needsSpeaker(b)) {
      setWarning("Pick a speaker (1-9 or /), or press S to mark it silent.");
      return;
    }
    commit("Accept", (d) =>
      setDecision(setBubble(d, id, { isNew: false }), id, "accepted"),
    );
    if (advance) advanceFrom(id);
  };
  const silent: Api["silent"] = (id, advance) => {
    const b = docRef.current.bubbles[id];
    if (!b) return;
    if (b.silent) {
      commit("Unmark silent", (d) =>
        setDecision(setBubble(d, id, { silent: false }), id, null),
      );
      return;
    }
    commit("Mark silent", (d) =>
      setDecision(setBubble(d, id, { silent: true }), id, "silent"),
    );
    if (advance) advanceFrom(id);
  };
  const ignore: Api["ignore"] = (id, advance) => {
    const b = docRef.current.bubbles[id];
    if (!b) return;
    if (b.ignored) {
      commit("Unignore", (d) =>
        setDecision(setBubble(d, id, { ignored: false }), id, null),
      );
      return;
    }
    commit("Ignore", (d) =>
      setDecision(setBubble(d, id, { ignored: true }), id, "ignored"),
    );
    if (advance) advanceFrom(id);
  };
  const dismissDuplicate: Api["dismissDuplicate"] = (id, advance) => {
    commit("Dismiss duplicate", (d) =>
      setDecision(setBubble(d, id, { ignored: true }), id, "duplicate"),
    );
    if (advance) advanceFrom(id);
  };
  const keepDismissTwins: Api["keepDismissTwins"] = (id) => {
    const twins =
      signals.get(id)?.find((s) => s.key === "duplicate")?.related ?? [];
    if (!twins.length) {
      setWarning("This bubble has no duplicate to dismiss.");
      return;
    }
    const b = docRef.current.bubbles[id];
    const canAccept = !!b && !needsSpeaker(b);
    commit(`Keep one, dismiss ${twins.length}`, (d) => {
      let next = d;
      for (const t of twins)
        next = setDecision(
          setBubble(next, t, { ignored: true }),
          t,
          "duplicate",
        );
      return canAccept ? setDecision(next, id, "accepted") : next;
    });
    if (canAccept) advanceFrom(id, twins);
    else
      setWarning(
        `Dismissed ${twins.length}. This one still needs a speaker or S for silent.`,
      );
  };
  const reopen: Api["reopen"] = (id) => {
    const dec = docRef.current.decided[id];
    commit("Reopen", (d) => {
      const next = setDecision(d, id, null);
      if (dec === "ignored" || dec === "duplicate")
        return setBubble(next, id, { ignored: false });
      if (dec === "silent") return setBubble(next, id, { silent: false });
      return next;
    });
  };
  const acceptLooksRight: Api["acceptLooksRight"] = (p) => {
    const ids = (looksRight[p] ?? []).filter((x) => !doc.decided[x]);
    if (!ids.length) return;
    commit(`Accept ${ids.length} on page ${p}`, (d) => {
      const decided = { ...d.decided };
      for (const x of ids) decided[x] = "accepted";
      return { ...d, decided };
    });
    setToast(`Accepted ${ids.length} looks-right bubbles on page ${p}.`);
  };

  const reorder: Api["reorder"] = (id, dir) => {
    const b = doc.bubbles[id];
    if (!b) return;
    const group = groupPage(doc, b.page).find((g) =>
      g.bubbles.some((x) => x.id === id),
    );
    const ids = group?.bubbles.map((x) => x.id) ?? [];
    const i = ids.indexOf(id);
    const other = ids[i + dir];
    if (!other) {
      setWarning(
        dir < 0
          ? "First in its panel. Alt+Left moves it to the previous panel."
          : "Last in its panel. Alt+Right moves it to the next panel.",
      );
      return;
    }
    commit(dir < 0 ? "Move up" : "Move down", (d) => {
      const order = [...(d.order[b.page] ?? [])];
      const a = order.indexOf(id);
      const c = order.indexOf(other);
      order[a] = other;
      order[c] = id;
      return { ...d, order: { ...d.order, [b.page]: order } };
    });
  };
  const reorderPanel: Api["reorderPanel"] = (id, dir) => {
    const p = doc.panels[id];
    if (!p) return;
    const list = panelsOnPage(doc.panels, p.page);
    const i = list.findIndex((x) => x.id === id);
    const other = list[i + dir];
    if (!other) return;
    commit(dir < 0 ? "Panel earlier" : "Panel later", (d) => ({
      ...d,
      panels: {
        ...d.panels,
        [p.id]: { ...p, order: other.order },
        [other.id]: { ...other, order: p.order },
      },
    }));
  };

  const liveBox: Api["liveBox"] = (kind, id, box) =>
    setH((prev) => {
      const d = prev.doc;
      if (kind === "bubble") {
        const b = d.bubbles[id];
        if (!b) return prev;
        return {
          ...prev,
          doc: { ...d, bubbles: { ...d.bubbles, [id]: { ...b, box } } },
        };
      }
      const p = d.panels[id];
      if (!p) return prev;
      return {
        ...prev,
        doc: { ...d, panels: { ...d.panels, [id]: { ...p, box } } },
      };
    });

  const finishDrag: Api["finishDrag"] = (label, snapshot, kind, id) => {
    setH((prev) => {
      let d = prev.doc;
      if (kind === "bubble") {
        const b = d.bubbles[id];
        const before = snapshot.bubbles[id];
        if (b && before) {
          const pa = panelOf(before, snapshot.panels)?.id;
          const pb = panelOf(b, d.panels)?.id;
          if (pa !== pb)
            d = { ...d, order: { ...d.order, [b.page]: placeInOrder(d, id) } };
        }
      }
      return {
        doc: d,
        past: [...prev.past.slice(-39), { label, doc: snapshot }],
      };
    });
    if (kind === "bubble")
      setAnalyze((a) => {
        const cur = a[id];
        if (!cur || cur.status === "taken") return a;
        return { ...a, [id]: { ...cur, status: "waiting" } };
      });
  };

  const addBubble: Api["addBubble"] = (p, box) => {
    newCounter.current += 1;
    const id = `new-${newCounter.current}`;
    commit("Add bubble", (d) => {
      const b: ProtoBubble = {
        id,
        page: p,
        text: "",
        type: "SPEECH",
        speaker: null,
        emotion: "",
        ignored: false,
        silent: false,
        box,
        confidence: null,
        panelId: null,
        isNew: true,
      };
      const next = {
        ...d,
        bubbles: { ...d.bubbles, [id]: b },
        order: { ...d.order, [p]: [...(d.order[p] ?? []), id] },
      };
      return { ...next, order: { ...next.order, [p]: placeInOrder(next, id) } };
    });
    setAnalyze((a) => ({ ...a, [id]: { status: "waiting", attempt: 0 } }));
    setSelByPage((s) => ({ ...s, [p]: { kind: "bubble", id } }));
    setDrawMode(false);
  };

  const makeOffer = useCallback((id: string, attempt: number): Offer => {
    const d = docRef.current;
    const b = d.bubbles[id];
    const list = b ? shortlist(b, d, castRef.current) : [];
    const pick = list.filter((c) => c.kind === "cast");
    const who = pick[attempt % Math.max(pick.length, 1)] ?? list[0];
    return {
      text: LINES[(attempt + (b?.page ?? 0)) % LINES.length]!,
      speaker: who?.id ?? "narrator",
      emotion: OFFER_EMOTIONS[attempt % OFFER_EMOTIONS.length]!,
    };
  }, []);

  // Simulated analyze: a new box that has been still for a second gets values.
  const waitingKey = Object.entries(analyze)
    .filter(([, a]) => a.status === "waiting")
    .map(([id]) => `${id}:${JSON.stringify(doc.bubbles[id]?.box ?? null)}`)
    .join("|");
  useEffect(() => {
    if (!waitingKey) return;
    const ids = waitingKey.split("|").map((s) => s.split(":")[0]!);
    // The second timer is not cleared on cleanup: once running, the status
    // change empties waitingKey, and the offer must still arrive.
    const t1 = setTimeout(() => {
      setAnalyze((a) => {
        const next = { ...a };
        for (const id of ids)
          if (next[id]?.status === "waiting")
            next[id] = { ...next[id], status: "running" };
        return next;
      });
      setTimeout(() => {
        setAnalyze((a) => {
          const next = { ...a };
          for (const id of ids) {
            const cur = next[id];
            if (cur?.status === "running")
              next[id] = {
                ...cur,
                status: "offered",
                offer: makeOffer(id, cur.attempt),
              };
          }
          return next;
        });
      }, 900);
    }, 1000);
    return () => clearTimeout(t1);
  }, [waitingKey, makeOffer]);

  const takeOffer: Api["takeOffer"] = (id) => {
    const a = analyze[id];
    if (a?.status !== "offered" || !a.offer) return;
    const o = a.offer;
    commit("Accept analyze", (d) =>
      setBubble(d, id, {
        text: o.text,
        speaker: o.speaker,
        emotion: o.emotion,
      }),
    );
    setAnalyze((x) => ({ ...x, [id]: { ...a, status: "taken" } }));
  };
  const retryOffer: Api["retryOffer"] = (id) => {
    const a = analyze[id];
    if (!a) return;
    setAnalyze((x) => ({
      ...x,
      [id]: { status: "running", attempt: a.attempt + 1 },
    }));
    setTimeout(() => {
      setAnalyze((x) => {
        const cur = x[id];
        if (cur?.status !== "running") return x;
        return {
          ...x,
          [id]: {
            ...cur,
            status: "offered",
            offer: makeOffer(id, cur.attempt),
          },
        };
      });
    }, 900);
  };

  // ---- approval ----
  const blockersOn = (p: number | "issue") =>
    (p === "issue"
      ? data.pages.flatMap((pg) => playOrder(doc, pg.number))
      : playOrder(doc, p)
    ).filter(needsSpeaker);

  const approvePage: Api["approvePage"] = (p) => {
    const bl = blockersOn(p);
    if (bl.length) {
      setBlocked({ scope: p, count: bl.length, firstId: bl[0]!.id });
      return;
    }
    setBlocked(null);
    commit(`Approve page ${p}`, (d) => ({
      ...d,
      approvedPages: d.approvedPages.includes(p)
        ? d.approvedPages
        : [...d.approvedPages, p],
    }));
    setToast(`Page ${p} approved (in this browser only).`);
  };
  const approveIssue = () => {
    const bl = blockersOn("issue");
    if (bl.length) {
      setBlocked({ scope: "issue", count: bl.length, firstId: bl[0]!.id });
      return;
    }
    setBlocked(null);
    commit("Approve issue", (d) => ({
      ...d,
      issueApproved: true,
      approvedPages: data.pages.map((p) => p.number),
    }));
    setToast("Issue approved (in this browser only). No audio was made.");
  };

  // ---- navigation ----
  const select = useCallback(
    (s: Selection) => {
      setSelByPage((m) => ({ ...m, [page]: s }));
      setPickerOpen(false);
      setWarning(null);
    },
    [page],
  );
  const setPage = useCallback(
    (n: number) => {
      setPageRaw(Math.max(1, Math.min(pageCount, n)));
      setPickerOpen(false);
      setDrawMode(false);
    },
    [pageCount],
  );
  const goPage = (id?: string) => {
    const target = id ?? cursor;
    const b = target ? doc.bubbles[target] : undefined;
    if (b) {
      setPageRaw(b.page);
      setSelByPage((m) => ({ ...m, [b.page]: { kind: "bubble", id: b.id } }));
    }
    setMode("page");
    setPickerOpen(false);
  };
  const goQueue = () => {
    if (sel?.kind === "bubble" && queueIds.includes(sel.id)) setCursor(sel.id);
    setMode("queue");
    setDrawMode(false);
    setPickerOpen(false);
  };
  const jumpTo = (id: string) => {
    if (!inQueue(id)) {
      setFilters((f) => ({ ...f, "no-speaker": true }));
    }
    setCursor(id);
    setMode("queue");
    setBlocked(null);
  };

  const shortlistFor = (id: string) => {
    const b = doc.bubbles[id];
    if (!b) return [];
    const suggest = signals.get(id)?.find((s) => s.suggest)?.suggest;
    return shortlist(b, doc, cast, suggest);
  };

  const save = () =>
    setToast(
      "Nothing was written: this is a prototype. Your page, selection and edits stay as they are.",
    );

  // URL keeps the place (mode, page, item) so a refresh reopens it.
  useEffect(() => {
    const u = new URL(window.location.href);
    const m = u.searchParams.get("mode");
    const p = parseInt(u.searchParams.get("page") ?? "", 10);
    const item = u.searchParams.get("item");
    if (m === "page") setMode("page");
    if (Number.isFinite(p)) setPageRaw(p);
    if (item && docRef.current.bubbles[item]) {
      setCursorRaw(item);
      const b = docRef.current.bubbles[item];
      if (b && m === "page")
        setSelByPage((s) => ({ ...s, [b.page]: { kind: "bubble", id: item } }));
    }
  }, []);
  useEffect(() => {
    const item =
      mode === "queue" ? cursor : sel?.kind === "bubble" ? sel.id : null;
    const q = new URLSearchParams({
      book: data.bookId,
      issue: data.issueId,
      mode,
      page: String(page),
      ...(item ? { item } : {}),
    });
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${q.toString()}`,
    );
  }, [data.bookId, data.issueId, mode, page, cursor, sel]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const api: Api = {
    data,
    doc,
    cast,
    signals,
    initialSignals,
    filters,
    toggleFilter: (k) => setFilters((f) => ({ ...f, [k]: !f[k] })),
    queueIds,
    looksRight,
    cursor,
    setCursor,
    page,
    setPage,
    sel,
    select,
    zoom,
    setZoom,
    drawMode,
    setDrawMode,
    pickerOpen,
    setPickerOpen,
    analyze,
    warning,
    blocked,
    keysFor,
    patch,
    setSpeaker,
    addCharacter,
    movePanel,
    accept,
    silent,
    ignore,
    dismissDuplicate,
    keepDismissTwins,
    reopen,
    acceptLooksRight,
    reorder,
    reorderPanel,
    liveBox,
    finishDrag,
    snapshot: () => docRef.current,
    addBubble,
    takeOffer,
    retryOffer,
    approvePage,
    goPage,
    goQueue,
    jumpTo,
    shortlistFor,
  };
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = apiRef.current;
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (typing) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (mod) return;

      const target =
        mode === "queue"
          ? a.cursor
          : a.sel?.kind === "bubble"
            ? a.sel.id
            : null;
      const b = target ? a.doc.bubbles[target] : undefined;
      const k = e.key;

      if (k === "?") {
        setShowHelp((v) => !v);
        return;
      }
      if (k === "Escape") {
        if (showHelp) setShowHelp(false);
        else if (a.pickerOpen) a.setPickerOpen(false);
        else if (a.drawMode) a.setDrawMode(false);
        else if (mode === "page") a.select(null);
        return;
      }
      if (k === "u" || k === "U") return undo();
      if (k === "q" || k === "Q") return a.goQueue();
      if (k === "p" || k === "P") return a.goPage();
      if (k === "A" && e.shiftKey) return approveIssue();

      // Page movement. In the queue it jumps to the first item of that page.
      if (k === "[" || k === "PageUp" || k === "]" || k === "PageDown") {
        e.preventDefault();
        const dir = k === "[" || k === "PageUp" ? -1 : 1;
        if (mode === "page") return a.setPage(page + dir);
        const curPage = a.cursor ? a.doc.bubbles[a.cursor]?.page : undefined;
        const ids = a.queueIds;
        const hit =
          dir > 0
            ? ids.find((x) => (a.doc.bubbles[x]?.page ?? 0) > (curPage ?? 0))
            : [...ids]
                .reverse()
                .find(
                  (x) => (a.doc.bubbles[x]?.page ?? 0) < (curPage ?? Infinity),
                );
        if (hit) {
          const hp = a.doc.bubbles[hit]!.page;
          a.setCursor(ids.find((x) => a.doc.bubbles[x]?.page === hp) ?? hit);
        }
        return;
      }

      if (mode === "queue") {
        if (k === "ArrowRight" || k === "ArrowLeft") {
          e.preventDefault();
          const ids = a.queueIds;
          const i = a.cursor ? ids.indexOf(a.cursor) : -1;
          const n =
            k === "ArrowRight"
              ? ids[Math.min(i + 1, ids.length - 1)]
              : ids[Math.max(i - 1, 0)];
          if (n) a.setCursor(n);
          return;
        }
        if (k === "f" || k === "F")
          return a.setZoom(a.zoom === "panel" ? "close" : "panel");
        if ((k === "l" || k === "L") && b) return a.acceptLooksRight(b.page);
        if (k === "a" && b) return a.approvePage(b.page);
      } else {
        if (k === "n" || k === "N") return a.setDrawMode(!a.drawMode);
        if (k === "a") return a.approvePage(page);
        if (k === "ArrowUp" || k === "ArrowDown") {
          e.preventDefault();
          const dir = k === "ArrowUp" ? -1 : 1;
          if (e.altKey) {
            if (a.sel?.kind === "bubble") a.reorder(a.sel.id, dir);
            else if (a.sel?.kind === "panel") a.reorderPanel(a.sel.id, dir);
            return;
          }
          const ids = playOrder(a.doc, page).map((x) => x.id);
          const i = a.sel?.kind === "bubble" ? ids.indexOf(a.sel.id) : -1;
          const n =
            i < 0
              ? ids[dir > 0 ? 0 : ids.length - 1]
              : ids[Math.max(0, Math.min(ids.length - 1, i + dir))];
          if (n) a.select({ kind: "bubble", id: n });
          return;
        }
        if ((k === "ArrowLeft" || k === "ArrowRight") && e.altKey && b) {
          e.preventDefault();
          const ps = panelsOnPage(a.doc.panels, b.page);
          const cur = panelOf(b, a.doc.panels);
          const i = cur ? ps.findIndex((x) => x.id === cur.id) : -1;
          const n = ps[i + (k === "ArrowLeft" ? -1 : 1)];
          if (n) a.movePanel(b.id, n.id);
          return;
        }
      }

      if (!b) return;
      if (/^[1-9]$/.test(k)) {
        const list = a.shortlistFor(b.id);
        const c = list[parseInt(k, 10) - 1];
        if (c) a.setSpeaker(b.id, c.id);
        return;
      }
      if (k === "/" || k === "0") {
        e.preventDefault();
        a.setPickerOpen(true);
        return;
      }
      if (k === "Enter") {
        e.preventDefault();
        return a.accept(b.id, mode === "queue");
      }
      if (k === "s" || k === "S") return a.silent(b.id, mode === "queue");
      if (k === "x" || k === "X") return a.ignore(b.id, mode === "queue");
      if (k === "d" || k === "D") {
        if (a.signals.get(b.id)?.some((s) => s.key === "duplicate"))
          a.dismissDuplicate(b.id, mode === "queue");
        else setWarning("Not flagged as a duplicate. X ignores it.");
        return;
      }
      if (k === "k" || k === "K") return a.keepDismissTwins(b.id);
      if (k === "t" || k === "T") {
        const i = BUBBLE_TYPES.indexOf(b.type);
        const next = BUBBLE_TYPES[(i + 1) % BUBBLE_TYPES.length]!;
        return a.patch(b.id, { type: next }, "Change type");
      }
      if (k === "e" || k === "E") {
        e.preventDefault();
        document.getElementById("pb-text")?.focus();
        return;
      }
      if (k === "m" || k === "M") {
        e.preventDefault();
        document.getElementById("pb-emotion")?.focus();
        return;
      }
      if (k === "y" || k === "Y") return a.takeOffer(b.id);
      if (k === "r" || k === "R") {
        if (a.analyze[b.id]) a.retryOffer(b.id);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- progress ----
  const done = queueIds.filter((x) => doc.decided[x]).length;
  const lrAll = Object.values(looksRight).flat();
  const lrDone = lrAll.filter((x) => doc.decided[x]).length;
  const noSpeaker = data.pages
    .flatMap((p) => playOrder(doc, p.number))
    .filter(needsSpeaker).length;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-xs text-neutral-200">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-neutral-100">{data.issueName}</span>
          <span className="text-neutral-500">
            {data.bookId} / {data.issueId}
          </span>
        </div>
        <nav className="flex rounded border border-neutral-800">
          <button
            type="button"
            onClick={goQueue}
            className={`px-2 py-0.5 ${mode === "queue" ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            Queue <kbd className="text-neutral-500">Q</kbd>
          </button>
          <button
            type="button"
            onClick={() => goPage()}
            className={`px-2 py-0.5 ${mode === "page" ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            Page <kbd className="text-neutral-500">P</kbd>
          </button>
        </nav>
        <div className="flex items-center gap-3 text-neutral-400">
          <span>
            Needs you{" "}
            <b className="font-medium text-neutral-100">{queueIds.length}</b>
          </span>
          <span>
            done <b className="font-medium text-emerald-300">{done}</b>
          </span>
          <span>
            left{" "}
            <b className="font-medium text-amber-300">
              {queueIds.length - done}
            </b>
          </span>
          <span className="text-neutral-700">|</span>
          <span>
            Looks right{" "}
            <b className="font-medium text-neutral-100">{lrAll.length}</b>,
            accepted {lrDone}
          </span>
          <span className="text-neutral-700">|</span>
          <span className={noSpeaker ? "text-red-300" : "text-neutral-500"}>
            {noSpeaker} spoken without speaker
          </span>
          <div className="h-1 w-24 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full bg-emerald-600"
              style={{
                width: `${queueIds.length ? (done / queueIds.length) * 100 : 100}%`,
              }}
            />
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={!h.past.length}
            onClick={undo}
            title="U or Cmd+Z"
            className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800 disabled:opacity-40"
          >
            Undo
            {h.past.length ? `: ${h.past[h.past.length - 1]!.label}` : ""}{" "}
            <kbd className="text-neutral-500">U</kbd>
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
          >
            Save <kbd className="text-neutral-500">Cmd+S</kbd>
          </button>
          {doc.issueApproved ? (
            <span className="rounded border border-emerald-800 px-2 py-0.5 text-emerald-300">
              Issue approved
            </span>
          ) : (
            <button
              type="button"
              onClick={approveIssue}
              className="rounded bg-emerald-800 px-2 py-0.5 text-white hover:bg-emerald-700"
            >
              Approve issue <kbd className="text-emerald-300">Shift+A</kbd>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
          >
            Keys <kbd className="text-neutral-500">?</kbd>
          </button>
        </div>
      </header>

      {(toast ?? blocked ?? data.loadNote) && (
        <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-1">
          {data.loadNote && (
            <span className="text-amber-300">{data.loadNote}</span>
          )}
          {blocked && (
            <span className="text-red-300">
              {blocked.scope === "issue"
                ? "Issue approval blocked"
                : `Page ${blocked.scope} approval blocked`}
              : {blocked.count} spoken bubble
              {blocked.count > 1 ? "s have" : " has"} no speaker and{" "}
              {blocked.count > 1 ? "are" : "is"} not marked silent.{" "}
              <button
                type="button"
                onClick={() => jumpTo(blocked.firstId)}
                className="underline hover:text-white"
              >
                Jump to the first
              </button>
            </span>
          )}
          {toast && <span className="text-neutral-300">{toast}</span>}
        </div>
      )}

      {mode === "queue" ? <QueueView api={api} /> : <PageView api={api} />}

      {showHelp && <Help onClose={() => setShowHelp(false)} />}
    </div>
  );
}

const KEYS: [string, string, string][] = [
  ["Both", "Q / P", "Queue / page mode (keeps the selection)"],
  ["Both", "1-9", "Pick speaker from the shortlist"],
  ["Both", "/ or 0", "All characters, or add a new one"],
  ["Both", "Enter", "Accept (queue: and go to the next open item)"],
  ["Both", "S", "Mark silent"],
  ["Both", "X", "Ignore (not read aloud)"],
  ["Both", "D", "Dismiss as duplicate"],
  ["Both", "K", "Keep this one, dismiss its duplicates"],
  ["Both", "T", "Next bubble type"],
  ["Both", "E / M", "Edit text / emotion (Esc leaves the field)"],
  ["Both", "Y / R", "Take / retry the simulated analyze"],
  ["Both", "U or Cmd+Z", "Undo"],
  ["Both", "Cmd+S", "Save (prototype: nothing is written)"],
  ["Both", "Shift+A", "Approve issue"],
  ["Queue", "Left / Right", "Previous / next item"],
  ["Queue", "F", "Zoom: whole panel or close on the balloon"],
  ["Queue", "L", "Accept this page's looks-right bubbles"],
  ["Queue", "a", "Approve this item's page"],
  ["Both", "[ / ]", "Previous / next page (queue: its first item)"],
  ["Page", "Up / Down", "Previous / next bubble"],
  ["Page", "Alt+Up / Down", "Move bubble (or panel) in reading order"],
  ["Page", "Alt+Left / Right", "Move bubble to previous / next panel"],
  ["Page", "N", "Draw a new bubble"],
  ["Page", "a", "Approve this page"],
  ["Both", "Esc", "Close / clear"],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded border border-neutral-700 bg-neutral-900 p-4 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm text-neutral-100">Keys</span>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white"
          >
            Close (Esc)
          </button>
        </div>
        <table className="w-full">
          <tbody>
            {KEYS.map(([where, key, what]) => (
              <tr key={where + key} className="border-t border-neutral-800">
                <td className="py-0.5 pr-2 text-neutral-500">{where}</td>
                <td className="py-0.5 pr-3">
                  <kbd className="rounded border border-neutral-700 px-1 text-neutral-200">
                    {key}
                  </kbd>
                </td>
                <td className="py-0.5 text-neutral-300">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function speakerOf(cast: CastIndex, s: string | null): string {
  if (!s) return "";
  return cast.byNorm.get(normName(s))?.name ?? s;
}
