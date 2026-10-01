// THROWAWAY prototype for issue #325.
"use client";
import { useRef, useState, type PointerEvent } from "react";
import { needsAttention, type Box, type ScriptPage } from "./types";

type Gesture = {
  id: string;
  panel: boolean;
  mode: "move" | "resize" | "draw";
  x: number;
  y: number;
  box: Box;
  moved: boolean;
};
const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

export function PageCanvas({
  page,
  selected,
  cast,
  drawing,
  zoom,
  select,
  onBox,
  onStart,
  onAdd,
}: {
  page: ScriptPage;
  selected: string;
  cast: string[];
  drawing: boolean;
  zoom: number;
  select: (id: string, focus?: boolean) => void;
  onBox: (id: string, box: Box, panel: boolean) => void;
  onStart: () => void;
  onAdd: (box: Box) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Box | null>(null);
  function point(e: PointerEvent) {
    const rect = surface.current!.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
    };
  }
  function start(e: PointerEvent, id = "", panel = false, resize = false) {
    if (e.button !== 0) return;
    if (!drawing && !id) return;
    e.preventDefault();
    e.stopPropagation();
    const p = point(e);
    const box = panel
      ? page.panels.find((b) => b.id === id)?.box
      : page.bubbles.find((b) => b.id === id)?.box;
    gesture.current = {
      id,
      panel,
      x: p.x,
      y: p.y,
      box: box ?? { x: p.x, y: p.y, w: 0, h: 0 },
      mode: drawing ? "draw" : resize ? "resize" : "move",
      moved: false,
    };
    if (!drawing) {
      select(id);
    }
    surface.current!.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const p = point(e),
      dx = p.x - g.x,
      dy = p.y - g.y;
    const firstMove = !g.moved;
    if (Math.abs(dx) + Math.abs(dy) > 0.003) g.moved = true;
    if (g.mode === "draw") {
      setPreview({
        x: Math.min(g.x, p.x),
        y: Math.min(g.y, p.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
      return;
    }
    const box =
      g.mode === "move"
        ? {
            ...g.box,
            x: clamp(g.box.x + dx, 0, 1 - g.box.w),
            y: clamp(g.box.y + dy, 0, 1 - g.box.h),
          }
        : {
            ...g.box,
            w: clamp(g.box.w + dx, 0.015, 1 - g.box.x),
            h: clamp(g.box.h + dy, 0.015, 1 - g.box.y),
          };
    if (g.moved) {
      if (firstMove) onStart();
      onBox(g.id, box, g.panel);
    }
  }
  function finish() {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "draw" && preview && preview.w > 0.01 && preview.h > 0.01)
      onAdd(preview);
    else if (g.id && !g.moved) select(g.id, !g.panel);
    gesture.current = null;
    setPreview(null);
  }
  const position = (box: Box) => ({
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  });
  return (
    <div className="flex min-h-full justify-center p-5">
      <div
        ref={surface}
        className={`relative h-fit shrink-0 touch-none select-none ${drawing ? "cursor-crosshair" : ""}`}
        style={{
          width:
            zoom === 1
              ? `min(100%, calc((100vh - 208px) * ${page.width / page.height}))`
              : `${zoom * 82}%`,
        }}
        onPointerDown={(e) => start(e)}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={() => {
          gesture.current = null;
          setPreview(null);
        }}
      >
        {/* Art is read from Storage and is never committed to the prototype. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={page.image}
          alt={`Comic page ${page.number}`}
          draggable={false}
          className="block w-full"
          style={{ aspectRatio: `${page.width}/${page.height}` }}
        />
        {page.panels.map((p, i) => (
          <button
            type="button"
            key={p.id}
            aria-label={`Panel ${i + 1} box`}
            data-box={p.id}
            className={`absolute border-2 text-left ${selected === p.id ? "z-20 border-sky-400 bg-sky-400/5" : "border-neutral-400/70"}`}
            style={position(p.box)}
            onPointerDown={(e) => start(e, p.id, true)}
            onClick={(e) => {
              if (e.detail === 0) select(p.id);
            }}
          >
            <span
              className={`absolute -top-5 -left-0.5 px-1 font-mono text-[10px] ${selected === p.id ? "bg-sky-400 text-neutral-950" : "bg-neutral-800 text-white"}`}
            >
              P{i + 1}
            </span>
            {selected === p.id && (
              <span
                role="presentation"
                onPointerDown={(e) => start(e, p.id, true, true)}
                className="absolute -right-2 -bottom-2 h-4 w-4 cursor-se-resize border-2 border-neutral-950 bg-sky-400"
              />
            )}
          </button>
        ))}
        {page.bubbles
          .filter((b) => !b.ignored)
          .map((b) => (
            <button
              type="button"
              key={b.id}
              data-box={b.id}
              aria-label={`Bubble ${page.bubbles.findIndex((item) => item.id === b.id) + 1} box`}
              className={`absolute z-10 border-2 ${selected === b.id ? "z-30 border-sky-400 bg-sky-400/10" : needsAttention(b, page, cast) ? "border-amber-500/90" : "border-white/80"}`}
              style={position(b.box)}
              onPointerDown={(e) => start(e, b.id)}
              onClick={(e) => {
                if (e.detail === 0) select(b.id, true);
              }}
            >
              <span
                className={`absolute -top-4 -left-0.5 px-1 font-mono text-[10px] ${selected === b.id ? "bg-sky-400 text-neutral-950" : "bg-neutral-900 text-white"}`}
              >
                {page.bubbles.findIndex((item) => item.id === b.id) + 1}
              </span>
              {selected === b.id && (
                <span
                  role="presentation"
                  onPointerDown={(e) => start(e, b.id, false, true)}
                  className="absolute -right-2 -bottom-2 h-4 w-4 cursor-se-resize border-2 border-neutral-950 bg-sky-400"
                />
              )}
            </button>
          ))}
        {preview && (
          <div
            className="pointer-events-none absolute z-40 border-2 border-sky-400 bg-sky-400/20"
            style={position(preview)}
          />
        )}
        {drawing && (
          <div className="pointer-events-none absolute inset-0 z-40 border border-sky-400" />
        )}
      </div>
    </div>
  );
}
