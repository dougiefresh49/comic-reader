// THROWAWAY spike for issue #325 (review editor variant B). The second room: the whole page, every box, direct edits.
"use client";

import { useRef, useState } from "react";
import { Fields } from "./Fields";
import {
  SIGNAL_LABEL,
  SIGNAL_TONE,
  clampBox,
  groupPage,
  needsSpeaker,
  panelOf,
  panelsOnPage,
  playOrder,
  speakerName,
} from "./logic";
import { Btn } from "./QueueView";
import type { Api } from "./TriageEditor";
import type { Box, EditState } from "./types";
import { Viewport, place } from "./Viewport";

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
type Corner = "nw" | "ne" | "sw" | "se";

export function PageView({ api }: { api: Api }) {
  const { data, page } = api;
  const pg = data.pages.find((p) => p.number === page);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[270px_minmax(0,1fr)_330px]">
      <aside className="flex min-h-0 flex-col border-r border-neutral-800">
        <PageNav api={api} />
        <Tree api={api} />
      </aside>
      <main className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
          <button
            type="button"
            onClick={() => api.setDrawMode(!api.drawMode)}
            className={`rounded px-2 py-0.5 ${
              api.drawMode
                ? "bg-cyan-800 text-white"
                : "border border-neutral-700 hover:bg-neutral-800"
            }`}
          >
            {api.drawMode ? "Drawing: drag a box on the page" : "Draw bubble"}{" "}
            <kbd className="text-neutral-400">N</kbd>
          </button>
          <span className="text-neutral-500">
            Click a box to select it. Drag to move, drag a corner to resize.
          </span>
        </div>
        {pg ? (
          <Canvas api={api} />
        ) : (
          <div className="p-4 text-neutral-500">No page.</div>
        )}
      </main>
      <aside className="flex min-h-0 flex-col border-l border-neutral-800">
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <Inspector api={api} />
        </div>
        <Approve api={api} />
      </aside>
    </div>
  );
}

function PageNav({ api }: { api: Api }) {
  const { page, data, doc } = api;
  const approved = doc.approvedPages.includes(page);
  return (
    <div className="flex items-center gap-1 border-b border-neutral-800 p-2">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => api.setPage(page - 1)}
        className="rounded border border-neutral-700 px-1.5 hover:bg-neutral-800 disabled:opacity-40"
      >
        Prev <kbd className="text-neutral-500">[</kbd>
      </button>
      <select
        value={page}
        onChange={(e) => api.setPage(parseInt(e.target.value, 10))}
        className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
      >
        {data.pages.map((p) => (
          <option key={p.number} value={p.number}>
            Page {p.number} of {data.pages.length}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={page >= data.pages.length}
        onClick={() => api.setPage(page + 1)}
        className="rounded border border-neutral-700 px-1.5 hover:bg-neutral-800 disabled:opacity-40"
      >
        Next <kbd className="text-neutral-500">]</kbd>
      </button>
      {approved && <span className="ml-auto text-emerald-400">approved</span>}
    </div>
  );
}

function Tree({ api }: { api: Api }) {
  const { doc, page, sel } = api;
  const groups = groupPage(doc, page);
  let n = 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {groups.map((g) => (
        <div key={g.panel?.id ?? "loose"} className="mb-1">
          {g.panel ? (
            <button
              type="button"
              onClick={() => api.select({ kind: "panel", id: g.panel!.id })}
              className={`flex w-full items-center gap-2 px-2 py-0.5 text-left ${
                sel?.kind === "panel" && sel.id === g.panel.id
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              <span>Panel {g.panel.order + 1}</span>
              <span className="truncate text-[10px] text-neutral-600">
                {g.panel.faces
                  .map((f) => api.cast.byId.get(f)?.name ?? f)
                  .join(", ")}
              </span>
            </button>
          ) : (
            <div className="px-2 py-0.5 text-amber-300">No panel</div>
          )}
          {g.bubbles.map((b) => {
            n += 1;
            const selected = sel?.kind === "bubble" && sel.id === b.id;
            const sigs = api.signals.get(b.id) ?? [];
            const dec = doc.decided[b.id];
            return (
              <div
                key={b.id}
                className={`group flex items-center gap-1 pr-1 pl-4 ${
                  selected ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
              >
                <button
                  type="button"
                  onClick={() => api.select({ kind: "bubble", id: b.id })}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left ${
                    b.ignored
                      ? "text-neutral-600 line-through"
                      : "text-neutral-300"
                  }`}
                >
                  <span className="w-4 shrink-0 text-right text-neutral-500">
                    {n}
                  </span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      dec
                        ? "bg-emerald-500"
                        : sigs.length
                          ? "bg-amber-400"
                          : "bg-neutral-700"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {b.text.replace(/\s+/g, " ") || "(no text)"}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {b.silent
                      ? "silent"
                      : speakerName(api.cast, b.speaker) ||
                        b.type.toLowerCase()}
                  </span>
                </button>
                {selected && (
                  <span className="flex shrink-0">
                    <button
                      type="button"
                      title="Earlier (Alt+Up)"
                      onClick={() => api.reorder(b.id, -1)}
                      className="px-1 text-neutral-400 hover:text-white"
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      title="Later (Alt+Down)"
                      onClick={() => api.reorder(b.id, 1)}
                      className="px-1 text-neutral-400 hover:text-white"
                    >
                      Down
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface Drag {
  mode: "move" | "resize" | "draw";
  kind: "bubble" | "panel";
  id: string;
  corner?: Corner;
  start: { x: number; y: number };
  startBox: Box;
  snapshot: EditState;
  moved: boolean;
}

function Canvas({ api }: { api: Api }) {
  const { doc, page, sel } = api;
  const pg = api.data.pages.find((p) => p.number === page)!;
  const inner = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const order = playOrder(doc, page);
  const panels = panelsOnPage(doc.panels, page);

  const toFrac = (e: React.PointerEvent) => {
    const r = inner.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = toFrac(e);
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
    inner.current?.setPointerCapture(e.pointerId);
    if (api.drawMode) {
      drag.current = {
        mode: "draw",
        kind: "bubble",
        id: "",
        start: p,
        startBox: { x: p.x, y: p.y, w: 0, h: 0 },
        snapshot: api.snapshot(),
        moved: false,
      };
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (!el) {
      api.select(null);
      return;
    }
    const kind = el.dataset.kind as "bubble" | "panel";
    const id = el.dataset.id!;
    const corner = el.dataset.corner as Corner | undefined;
    const box = kind === "bubble" ? doc.bubbles[id]?.box : doc.panels[id]?.box;
    if (!box) return;
    if (!corner) api.select({ kind, id });
    drag.current = {
      mode: corner ? "resize" : "move",
      kind,
      id,
      corner,
      start: p,
      startBox: box,
      snapshot: api.snapshot(),
      moved: false,
    };
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toFrac(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!d.moved && Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) return;
    d.moved = true;
    if (d.mode === "draw") {
      setDraft({
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
      return;
    }
    const s = d.startBox;
    let b: Box;
    if (d.mode === "move") b = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      const c = d.corner!;
      b = { ...s };
      if (c.includes("w")) {
        b.x = s.x + dx;
        b.w = s.w - dx;
      } else b.w = s.w + dx;
      if (c.includes("n")) {
        b.y = s.y + dy;
        b.h = s.h - dy;
      } else b.h = s.h + dy;
      if (b.w < 0.01) b.w = 0.01;
      if (b.h < 0.01) b.h = 0.01;
    }
    api.liveBox(d.kind, d.id, clampBox(b));
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "draw") {
      const box = draft;
      setDraft(null);
      if (box && box.w > 0.01 && box.h > 0.01)
        api.addBubble(page, clampBox(box));
      return;
    }
    if (!d.moved) return;
    api.finishDrag(
      `${d.mode === "move" ? "Move" : "Resize"} ${d.kind}`,
      d.snapshot,
      d.kind,
      d.id,
    );
  };

  const handles = (kind: "bubble" | "panel", id: string) =>
    (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
      <span
        key={c}
        data-kind={kind}
        data-id={id}
        data-corner={c}
        className={`absolute h-2.5 w-2.5 border border-white bg-cyan-500 ${
          c === "nw"
            ? "-top-1.5 -left-1.5 cursor-nwse-resize"
            : c === "se"
              ? "-right-1.5 -bottom-1.5 cursor-nwse-resize"
              : c === "ne"
                ? "-top-1.5 -right-1.5 cursor-nesw-resize"
                : "-bottom-1.5 -left-1.5 cursor-nesw-resize"
        }`}
      />
    ));

  return (
    <Viewport
      ref={inner}
      page={pg}
      region={FULL}
      className="flex-1 bg-black p-3"
      innerClassName={api.drawMode ? "cursor-crosshair" : ""}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {panels.map((p) => {
        const selected = sel?.kind === "panel" && sel.id === p.id;
        return (
          <div
            key={p.id}
            data-kind="panel"
            data-id={p.id}
            style={place(p.box, FULL)}
            className={`border ${
              selected
                ? "z-10 border-2 border-cyan-400"
                : "border-fuchsia-300/40 hover:border-fuchsia-300/80"
            } ${api.drawMode ? "" : "cursor-move"}`}
          >
            <span className="absolute top-0 left-0 bg-black/70 px-1 text-[10px] text-fuchsia-200">
              P{p.order + 1}
            </span>
            {selected && handles("panel", p.id)}
          </div>
        );
      })}
      {order.map((b, i) => {
        const selected = sel?.kind === "bubble" && sel.id === b.id;
        const flagged =
          (api.signals.get(b.id)?.length ?? 0) > 0 && !doc.decided[b.id];
        return (
          <div
            key={b.id}
            data-kind="bubble"
            data-id={b.id}
            style={place(b.box, FULL)}
            className={`z-20 ${api.drawMode ? "" : "cursor-move"} ${
              selected
                ? "border-2 border-cyan-400 bg-cyan-400/10"
                : b.ignored
                  ? "border border-dashed border-neutral-500/70"
                  : flagged
                    ? "border-2 border-amber-400/90"
                    : doc.decided[b.id]
                      ? "border border-emerald-400/80"
                      : "border border-white/60"
            }`}
          >
            <span className="absolute -top-3.5 left-0 bg-black/80 px-0.5 text-[10px] leading-tight text-white">
              {i + 1}
            </span>
            {selected && handles("bubble", b.id)}
          </div>
        );
      })}
      {draft && (
        <div
          style={place(draft, FULL)}
          className="pointer-events-none z-30 border-2 border-dashed border-cyan-300"
        />
      )}
    </Viewport>
  );
}

function Inspector({ api }: { api: Api }) {
  const { doc, sel, page } = api;
  if (!sel)
    return (
      <p className="text-neutral-500">
        Select a bubble or panel on the page or in the list, or press N to draw
        a bubble.
      </p>
    );
  if (sel.kind === "panel") {
    const p = doc.panels[sel.id];
    if (!p) return null;
    const count = groupPage(doc, page).find((g) => g.panel?.id === p.id)
      ?.bubbles.length;
    return (
      <div className="space-y-2">
        <div className="text-sm text-neutral-100">Panel {p.order + 1}</div>
        <p className="text-neutral-400">
          {count ?? 0} bubbles. Faces found:{" "}
          {p.faces.map((f) => api.cast.byId.get(f)?.name ?? f).join(", ") ||
            "none"}
          .
        </p>
        <p className="text-neutral-500">
          Drag to move, drag a corner to resize. Bubbles with no stored panel
          follow the box.
        </p>
        <div className="flex gap-1">
          <Btn onClick={() => api.reorderPanel(p.id, -1)} k="Alt+Up">
            Earlier
          </Btn>
          <Btn onClick={() => api.reorderPanel(p.id, 1)} k="Alt+Down">
            Later
          </Btn>
        </div>
      </div>
    );
  }
  const b = doc.bubbles[sel.id];
  if (!b) return null;
  const sigs = api.signals.get(b.id) ?? [];
  const dec = doc.decided[b.id];
  const twins = sigs.find((s) => s.key === "duplicate")?.related ?? [];
  const pos = playOrder(doc, page).findIndex((x) => x.id === b.id) + 1;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-neutral-100">Bubble {pos}</span>
        {dec ? (
          <span className="text-emerald-400">
            {dec}{" "}
            <button
              type="button"
              onClick={() => api.reopen(b.id)}
              className="text-neutral-400 underline hover:text-white"
            >
              reopen
            </button>
          </span>
        ) : null}
      </div>
      {sigs.length > 0 && (
        <ul className="space-y-0.5">
          {sigs.map((s) => (
            <li key={s.key} className="flex gap-2">
              <span
                className={`shrink-0 rounded border px-1 text-[10px] ${SIGNAL_TONE[s.key]}`}
              >
                {SIGNAL_LABEL[s.key]}
              </span>
              <span className="text-neutral-400">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <Btn primary onClick={() => api.accept(b.id, false)} k="Enter">
          Accept
        </Btn>
        <Btn onClick={() => api.silent(b.id, false)} k="S">
          {b.silent ? "Unmark silent" : "Silent"}
        </Btn>
        <Btn onClick={() => api.ignore(b.id, false)} k="X">
          {b.ignored ? "Unignore" : "Ignore"}
        </Btn>
        {twins.length > 0 && !b.ignored && (
          <Btn onClick={() => api.dismissDuplicate(b.id, false)} k="D">
            Dismiss duplicate
          </Btn>
        )}
      </div>
      {api.warning && <p className="text-amber-300">{api.warning}</p>}
      <Fields
        bubble={b}
        cast={api.cast}
        shortlist={api.shortlistFor(b.id)}
        panels={panelsOnPage(doc.panels, page)}
        panelId={panelOf(b, doc.panels)?.id ?? null}
        analyze={api.analyze[b.id]}
        onPatch={(p, label, key) => api.patch(b.id, p, label, key)}
        onSpeaker={(id) => api.setSpeaker(b.id, id)}
        onAddCharacter={(name) => api.addCharacter(b.id, name)}
        onMovePanel={(pid) => api.movePanel(b.id, pid)}
        onTakeOffer={() => api.takeOffer(b.id)}
        onRetryOffer={() => api.retryOffer(b.id)}
        pickerOpen={api.pickerOpen}
        setPickerOpen={api.setPickerOpen}
      />
    </div>
  );
}

function Approve({ api }: { api: Api }) {
  const { doc, page } = api;
  const missing = playOrder(doc, page).filter(needsSpeaker);
  const approved = doc.approvedPages.includes(page);
  const blocked = api.blocked?.scope === page ? api.blocked : null;
  return (
    <div className="border-t border-neutral-800 p-3">
      {approved ? (
        <p className="text-emerald-400">Page {page} approved.</p>
      ) : (
        <button
          type="button"
          onClick={() => api.approvePage(page)}
          className="w-full rounded bg-emerald-800 px-2 py-1 text-white hover:bg-emerald-700"
        >
          Approve page {page} <kbd className="text-emerald-300">a</kbd>
        </button>
      )}
      {missing.length > 0 && (
        <p
          className={`mt-1.5 ${blocked ? "text-red-300" : "text-neutral-500"}`}
        >
          {blocked ? "Blocked: " : ""}
          {missing.length} spoken bubble{missing.length > 1 ? "s" : ""} on this
          page {missing.length > 1 ? "have" : "has"} no speaker.{" "}
          <button
            type="button"
            onClick={() => api.select({ kind: "bubble", id: missing[0]!.id })}
            className="underline hover:text-white"
          >
            Select the first
          </button>
        </p>
      )}
    </div>
  );
}
