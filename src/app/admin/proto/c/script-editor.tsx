// THROWAWAY prototype for issue #325. No persistence and no paid analysis.
"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PageCanvas } from "./page-canvas";
import { SpeakerPicker } from "./speaker-picker";
import {
  likelyDuplicate,
  needsAttention,
  needsSpeaker,
  panelFor,
  type Box,
  type ScriptBubble,
  type ScriptPage,
} from "./types";

type Document = {
  pages: ScriptPage[];
  cast: string[];
  approved: number[];
  issueApproved: boolean;
};
type Proposal = {
  state: "waiting" | "running" | "ready" | "accepted";
  text: string;
  speaker: string;
  emotion: string;
  attempt: number;
};
const button =
  "rounded border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-sky-400 disabled:cursor-default disabled:opacity-35";
const field =
  "rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-300 focus:border-sky-400 focus:outline-none";
const generic = ["narrator", "off-panel", "crowd"];

function normalize(pages: ScriptPage[]) {
  return pages.map((p) => ({
    ...p,
    bubbles: p.bubbles.map((b) => ({
      ...b,
      panel: b.panel || panelFor(b.box, p),
    })),
  }));
}
function ordered(p: ScriptPage) {
  return [...p.panels.map((panel) => panel.id), ""].flatMap((id) =>
    p.bubbles.filter((b) => b.panel === id),
  );
}

export function ScriptEditor({
  title,
  book,
  issue,
  initialPages,
  initialCast,
}: {
  title: string;
  book: string;
  issue: string;
  initialPages: ScriptPage[];
  initialCast: string[];
}) {
  const [doc, setDoc] = useState<Document>(() => ({
    pages: normalize(initialPages),
    cast: [...new Set([...initialCast, ...generic])],
    approved: [],
    issueApproved: false,
  }));
  const docRef = useRef(doc);
  docRef.current = doc;
  const [pageIndex, setPageIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [history, setHistory] = useState<Document[]>([]);
  const [note, setNote] = useState(
    "Prototype · edits stay in this tab. No audio or data is written.",
  );
  const [drawing, setDrawing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [help, setHelp] = useState(false);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [analysisTick, setAnalysisTick] = useState(0);
  const coalesce = useRef("");
  const scriptRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const page = doc.pages[pageIndex]!;
  const selected = selections[page.number] ?? "";
  const bubble = page.bubbles.find((b) => b.id === selected);
  const list = ordered(page);
  const attention = list.filter((b) => needsAttention(b, page, doc.cast));
  const blockers = page.bubbles.filter((b) => needsSpeaker(b, doc.cast));
  const issueBlockers = doc.pages.flatMap((p) =>
    p.bubbles.filter((b) => needsSpeaker(b, doc.cast)).map((b) => ({ p, b })),
  );

  function record() {
    setHistory((h) => [...h.slice(-39), docRef.current]);
    coalesce.current = "";
  }
  function change(fn: (d: Document) => Document, key = "", recorded = false) {
    if (!recorded && (!key || coalesce.current !== key)) record();
    coalesce.current = key;
    setDoc((d) => {
      const next = fn(d);
      docRef.current = next;
      return next;
    });
  }
  function edit(
    id: string,
    patch: Partial<ScriptBubble>,
    key = "",
    recorded = false,
  ) {
    change(
      (d) => ({
        ...d,
        issueApproved: false,
        approved: d.approved.filter((n) => n !== page.number),
        pages: d.pages.map((p) =>
          p.number === page.number
            ? {
                ...p,
                bubbles: p.bubbles.map((b) =>
                  b.id === id ? { ...b, ...patch } : b,
                ),
              }
            : p,
        ),
      }),
      key,
      recorded,
    );
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setDoc(previous);
    docRef.current = previous;
    setHistory((h) => h.slice(0, -1));
    coalesce.current = "";
    setNote("Undid the last edit. Selection and page kept.");
  }
  function select(id: string, focus = false) {
    setSelections((s) => ({ ...s, [page.number]: id }));
    coalesce.current = "";
    requestAnimationFrame(() => {
      const entry = scriptRef.current?.querySelector<HTMLElement>(
        `[data-entry="${id}"]`,
      );
      entry?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      artRef.current
        ?.querySelector<HTMLElement>(`[data-box="${id}"]`)
        ?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "nearest",
        });
      if (focus)
        entry
          ?.querySelector<HTMLTextAreaElement>("textarea")
          ?.focus({ preventScroll: true });
    });
  }
  function navigate(index: number) {
    if (index < 0 || index >= doc.pages.length) return;
    setPageIndex(index);
    setDrawing(false);
    coalesce.current = "";
    const next = doc.pages[index]!;
    if (!selections[next.number])
      setSelections((s) => ({
        ...s,
        [next.number]: ordered(next).find((b) => !b.ignored)?.id ?? "",
      }));
    requestAnimationFrame(() => {
      const remembered = selections[next.number];
      if (remembered) {
        scriptRef.current
          ?.querySelector<HTMLElement>(`[data-entry="${remembered}"]`)
          ?.scrollIntoView({ block: "nearest" });
        artRef.current
          ?.querySelector<HTMLElement>(`[data-box="${remembered}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else {
        scriptRef.current?.scrollTo(0, 0);
        artRef.current?.scrollTo(0, 0);
      }
    });
  }
  function advance(delta: number) {
    const visible = list.filter((b) => !b.ignored);
    const index = visible.findIndex((b) => b.id === selected);
    const next = visible[(index + delta + visible.length) % visible.length];
    if (next) select(next.id, true);
  }
  function nextFlag() {
    const index = list.findIndex((b) => b.id === selected);
    const next = [...list.slice(index + 1), ...list.slice(0, index + 1)].find(
      (b) => needsAttention(b, page, doc.cast),
    );
    if (next) select(next.id, true);
    else setNote("No flagged lines on this page.");
  }
  function reorder(id: string, delta: number) {
    const current = page.bubbles.find((b) => b.id === id);
    if (!current) return;
    const peers = page.bubbles.filter((b) => b.panel === current.panel);
    const index = peers.findIndex((b) => b.id === id);
    const destination = index + delta;
    if (destination < 0 || destination >= peers.length) {
      setNote(
        "At the edge of this panel. Use the panel field to move this line.",
      );
      return;
    }
    [peers[index], peers[destination]] = [peers[destination]!, peers[index]!];
    const grouped = [...page.panels.map((p) => p.id), ""].flatMap((panelId) =>
      panelId === current.panel
        ? peers
        : page.bubbles.filter((b) => b.panel === panelId),
    );
    change((d) => ({
      ...d,
      issueApproved: false,
      approved: d.approved.filter((n) => n !== page.number),
      pages: d.pages.map((p) =>
        p.number === page.number ? { ...p, bubbles: grouped } : p,
      ),
    }));
    setNote("Reading order changed. Box kept in place.");
  }
  function movePanel(id: string, panelId: string) {
    const changed = page.bubbles.map((b) =>
      b.id === id ? { ...b, panel: panelId } : b,
    );
    const peers = changed
      .filter((b) => b.panel === panelId)
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const grouped = [...page.panels.map((p) => p.id), ""].flatMap((p) =>
      p === panelId ? peers : changed.filter((b) => b.panel === p),
    );
    change((d) => ({
      ...d,
      issueApproved: false,
      approved: d.approved.filter((n) => n !== page.number),
      pages: d.pages.map((p) =>
        p.number === page.number ? { ...p, bubbles: grouped } : p,
      ),
    }));
    requestAnimationFrame(() => select(id, true));
  }
  function editBox(id: string, box: Box, isPanel: boolean) {
    if (!isPanel) {
      edit(id, { box }, "", true);
      return;
    }
    change(
      (d) => ({
        ...d,
        issueApproved: false,
        approved: d.approved.filter((n) => n !== page.number),
        pages: d.pages.map((p) =>
          p.number === page.number
            ? {
                ...p,
                panels: p.panels.map((panel) =>
                  panel.id === id ? { ...panel, box } : panel,
                ),
              }
            : p,
        ),
      }),
      "",
      true,
    );
  }
  function add(box: Box) {
    const id = `local-${Date.now()}`;
    const b: ScriptBubble = {
      id,
      box,
      panel: panelFor(box, page),
      text: "",
      speaker: "",
      emotion: "",
      type: "speech",
      silent: false,
      ignored: false,
      duplicateDismissed: false,
      fresh: true,
    };
    const peers = [...page.bubbles.filter((x) => x.panel === b.panel), b].sort(
      (a, b) => a.box.y - b.box.y || a.box.x - b.box.x,
    );
    const bubbles = [...page.panels.map((p) => p.id), ""].flatMap((panelId) =>
      panelId === b.panel
        ? peers
        : page.bubbles.filter((b) => b.panel === panelId),
    );
    change((d) => ({
      ...d,
      issueApproved: false,
      approved: d.approved.filter((n) => n !== page.number),
      pages: d.pages.map((p) =>
        p.number === page.number ? { ...p, bubbles } : p,
      ),
    }));
    setProposals((p) => ({
      ...p,
      [id]: {
        state: "waiting",
        text: "",
        speaker: "",
        emotion: "",
        attempt: 0,
      },
    }));
    setDrawing(false);
    select(id, true);
    setNote(
      "Bubble inserted by overlap and position. Waiting for the box to settle.",
    );
  }
  const freshGeometry = JSON.stringify(
    doc.pages.flatMap((p) =>
      p.bubbles.filter((b) => b.fresh).map((b) => [b.id, b.box]),
    ),
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setProposals((current) => {
        const next = { ...current };
        for (const p of docRef.current.pages)
          for (const b of p.bubbles) {
            const proposal = current[b.id];
            if (!b.fresh || !proposal || proposal.state === "accepted")
              continue;
            next[b.id] = {
              state: "running",
              text: "",
              speaker: "",
              emotion: "",
              attempt: proposal.attempt + 1,
            };
          }
        return next;
      });
      setAnalysisTick((t) => t + 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [freshGeometry]);
  useEffect(() => {
    if (!analysisTick) return;
    const timer = setTimeout(() => {
      setProposals((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, p]) => {
            if (p.state !== "running") return [id, p];
            const source = docRef.current.pages.find((page) =>
              page.bubbles.some((b) => b.id === id),
            );
            const b = source?.bubbles.find((b) => b.id === id);
            const neighbor = source?.bubbles.find(
              (other) =>
                other.id !== id &&
                other.panel === b?.panel &&
                docRef.current.cast.includes(other.speaker),
            );
            return [
              id,
              {
                ...p,
                state: "ready",
                text:
                  p.attempt % 2
                    ? "Wait! We need to stay together."
                    : "Come on. Let's get out of here!",
                speaker:
                  neighbor?.speaker ??
                  docRef.current.cast.find((c) => !generic.includes(c)) ??
                  "off-panel",
                emotion: p.attempt % 2 ? "concerned" : "urgent",
              },
            ];
          }),
        ),
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [analysisTick]);
  function retry(id: string) {
    setProposals((p) => ({
      ...p,
      [id]: { ...p[id]!, state: "running", attempt: (p[id]?.attempt ?? 0) + 1 },
    }));
    setAnalysisTick((t) => t + 1);
  }
  function accept(id: string) {
    const p = proposals[id];
    if (p?.state !== "ready") return;
    edit(id, { text: p.text, speaker: p.speaker, emotion: p.emotion });
    setProposals((current) => ({
      ...current,
      [id]: { ...p, state: "accepted" },
    }));
    setNote("Simulated text, speaker and emotion accepted. Nothing written.");
  }
  function approve(all: boolean) {
    const blocked = all ? issueBlockers : blockers.map((b) => ({ p: page, b }));
    if (blocked.length) {
      const first = blocked[0]!;
      const index = doc.pages.findIndex((p) => p.number === first.p.number);
      navigate(index);
      setSelections((s) => ({ ...s, [first.p.number]: first.b.id }));
      requestAnimationFrame(() => {
        const entry = scriptRef.current?.querySelector<HTMLElement>(
          `[data-entry="${first.b.id}"]`,
        );
        entry?.scrollIntoView({ block: "center" });
        entry?.querySelector<HTMLInputElement>("[role=combobox]")?.focus();
      });
      setNote(
        `Approval blocked: ${blocked.length} spoken ${blocked.length === 1 ? "bubble needs" : "bubbles need"} a speaker. Assign one or mark silent. Jumped to the first.`,
      );
      return;
    }
    change((d) => ({
      ...d,
      approved: all
        ? d.pages.map((p) => p.number)
        : [...new Set([...d.approved, page.number])],
      issueApproved: all || d.issueApproved,
    }));
    setNote(
      all
        ? "Issue approved in this tab. Prototype only; no pipeline resumed."
        : `Page ${page.number} approved in this tab. Nothing written.`,
    );
  }
  function keyboard(e: KeyboardEvent) {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(
      (e.target as HTMLElement).tagName,
    );
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key.toLowerCase() === "s") {
      e.preventDefault();
      setNote(
        "Saved locally for this tab. Prototype: nothing was written. Your page, selection and values are kept.",
      );
      return;
    }
    if (cmd && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.altKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight")
        navigate(pageIndex + (e.key === "ArrowRight" ? 1 : -1));
      else if (e.shiftKey && bubble) {
        const index = page.panels.findIndex((p) => p.id === bubble.panel);
        const destination =
          page.panels[index + (e.key === "ArrowDown" ? 1 : -1)];
        if (destination) movePanel(bubble.id, destination.id);
      } else if (bubble) reorder(bubble.id, e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (cmd && e.key.toLowerCase() === "j") {
      e.preventDefault();
      nextFlag();
      return;
    }
    if (typing) return;
    if (drawing && e.key === "Enter") {
      e.preventDefault();
      const anchor = page.panels.find(
        (p) => p.id === selected || p.id === bubble?.panel,
      )?.box ?? { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
      add({
        x: anchor.x + anchor.w * 0.15,
        y: anchor.y + anchor.h * 0.15,
        w: Math.min(0.2, anchor.w * 0.6),
        h: Math.min(0.08, anchor.h * 0.4),
      });
      return;
    }
    if (e.key === "[") navigate(pageIndex - 1);
    if (e.key === "]") navigate(pageIndex + 1);
    if (e.key.toLowerCase() === "j") nextFlag();
    if (e.key.toLowerCase() === "a") setDrawing(true);
    if (e.key === "?") setHelp((h) => !h);
    if (e.key === "Escape") {
      setDrawing(false);
      setHelp(false);
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      advance(e.key === "ArrowDown" ? 1 : -1);
    }
  }
  function numericBox(box: Box, id: string, isPanel: boolean) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-neutral-500">BOX %</span>
        {(["x", "y", "w", "h"] as const).map((key) => (
          <label
            key={key}
            className="flex items-center gap-1 text-xs text-neutral-500"
          >
            {key}
            <input
              aria-label={`${isPanel ? "Panel" : "Bubble"} box ${key}`}
              type="number"
              min={key === "w" || key === "h" ? 1 : 0}
              max="100"
              step="0.5"
              value={Math.round(box[key] * 1000) / 10}
              className={`${field} w-16`}
              onChange={(e) => {
                const value = Math.max(
                  key === "w" || key === "h" ? 0.01 : 0,
                  Math.min(1, Number(e.target.value) / 100),
                );
                const next = { ...box, [key]: value };
                next.w = Math.min(next.w, 1 - next.x);
                next.h = Math.min(next.h, 1 - next.y);
                record();
                editBox(id, next, isPanel);
              }}
            />
          </label>
        ))}
      </div>
    );
  }

  return (
    <main
      className="fixed inset-0 flex flex-col bg-neutral-950 text-neutral-200"
      onKeyDown={keyboard}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-800 px-5">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-neutral-500">C / SCRIPT</span>
          <h1 className="text-sm font-medium">{title}</h1>
          <span className="hidden text-xs text-neutral-500 lg:inline">
            {book} / {issue}
          </span>
        </div>
        <div className="flex gap-2">
          <button className={button} onClick={() => setHelp((h) => !h)}>
            Keys ?
          </button>
          <button className={button} disabled={!history.length} onClick={undo}>
            Undo {history.length ? `(${history.length})` : ""}
          </button>
          <button
            className={button}
            onClick={() =>
              setNote(
                "Saved locally for this tab. Prototype: nothing was written. Your page, selection and values are kept.",
              )
            }
          >
            Save
          </button>
        </div>
      </header>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-5">
        <div className="flex items-center gap-3">
          <button
            aria-label="Previous page"
            className={button}
            disabled={pageIndex === 0}
            onClick={() => navigate(pageIndex - 1)}
          >
            ←
          </button>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            Page{" "}
            <select
              aria-label="Page"
              value={pageIndex}
              className={field}
              onChange={(e) => navigate(Number(e.target.value))}
            >
              {doc.pages.map((p, i) => (
                <option key={p.number} value={i}>
                  {p.number}
                  {doc.approved.includes(p.number) ? " · approved" : ""}
                </option>
              ))}
            </select>{" "}
            / {doc.pages.length}
          </label>
          <button
            aria-label="Next page"
            className={button}
            disabled={pageIndex === doc.pages.length - 1}
            onClick={() => navigate(pageIndex + 1)}
          >
            →
          </button>
          <span className="text-xs text-neutral-500">
            {page.bubbles.length} lines · {page.panels.length} panels
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`${button} ${attention.length ? "border-amber-800 text-amber-300" : ""}`}
            onClick={nextFlag}
          >
            {attention.length} need attention · Next J
          </button>
          <span className="text-xs text-neutral-500">
            {doc.approved.length}/{doc.pages.length} pages approved
          </span>
        </div>
      </div>
      {help && (
        <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-neutral-700 bg-neutral-900 px-5 py-3 font-mono text-xs text-neutral-300">
          <span>Enter / Tab in text: next line</span>
          <span>Shift+Enter / Shift+Tab: previous</span>
          <span>Alt+← / →: page</span>
          <span>J / Cmd+J: next flag</span>
          <span>Alt+↑ / ↓: reorder</span>
          <span>Alt+Shift+↑ / ↓: panel</span>
          <span>A: draw bubble · Enter: insert starter box</span>
          <span>Cmd/Ctrl+Z: undo</span>
          <span>Cmd/Ctrl+S: save</span>
          <span>Esc: cancel draw</span>
          <span>?: keys</span>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section className="flex min-h-0 flex-col border-r border-neutral-800">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-5">
            <span className="font-mono text-[10px] tracking-wider text-neutral-500">
              PAGE {page.number} ·{" "}
              {drawing
                ? "DRAW A BOX · ENTER TO INSERT"
                : "CLICK A BOX TO EDIT ITS LINE"}
            </span>
            <div className="flex items-center gap-2">
              <select
                aria-label="Zoom"
                value={zoom}
                className={field}
                onChange={(e) => setZoom(Number(e.target.value))}
              >
                <option value={1}>Fit</option>
                <option value={1.3}>Zoom 130%</option>
                <option value={1.7}>Zoom 170%</option>
              </select>
              <button
                className={`${button} ${drawing ? "border-sky-500 text-sky-300" : ""}`}
                onClick={() => setDrawing((d) => !d)}
              >
                {drawing ? "Cancel draw" : "+ Bubble"}
              </button>
            </div>
          </div>
          <div
            ref={artRef}
            className="min-h-0 flex-1 overflow-auto bg-neutral-900/40"
          >
            <PageCanvas
              page={{ ...page, bubbles: list }}
              selected={selected}
              cast={doc.cast}
              drawing={drawing}
              zoom={zoom}
              select={select}
              onBox={editBox}
              onStart={record}
              onAdd={add}
            />
          </div>
          <div className="flex h-8 shrink-0 items-center justify-between border-t border-neutral-800 px-5 text-[10px] text-neutral-500">
            <span>Amber: needs attention · Blue: selected</span>
            <span>Drag box to move · corner to resize</span>
          </div>
        </section>
        <section className="flex min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-5">
            <span className="font-mono text-[10px] tracking-wider text-neutral-500">
              SCRIPT · READING ORDER
            </span>
            <span className="text-[10px] text-neutral-500">
              Enter to read on
            </span>
          </div>
          <div ref={scriptRef} className="min-h-0 flex-1 overflow-y-auto pb-10">
            {[...page.panels.map((p) => p.id), ""].map((panelId, pi) => {
              const entries = list.filter((b) => b.panel === panelId);
              if (!panelId && !entries.length) return null;
              const currentPanel = page.panels.find((p) => p.id === panelId);
              return (
                <section key={panelId || "unplaced"}>
                  <div
                    data-entry={panelId}
                    className={`sticky top-0 z-30 flex items-center justify-between border-y border-neutral-800 px-5 py-2 ${selected === panelId ? "bg-neutral-800" : "bg-neutral-900"}`}
                  >
                    <button
                      className="font-mono text-xs text-neutral-300 uppercase hover:text-sky-300"
                      onClick={() => select(panelId)}
                    >
                      {panelId ? `Panel ${pi + 1}` : "Outside panels"}
                    </button>
                    <span className="font-mono text-[10px] text-neutral-500">
                      {entries.filter((b) => !b.ignored).length} lines
                    </span>
                  </div>
                  {currentPanel && selected === panelId && (
                    <div className="border-b border-neutral-800 px-5 py-3">
                      {numericBox(currentPanel.box, panelId, true)}
                      <p className="mt-2 text-xs text-neutral-500">
                        Move or resize on the page, or enter percentages here.
                      </p>
                    </div>
                  )}
                  {entries.map((b) => {
                    const duplicate = likelyDuplicate(b, page);
                    const missing = needsSpeaker(b, doc.cast);
                    const proposal = proposals[b.id];
                    const ordinal = list.findIndex((x) => x.id === b.id) + 1;
                    return (
                      <article
                        key={b.id}
                        data-entry={b.id}
                        className={`relative border-b border-neutral-800/70 py-3 pr-5 pl-14 ${selected === b.id ? "bg-neutral-900/80" : ""} ${b.ignored ? "opacity-45" : ""}`}
                        onFocusCapture={() => {
                          if (selected !== b.id) select(b.id);
                        }}
                        onClick={() => {
                          if (selected !== b.id) select(b.id);
                        }}
                      >
                        <button
                          aria-label={`Select line ${ordinal}`}
                          className={`absolute top-4 left-4 font-mono text-xs ${selected === b.id ? "text-sky-400" : duplicate || missing ? "text-amber-400" : "text-neutral-600"}`}
                          onClick={() => select(b.id, true)}
                        >
                          {String(ordinal).padStart(2, "0")}
                          {duplicate || missing ? "!" : ""}
                        </button>
                        <div className="flex items-center justify-between gap-2">
                          <SpeakerPicker
                            label={`Speaker line ${ordinal}`}
                            value={b.speaker}
                            cast={doc.cast}
                            onPick={(speaker) => edit(b.id, { speaker })}
                            onAdd={(name) => {
                              change((d) => ({
                                ...d,
                                cast: [...d.cast, name],
                                issueApproved: false,
                                approved: d.approved.filter(
                                  (n) => n !== page.number,
                                ),
                                pages: d.pages.map((p) =>
                                  p.number === page.number
                                    ? {
                                        ...p,
                                        bubbles: p.bubbles.map((x) =>
                                          x.id === b.id
                                            ? { ...x, speaker: name }
                                            : x,
                                        ),
                                      }
                                    : p,
                                ),
                              }));
                              setNote(
                                `Added ${name} to the cast in this tab only.`,
                              );
                            }}
                          />
                          <div className="flex gap-1">
                            <button
                              aria-label={`Move line ${ordinal} up`}
                              className="px-1 text-xs text-neutral-500 hover:text-white"
                              onClick={(e) => {
                                e.stopPropagation();
                                reorder(b.id, -1);
                              }}
                            >
                              ↑
                            </button>
                            <button
                              aria-label={`Move line ${ordinal} down`}
                              className="px-1 text-xs text-neutral-500 hover:text-white"
                              onClick={(e) => {
                                e.stopPropagation();
                                reorder(b.id, 1);
                              }}
                            >
                              ↓
                            </button>
                          </div>
                        </div>
                        <textarea
                          aria-label={`Text line ${ordinal}`}
                          value={b.text}
                          placeholder="Type the line…"
                          rows={Math.max(2, Math.ceil(b.text.length / 62))}
                          className="mt-1 block w-full resize-y border-l-2 border-transparent bg-transparent py-1 pr-2 pl-1 font-mono text-sm leading-6 text-neutral-100 outline-none focus:border-sky-400"
                          onChange={(e) =>
                            edit(b.id, { text: e.target.value }, `${b.id}-text`)
                          }
                          onKeyDown={(e) => {
                            if (
                              (e.key === "Enter" &&
                                !e.ctrlKey &&
                                !e.metaKey &&
                                !e.altKey) ||
                              e.key === "Tab"
                            ) {
                              e.preventDefault();
                              advance(e.shiftKey ? -1 : 1);
                            }
                          }}
                        />
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <input
                            aria-label={`Emotion line ${ordinal}`}
                            className={`${field} w-28`}
                            value={b.emotion}
                            placeholder="Emotion"
                            onChange={(e) =>
                              edit(
                                b.id,
                                { emotion: e.target.value },
                                `${b.id}-emotion`,
                              )
                            }
                          />
                          <select
                            aria-label={`Type line ${ordinal}`}
                            className={field}
                            value={b.type}
                            onChange={(e) =>
                              edit(b.id, { type: e.target.value })
                            }
                          >
                            {[
                              "speech",
                              "narration",
                              "caption",
                              "sfx",
                              "background",
                            ].map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                          <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                            <input
                              type="checkbox"
                              checked={b.silent}
                              onChange={(e) =>
                                edit(b.id, { silent: e.target.checked })
                              }
                              className="accent-sky-400"
                            />
                            Silent
                          </label>
                          <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                            <input
                              type="checkbox"
                              checked={b.ignored}
                              onChange={(e) =>
                                edit(b.id, { ignored: e.target.checked })
                              }
                              className="accent-sky-400"
                            />
                            Ignore
                          </label>
                        </div>
                        {(duplicate || missing) && !b.ignored && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-400">
                            {missing && (
                              <span>
                                {b.speaker
                                  ? `Outside cast: ${b.speaker}`
                                  : "Needs speaker"}
                              </span>
                            )}
                            {duplicate && (
                              <>
                                <span>Likely duplicate</span>
                                <button
                                  className="underline underline-offset-2 hover:text-amber-200"
                                  onClick={() => edit(b.id, { ignored: true })}
                                >
                                  Dismiss duplicate
                                </button>
                                <button
                                  className="text-neutral-500 underline underline-offset-2"
                                  onClick={() =>
                                    edit(b.id, { duplicateDismissed: true })
                                  }
                                >
                                  Keep both
                                </button>
                              </>
                            )}
                          </div>
                        )}
                        {selected === b.id && (
                          <div className="mt-3 space-y-3 border-t border-neutral-800 pt-3">
                            <label className="flex items-center gap-2 text-xs text-neutral-500">
                              Panel
                              <select
                                aria-label={`Panel line ${ordinal}`}
                                className={field}
                                value={b.panel}
                                onChange={(e) =>
                                  movePanel(b.id, e.target.value)
                                }
                              >
                                <option value="">Outside panels</option>
                                {page.panels.map((p, i) => (
                                  <option key={p.id} value={p.id}>
                                    Panel {i + 1}
                                  </option>
                                ))}
                              </select>
                              <span className="text-[10px]">
                                Alt+↑ / ↓ reorder
                              </span>
                            </label>
                            {numericBox(b.box, b.id, false)}
                          </div>
                        )}
                        {b.fresh && proposal && (
                          <div className="mt-3 border border-neutral-700 bg-neutral-950 p-3 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] text-sky-300">
                                SIMULATED ANALYSIS ·{" "}
                                {proposal.state === "ready"
                                  ? `TRY ${proposal.attempt}`
                                  : proposal.state.toUpperCase()}
                              </span>
                              {proposal.state === "accepted" && (
                                <button
                                  className="text-neutral-400 underline"
                                  onClick={() => retry(b.id)}
                                >
                                  Analyze again
                                </button>
                              )}
                            </div>
                            {proposal.state === "waiting" && (
                              <p className="mt-2 text-neutral-500">
                                Starts after the box is still for one second.
                              </p>
                            )}
                            {proposal.state === "running" && (
                              <p className="mt-2 text-neutral-500">
                                Simulating text, speaker and emotion…
                              </p>
                            )}
                            {proposal.state === "ready" && (
                              <>
                                <p className="mt-2 font-mono text-neutral-300">
                                  {proposal.speaker} · {proposal.emotion}
                                </p>
                                <p className="mt-1 leading-5 text-neutral-300">
                                  {proposal.text}
                                </p>
                                <div className="mt-3 flex gap-2">
                                  <button
                                    className={button}
                                    onClick={() => accept(b.id)}
                                  >
                                    Accept values
                                  </button>
                                  <button
                                    className={button}
                                    onClick={() => retry(b.id)}
                                  >
                                    Retry
                                  </button>
                                </div>
                              </>
                            )}
                            {proposal.state === "accepted" && (
                              <p className="mt-2 text-neutral-500">
                                Accepted simulated values. Edit them above.
                              </p>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {!entries.length && (
                    <p className="px-5 py-4 text-xs text-neutral-600">
                      No detected lines. Draw a bubble on the page.
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      </div>
      <footer className="shrink-0 border-t border-neutral-700 bg-neutral-900 px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <p
            role="status"
            className="max-w-[65%] text-xs leading-5 text-neutral-400"
          >
            {note}
          </p>
          <div className="flex gap-2">
            <button
              className={`${button} ${blockers.length ? "border-amber-800 text-amber-300" : ""}`}
              onClick={() => approve(false)}
            >
              {doc.approved.includes(page.number)
                ? "Page approved"
                : blockers.length
                  ? `Page blocked · ${blockers.length} speakers`
                  : "Approve page"}
            </button>
            <button
              className={`${button} ${issueBlockers.length ? "border-amber-800 text-amber-300" : "border-sky-700 text-sky-300"}`}
              onClick={() => approve(true)}
            >
              {doc.issueApproved
                ? "Issue approved"
                : issueBlockers.length
                  ? `Issue blocked · ${issueBlockers.length} speakers`
                  : "Approve issue"}
            </button>
          </div>
        </div>
      </footer>
    </main>
  );
}
