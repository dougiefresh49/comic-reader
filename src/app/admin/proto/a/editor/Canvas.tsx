// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The page on a zoomable, pannable canvas with panel, bubble and face boxes over the art.
"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { tintFor } from "../lib";
import type { CastMember, Face, Rect, SrcPage } from "../types";
import {
  area,
  clampRect,
  type BubbleDoc,
  type Flag,
  type PanelDoc,
  type Sel,
} from "./model";

export type Tool = "select" | "draw";

export interface CanvasHandle {
  fit: () => void;
  zoomBy: (factor: number) => void;
  zoomTo: (rect: Rect) => void;
  reveal: (rect: Rect) => void;
}

interface CanvasProps {
  page: SrcPage;
  panels: PanelDoc[];
  bubbles: BubbleDoc[];
  numbers: Map<string, number>;
  flags: Map<string, Flag[]>;
  castById: Map<string, CastMember>;
  /** Faces of the panel in focus, offered as one-click speakers. */
  faces: Face[];
  sel: Sel | null;
  hover: Sel | null;
  tool: Tool;
  onSelect: (sel: Sel | null) => void;
  onHover: (sel: Sel | null) => void;
  onCommitRect: (sel: Sel, rect: Rect) => void;
  onDraw: (rect: Rect) => void;
  onPickFace: (characterId: string) => void;
  onBusy: (id: string | null) => void;
  onZoom: (zoom: number) => void;
}

interface View {
  zoom: number;
  x: number;
  y: number;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type Drag =
  | {
      kind: "pan";
      px: number;
      py: number;
      view: View;
      moved: boolean;
      /** What a click (no movement) selects. */
      click: Sel | null;
    }
  | {
      kind: "move";
      sel: Sel;
      px: number;
      py: number;
      start: Rect;
      moved: boolean;
    }
  | { kind: "resize"; sel: Sel; handle: Handle; start: Rect }
  | { kind: "draw"; fx: number; fy: number };

const HANDLES: { id: Handle; className: string }[] = [
  { id: "nw", className: "left-0 top-0 cursor-nwse-resize" },
  { id: "n", className: "left-1/2 top-0 cursor-ns-resize" },
  { id: "ne", className: "left-full top-0 cursor-nesw-resize" },
  { id: "e", className: "left-full top-1/2 cursor-ew-resize" },
  { id: "se", className: "left-full top-full cursor-nwse-resize" },
  { id: "s", className: "left-1/2 top-full cursor-ns-resize" },
  { id: "sw", className: "left-0 top-full cursor-nesw-resize" },
  { id: "w", className: "left-0 top-1/2 cursor-ew-resize" },
];

const MARGIN = 28;

function box(rect: Rect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

function flagWord(flags: Flag[] | undefined): string | null {
  const first = flags?.[0];
  if (!first) return null;
  if (first.kind === "duplicate") return "duplicate?";
  if (first.kind === "no-speaker") return "no speaker";
  if (first.kind === "unknown-speaker") return "not in cast";
  return "new";
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    page,
    panels,
    bubbles,
    numbers,
    flags,
    castById,
    faces,
    sel,
    hover,
    tool,
    onSelect,
    onHover,
    onCommitRect,
    onDraw,
    onPickFace,
    onBusy,
    onZoom,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  const fitted = useRef(true);
  const drag = useRef<Drag | null>(null);
  const [live, setLive] = useState<{ sel: Sel; rect: Rect } | null>(null);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);

  const apply = useCallback(
    (next: View) => {
      viewRef.current = next;
      setView(next);
      onZoom(next.zoom);
    },
    [onZoom],
  );

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const zoom = Math.min(
      (cw - MARGIN * 2) / page.width,
      (ch - MARGIN * 2) / page.height,
    );
    fitted.current = true;
    apply({
      zoom,
      x: (cw - page.width * zoom) / 2,
      y: (ch - page.height * zoom) / 2,
    });
  }, [apply, page.width, page.height]);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const v = viewRef.current;
      if (!v) return;
      const zoom = Math.min(3, Math.max(0.05, v.zoom * factor));
      const k = zoom / v.zoom;
      fitted.current = false;
      apply({ zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    },
    [apply],
  );

  // A new page starts fitted; a resized pane re-fits only while still fitted.
  useLayoutEffect(() => {
    fit();
  }, [fit, page.number]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (fitted.current) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // Wheel pans; with Ctrl or Cmd (a trackpad pinch) it zooms at the cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(
          Math.exp(-e.deltaY * 0.01),
          e.clientX - r.left,
          e.clientY - r.top,
        );
        return;
      }
      const v = viewRef.current;
      if (!v) return;
      fitted.current = false;
      apply({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, zoomAt]);

  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomBy: (factor) => {
        const el = containerRef.current;
        if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
      },
      zoomTo: (rect) => {
        const el = containerRef.current;
        if (!el) return;
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        const zoom = Math.min(
          3,
          (cw - MARGIN * 2) / (rect.w * page.width),
          (ch - MARGIN * 2) / (rect.h * page.height),
        );
        fitted.current = false;
        apply({
          zoom,
          x: cw / 2 - (rect.x + rect.w / 2) * page.width * zoom,
          y: ch / 2 - (rect.y + rect.h / 2) * page.height * zoom,
        });
      },
      reveal: (rect) => {
        const el = containerRef.current;
        const v = viewRef.current;
        if (!el || !v) return;
        const left = v.x + rect.x * page.width * v.zoom;
        const top = v.y + rect.y * page.height * v.zoom;
        const right = left + rect.w * page.width * v.zoom;
        const bottom = top + rect.h * page.height * v.zoom;
        const inside =
          left >= 0 &&
          top >= 0 &&
          right <= el.clientWidth &&
          bottom <= el.clientHeight;
        if (inside) return;
        fitted.current = false;
        apply({
          zoom: v.zoom,
          x: v.x + el.clientWidth / 2 - (left + right) / 2,
          y: v.y + el.clientHeight / 2 - (top + bottom) / 2,
        });
      },
    }),
    [apply, fit, zoomAt, page.width, page.height],
  );

  const frac = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return { fx: 0, fy: 0 };
    return {
      fx: (e.clientX - r.left) / r.width,
      fy: (e.clientY - r.top) / r.height,
    };
  };

  const rectOf = (s: Sel): Rect | null =>
    s.kind === "panel"
      ? (panels.find((p) => p.id === s.id)?.rect ?? null)
      : (bubbles.find((b) => b.id === s.id)?.rect ?? null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = viewRef.current;
    if (!v) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("[data-face]")) return;
    const hit = target?.closest<HTMLElement>("[data-kind]");
    const kind = hit?.dataset.kind;
    const id = hit?.dataset.id;
    const handle = target?.closest<HTMLElement>("[data-handle]")?.dataset
      .handle as Handle | undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();

    const pan = (click: Sel | null): Drag => ({
      kind: "pan",
      px: e.clientX,
      py: e.clientY,
      view: v,
      moved: false,
      click,
    });

    if (e.button === 1 || space) {
      drag.current = pan(sel);
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    if (tool === "draw") {
      const { fx, fy } = frac(e);
      drag.current = { kind: "draw", fx, fy };
      setDrawing({ x: fx, y: fy, w: 0, h: 0 });
      return;
    }
    if (handle && sel) {
      const start = rectOf(sel);
      if (start) {
        drag.current = { kind: "resize", sel, handle, start };
        onBusy(sel.id);
        return;
      }
    }
    if ((kind === "bubble" || kind === "panel") && id) {
      const hitSel: Sel = { kind, id };
      const start = rectOf(hitSel);
      const selected = sel?.kind === kind && sel.id === id;
      // A bubble moves on the first drag. A panel moves only once selected,
      // so dragging across the page pans instead of shifting a panel.
      if (start && (kind === "bubble" || selected)) {
        if (!selected) onSelect(hitSel);
        drag.current = {
          kind: "move",
          sel: hitSel,
          px: e.clientX,
          py: e.clientY,
          start,
          moved: false,
        };
        return;
      }
      drag.current = pan(hitSel);
      return;
    }
    drag.current = pan(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const v = viewRef.current;
    if (!d || !v) return;
    if (d.kind === "pan") {
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      setPanning(true);
      fitted.current = false;
      apply({ zoom: d.view.zoom, x: d.view.x + dx, y: d.view.y + dy });
      return;
    }
    if (d.kind === "draw") {
      const { fx, fy } = frac(e);
      setDrawing({
        x: Math.min(d.fx, fx),
        y: Math.min(d.fy, fy),
        w: Math.abs(fx - d.fx),
        h: Math.abs(fy - d.fy),
      });
      return;
    }
    if (d.kind === "move") {
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) onBusy(d.sel.id);
      d.moved = true;
      setLive({
        sel: d.sel,
        rect: clampRect({
          ...d.start,
          x: d.start.x + dx / (page.width * v.zoom),
          y: d.start.y + dy / (page.height * v.zoom),
        }),
      });
      return;
    }
    const { fx, fy } = frac(e);
    let left = d.start.x;
    let top = d.start.y;
    let right = d.start.x + d.start.w;
    let bottom = d.start.y + d.start.h;
    if (d.handle.includes("w")) left = Math.min(fx, right - 0.01);
    if (d.handle.includes("e")) right = Math.max(fx, left + 0.01);
    if (d.handle.includes("n")) top = Math.min(fy, bottom - 0.008);
    if (d.handle.includes("s")) bottom = Math.max(fy, top + 0.008);
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(1, right);
    bottom = Math.min(1, bottom);
    setLive({
      sel: d.sel,
      rect: { x: left, y: top, w: right - left, h: bottom - top },
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === "pan") {
      if (!d.moved) onSelect(d.click);
      return;
    }
    if (d.kind === "draw") {
      const rect = drawing;
      setDrawing(null);
      if (rect && rect.w > 0.01 && rect.h > 0.008) onDraw(clampRect(rect));
      return;
    }
    onBusy(null);
    const rect = live?.rect;
    setLive(null);
    if (rect && (d.kind === "resize" || d.moved)) onCommitRect(d.sel, rect);
  };

  const zoom = view?.zoom ?? 0;
  const named = page.width * zoom >= 640;
  const liveRect = (s: Sel, rect: Rect) =>
    live && live.sel.kind === s.kind && live.sel.id === s.id ? live.rect : rect;
  const isSel = (kind: Sel["kind"], id: string) =>
    sel?.kind === kind && sel.id === id;
  const isHover = (kind: Sel["kind"], id: string) =>
    hover?.kind === kind && hover.id === id;

  // Small boxes paint last so a balloon inside a bigger box stays clickable.
  const painted = bubbles.slice().sort((a, b) => area(b.rect) - area(a.rect));
  const selRect = sel ? rectOf(sel) : null;

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full touch-none overflow-hidden bg-neutral-900 select-none ${
        tool === "draw"
          ? "cursor-crosshair"
          : panning
            ? "cursor-grabbing"
            : space
              ? "cursor-grab"
              : "cursor-default"
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => onHover(null)}
    >
      {view && (
        <div
          ref={stageRef}
          className="absolute bg-neutral-800 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
          style={{
            left: view.x,
            top: view.y,
            width: page.width * view.zoom,
            height: page.height * view.zoom,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={page.imageUrl}
            src={page.imageUrl}
            alt={`Page ${page.number}`}
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />

          {panels.map((p, i) => {
            const selected = isSel("panel", p.id);
            const hovered = isHover("panel", p.id);
            return (
              <div
                key={p.id}
                data-kind="panel"
                data-id={p.id}
                onPointerEnter={() => onHover({ kind: "panel", id: p.id })}
                onPointerLeave={() => onHover(null)}
                className={`absolute border ${
                  selected
                    ? "border-white bg-white/5"
                    : hovered
                      ? "border-neutral-200"
                      : "border-dashed border-neutral-400/50"
                }`}
                style={box(liveRect({ kind: "panel", id: p.id }, p.rect))}
              >
                <span
                  className={`absolute top-0 left-0 px-1 text-[10px] leading-4 font-medium ${
                    selected
                      ? "bg-white text-neutral-950"
                      : "bg-neutral-950/80 text-neutral-300"
                  }`}
                >
                  Panel {i + 1}
                </span>
              </div>
            );
          })}

          {faces.map((f) => {
            const member = f.characterId
              ? castById.get(f.characterId)
              : undefined;
            if (!member) return null;
            return (
              <div
                key={f.id}
                className="pointer-events-none absolute border border-dotted border-white/40"
                style={box(f.rect)}
              >
                <button
                  type="button"
                  data-face
                  tabIndex={-1}
                  title={`Set speaker to ${member.name}`}
                  onClick={() => onPickFace(member.id)}
                  className="pointer-events-auto absolute bottom-full left-0 cursor-pointer bg-neutral-950/85 px-1 text-[10px] leading-4 whitespace-nowrap text-neutral-200 hover:bg-white hover:text-neutral-950"
                >
                  {member.name}
                </button>
              </div>
            );
          })}

          {painted.map((b) => {
            const selected = isSel("bubble", b.id);
            const hovered = isHover("bubble", b.id);
            const f = flags.get(b.id);
            const word = flagWord(f);
            const member = b.speakerId ? castById.get(b.speakerId) : undefined;
            const tint = tintFor(member);
            const tone = b.ignored
              ? "border-dashed border-neutral-500/70"
              : word
                ? `border-amber-400 bg-amber-400/15 ${
                    f?.[0]?.kind === "duplicate" || f?.[0]?.kind === "proposal"
                      ? "border-dashed"
                      : ""
                  }`
                : tint.border;
            const showName = named || selected || hovered;
            return (
              <div
                key={b.id}
                data-kind="bubble"
                data-id={b.id}
                onPointerEnter={() => onHover({ kind: "bubble", id: b.id })}
                onPointerLeave={() => onHover(null)}
                className={`absolute border-[1.5px] ${tone} ${
                  selected
                    ? "z-20 outline-2 outline-offset-1 outline-white"
                    : hovered
                      ? "z-10 bg-white/10"
                      : ""
                }`}
                style={box(liveRect({ kind: "bubble", id: b.id }, b.rect))}
              >
                <span
                  className={`pointer-events-none absolute bottom-full left-0 mb-px flex items-center gap-1 px-1 text-[10px] leading-4 whitespace-nowrap ${
                    word && !b.ignored
                      ? "bg-amber-400 font-medium text-neutral-950"
                      : selected
                        ? "bg-white font-medium text-neutral-950"
                        : "bg-neutral-950/85 text-neutral-200"
                  }`}
                >
                  <span className="tabular-nums">{numbers.get(b.id)}</span>
                  {showName && (
                    <span>
                      {b.ignored
                        ? "ignored"
                        : (word ??
                          (b.silent
                            ? "silent"
                            : (member?.name ?? b.type.toLowerCase())))}
                    </span>
                  )}
                </span>
              </div>
            );
          })}

          {drawing && (
            <div
              className="pointer-events-none absolute border-[1.5px] border-dashed border-white bg-white/10"
              style={box(drawing)}
            />
          )}

          {sel && selRect && tool === "select" && (
            <div
              className="pointer-events-none absolute z-30"
              style={box(liveRect(sel, selRect))}
            >
              {HANDLES.map((h) => (
                <span
                  key={h.id}
                  data-handle={h.id}
                  className={`pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 border border-neutral-950 bg-white ${h.className}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
