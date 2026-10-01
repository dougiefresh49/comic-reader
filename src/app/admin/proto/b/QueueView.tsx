// THROWAWAY spike for issue #325 (review editor variant B). The queue: one item at a time, zoomed on its panel.
"use client";

import { useEffect, useRef } from "react";
import { Fields } from "./Fields";
import {
  SIGNAL_LABEL,
  SIGNAL_TONE,
  pad,
  panelOf,
  playOrder,
  speakerName,
  union,
} from "./logic";
import type { Api } from "./TriageEditor";
import type { Box, SignalKey } from "./types";
import { Viewport, place } from "./Viewport";

const FILTER_ORDER: SignalKey[] = [
  "no-speaker",
  "off-list",
  "duplicate",
  "merged",
  "no-panel",
  "new",
  "not-in-panel",
  "low-confidence",
];

function snippet(s: string, n = 48): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}...` : one || "(no text)";
}

export function QueueView({ api }: { api: Api }) {
  const { doc, cursor, data } = api;
  const b = cursor ? doc.bubbles[cursor] : undefined;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[270px_minmax(0,1fr)_340px]">
      <aside className="flex min-h-0 flex-col border-r border-neutral-800">
        <Filters api={api} />
        <QueueList api={api} />
        <LooksRight api={api} />
      </aside>
      <main className="flex min-h-0 flex-col">
        {b ? (
          <Item api={api} id={b.id} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-neutral-500">
            {api.queueIds.length
              ? "Pick an item on the left."
              : "Nothing needs a decision. Check the looks-right list, then approve the issue."}
          </div>
        )}
      </main>
      <aside className="flex min-h-0 flex-col border-l border-neutral-800">
        {b ? (
          <>
            <MiniPage api={api} id={b.id} />
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <Fields
                bubble={b}
                cast={api.cast}
                shortlist={api.shortlistFor(b.id)}
                panels={data.panels
                  .filter((p) => p.page === b.page)
                  .map((p) => doc.panels[p.id]!)
                  .sort((x, y) => x.order - y.order)}
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
          </>
        ) : null}
      </aside>
    </div>
  );
}

function Filters({ api }: { api: Api }) {
  const counts = new Map<SignalKey, number>();
  for (const id of Object.keys(api.doc.bubbles))
    for (const k of api.keysFor(id)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return (
    <div className="border-b border-neutral-800 p-2">
      <div className="mb-1 text-neutral-500">Flag when</div>
      <div className="flex flex-wrap gap-1">
        {FILTER_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => api.toggleFilter(k)}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              api.filters[k]
                ? SIGNAL_TONE[k]
                : "border-neutral-800 text-neutral-600 line-through"
            }`}
            title={api.filters[k] ? "Click to stop flagging" : "Click to flag"}
          >
            {SIGNAL_LABEL[k]} {counts.get(k) ?? 0}
          </button>
        ))}
      </div>
    </div>
  );
}

function QueueList({ api }: { api: Api }) {
  const { doc, cursor } = api;
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  let lastPage = 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {api.queueIds.map((id, i) => {
        const b = doc.bubbles[id]!;
        const dec = doc.decided[id];
        const sigs = api.signals.get(id) ?? [];
        const header = b.page !== lastPage;
        lastPage = b.page;
        return (
          <div key={id}>
            {header && (
              <div className="sticky top-0 z-10 bg-neutral-950 px-2 pt-2 pb-0.5 text-[10px] tracking-wide text-neutral-500 uppercase">
                Page {b.page}
              </div>
            )}
            <button
              ref={id === cursor ? active : undefined}
              type="button"
              onClick={() => api.setCursor(id)}
              className={`flex w-full items-start gap-1.5 px-2 py-1 text-left ${
                id === cursor
                  ? "bg-neutral-800 text-white"
                  : dec
                    ? "text-neutral-600 hover:bg-neutral-900"
                    : "text-neutral-300 hover:bg-neutral-900"
              }`}
            >
              <span className="w-5 shrink-0 text-right text-neutral-600">
                {i + 1}
              </span>
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  dec ? "bg-emerald-500" : "bg-amber-400"
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{snippet(b.text)}</span>
                <span className="flex flex-wrap gap-1 text-[10px]">
                  {dec ? (
                    <span className="text-emerald-500">{dec}</span>
                  ) : sigs.length ? (
                    sigs.map((s) => (
                      <span
                        key={s.key}
                        className={SIGNAL_TONE[s.key].split(" ")[0]}
                      >
                        {SIGNAL_LABEL[s.key]}
                      </span>
                    ))
                  ) : (
                    <span className="text-neutral-500">fixed</span>
                  )}
                  <span className="text-neutral-500">
                    {speakerName(api.cast, b.speaker)}
                  </span>
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function LooksRight({ api }: { api: Api }) {
  const pages = Object.keys(api.looksRight)
    .map(Number)
    .sort((a, b) => a - b);
  return (
    <div className="max-h-[38%] overflow-y-auto border-t border-neutral-800">
      <div className="px-2 pt-2 pb-1 text-neutral-500">
        Looks right: no flag. Accept a page at once, or open one to check.
      </div>
      {pages.map((p) => {
        const ids = api.looksRight[p] ?? [];
        const open = ids.filter((x) => !api.doc.decided[x]).length;
        return (
          <details key={p} className="px-2 pb-1">
            <summary className="flex cursor-pointer items-center gap-2 py-0.5 text-neutral-300">
              <span>Page {p}</span>
              <span className="text-neutral-500">
                {ids.length} bubbles, {ids.length - open} accepted
              </span>
              <button
                type="button"
                disabled={!open}
                onClick={(e) => {
                  e.preventDefault();
                  api.acceptLooksRight(p);
                }}
                className="ml-auto rounded border border-neutral-700 px-1.5 text-[11px] hover:bg-neutral-800 disabled:opacity-40"
              >
                Accept {open}
              </button>
            </summary>
            <ul>
              {ids.map((id) => {
                const b = api.doc.bubbles[id]!;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => api.setCursor(id)}
                      className={`flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-neutral-900 ${
                        api.cursor === id ? "bg-neutral-800" : ""
                      }`}
                    >
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                          api.doc.decided[id]
                            ? "bg-emerald-500"
                            : "bg-neutral-600"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-neutral-400">
                        {snippet(b.text, 34)}
                      </span>
                      <span className="shrink-0 text-neutral-500">
                        {speakerName(api.cast, b.speaker) ||
                          b.type.toLowerCase()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

function regionFor(api: Api, id: string): Box {
  const b = api.doc.bubbles[id]!;
  const panel = panelOf(b, api.doc.panels);
  let r: Box;
  if (api.zoom === "close" || !panel) {
    const m = Math.max(b.box.w, b.box.h) * 0.9;
    r = pad(b.box, m);
  } else {
    r = pad(union(panel.box, b.box), 0.01);
  }
  // Never zoom in so far that the tail falls outside.
  if (r.w < 0.18) {
    const cx = r.x + r.w / 2;
    r = { ...r, x: Math.max(0, cx - 0.09), w: 0.18 };
  }
  if (r.h < 0.12) {
    const cy = r.y + r.h / 2;
    r = { ...r, y: Math.max(0, cy - 0.06), h: 0.12 };
  }
  return {
    x: r.x,
    y: r.y,
    w: Math.min(r.w, 1 - r.x),
    h: Math.min(r.h, 1 - r.y),
  };
}

function Item({ api, id }: { api: Api; id: string }) {
  const { doc, data } = api;
  const b = doc.bubbles[id]!;
  const pg = data.pages.find((p) => p.number === b.page);
  const panel = panelOf(b, doc.panels);
  const sigs = api.signals.get(id) ?? [];
  const was = (api.initialSignals.get(id) ?? []).filter(
    (s) => !sigs.some((x) => x.key === s.key),
  );
  const dec = doc.decided[id];
  const qi = api.queueIds.indexOf(id);
  const order = playOrder(doc, b.page);
  const pos = order.findIndex((x) => x.id === id) + 1;
  const twins = sigs.find((s) => s.key === "duplicate")?.related ?? [];
  const parts = sigs.find((s) => s.key === "merged")?.related ?? [];
  const region = regionFor(api, id);
  const others = order.filter(
    (o) =>
      o.id !== id &&
      o.box.x < region.x + region.w &&
      o.box.x + o.box.w > region.x &&
      o.box.y < region.y + region.h &&
      o.box.y + o.box.h > region.y,
  );
  if (!pg) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-3 text-neutral-400">
          <span className="text-neutral-100">
            {qi >= 0
              ? `Item ${qi + 1} of ${api.queueIds.length}`
              : "Looks right, opened to check"}
          </span>
          <span>Page {b.page}</span>
          <span>{panel ? `Panel ${panel.order + 1}` : "No panel"}</span>
          <span>#{pos} in reading order</span>
          <span>{b.type.toLowerCase()}</span>
          {b.confidence !== null && (
            <span>box {Math.round(b.confidence * 100)}%</span>
          )}
          {dec && (
            <span className="text-emerald-400">
              {dec}{" "}
              <button
                type="button"
                onClick={() => api.reopen(id)}
                className="text-neutral-400 underline hover:text-white"
              >
                reopen
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={() =>
              api.setZoom(api.zoom === "panel" ? "close" : "panel")
            }
            className="ml-auto rounded border border-neutral-700 px-1.5 hover:bg-neutral-800"
          >
            {api.zoom === "panel" ? "Close on balloon" : "Whole panel"}{" "}
            <kbd className="text-neutral-500">F</kbd>
          </button>
        </div>
        <ul className="mt-1.5 space-y-0.5">
          {sigs.map((s) => (
            <li key={s.key} className="flex gap-2">
              <span
                className={`shrink-0 rounded border px-1 text-[10px] ${SIGNAL_TONE[s.key]}`}
              >
                {SIGNAL_LABEL[s.key]}
              </span>
              <span className="text-neutral-300">{s.detail}</span>
            </li>
          ))}
          {was.map((s) => (
            <li key={`was-${s.key}`} className="flex gap-2 text-neutral-500">
              <span className="shrink-0 rounded border border-neutral-800 px-1 text-[10px] line-through">
                {SIGNAL_LABEL[s.key]}
              </span>
              <span>Fixed.</span>
            </li>
          ))}
          {!sigs.length && !was.length && (
            <li className="text-neutral-500">No flags on this bubble.</li>
          )}
        </ul>
      </div>

      <Viewport page={pg} region={region} className="flex-1 bg-black p-2">
        {panel && (
          <div
            style={place(panel.box, region)}
            className="pointer-events-none border border-neutral-400/40"
          />
        )}
        {others.map((o) => {
          const isTwin = twins.includes(o.id) || parts.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              title={snippet(o.text)}
              onClick={() => api.setCursor(o.id)}
              style={place(o.box, region)}
              className={`border ${
                o.ignored
                  ? "border-dashed border-neutral-600/60"
                  : isTwin
                    ? "border-dashed border-orange-400"
                    : "border-neutral-300/40 hover:border-neutral-200"
              }`}
            />
          );
        })}
        <div
          style={place(b.box, region)}
          className="pointer-events-none border-2 border-cyan-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
        />
      </Viewport>

      {(twins.length > 0 || parts.length > 0) && (
        <div className="flex gap-2 overflow-x-auto border-t border-neutral-800 px-3 py-2">
          <span className="w-16 shrink-0 text-neutral-500">
            {twins.length ? "Duplicates" : "Parts inside"}
          </span>
          {[...twins, ...parts.filter((p) => !twins.includes(p))].map((t) => {
            const o = doc.bubbles[t];
            if (!o) return null;
            const isTwin = twins.includes(t);
            return (
              <div
                key={t}
                className="w-52 shrink-0 rounded border border-neutral-800 p-1.5"
              >
                <div className="mb-0.5 flex justify-between text-[10px] text-neutral-500">
                  <span>
                    {speakerName(api.cast, o.speaker) || "no speaker"}
                  </span>
                  <span>
                    {o.confidence !== null &&
                      `${Math.round(o.confidence * 100)}%`}
                    {doc.decided[t] ? ` · ${doc.decided[t]}` : ""}
                  </span>
                </div>
                <div className="line-clamp-2 text-neutral-300">
                  {snippet(o.text, 80)}
                </div>
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    onClick={() => api.setCursor(t)}
                    className="rounded border border-neutral-700 px-1.5 hover:bg-neutral-800"
                  >
                    Open
                  </button>
                  {isTwin && !o.ignored && (
                    <button
                      type="button"
                      onClick={() => api.dismissDuplicate(t, false)}
                      className="rounded border border-neutral-700 px-1.5 hover:bg-neutral-800"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-800 px-3 py-2">
        <Btn primary onClick={() => api.accept(id, true)} k="Enter">
          Accept
        </Btn>
        <Btn onClick={() => api.silent(id, true)} k="S">
          {b.silent ? "Unmark silent" : "Silent"}
        </Btn>
        <Btn onClick={() => api.ignore(id, true)} k="X">
          {b.ignored ? "Unignore" : "Ignore"}
        </Btn>
        {twins.length > 0 && !b.ignored && (
          <>
            <Btn onClick={() => api.dismissDuplicate(id, true)} k="D">
              Dismiss as duplicate
            </Btn>
            <Btn onClick={() => api.keepDismissTwins(id)} k="K">
              Keep this, dismiss {twins.length}
            </Btn>
          </>
        )}
        <Btn onClick={() => api.goPage(id)} k="P">
          Open in page
        </Btn>
        {api.warning && <span className="text-amber-300">{api.warning}</span>}
        <span className="ml-auto flex gap-1">
          <Btn
            onClick={() => {
              const n = api.queueIds[Math.max(qi - 1, 0)];
              if (n) api.setCursor(n);
            }}
            k="Left"
          >
            Prev
          </Btn>
          <Btn
            onClick={() => {
              const n = api.queueIds[Math.min(qi + 1, api.queueIds.length - 1)];
              if (n) api.setCursor(n);
            }}
            k="Right"
          >
            Next
          </Btn>
        </span>
      </div>
    </div>
  );
}

function MiniPage({ api, id }: { api: Api; id: string }) {
  const b = api.doc.bubbles[id]!;
  const pg = api.data.pages.find((p) => p.number === b.page);
  const panel = panelOf(b, api.doc.panels);
  if (!pg) return null;
  const full: Box = { x: 0, y: 0, w: 1, h: 1 };
  return (
    <div className="border-b border-neutral-800 p-2">
      <div className="mb-1 flex justify-between text-neutral-500">
        <span>Page {b.page}</span>
        <button
          type="button"
          onClick={() => api.goPage(id)}
          className="hover:text-white"
        >
          Open page <kbd>P</kbd>
        </button>
      </div>
      <Viewport
        page={pg}
        region={full}
        className="h-[34vh] cursor-pointer"
        onClick={() => api.goPage(id)}
      >
        {panel && (
          <div
            style={place(panel.box, full)}
            className="pointer-events-none border border-cyan-300/70"
          />
        )}
        {playOrder(api.doc, b.page).map((o) => (
          <div
            key={o.id}
            style={place(o.box, full)}
            className={`pointer-events-none ${
              o.id === id
                ? "bg-cyan-400/50 ring-1 ring-cyan-300"
                : o.ignored
                  ? ""
                  : api.queueIds.includes(o.id) && !api.doc.decided[o.id]
                    ? "border border-amber-400/70"
                    : "border border-neutral-300/30"
            }`}
          />
        ))}
      </Viewport>
    </div>
  );
}

export function Btn({
  children,
  onClick,
  k,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  k?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        primary
          ? "bg-cyan-800 text-white hover:bg-cyan-700"
          : "border border-neutral-700 text-neutral-200 hover:bg-neutral-800"
      }`}
    >
      {children}
      {k && <kbd className="ml-1.5 text-[10px] text-neutral-400">{k}</kbd>}
    </button>
  );
}
