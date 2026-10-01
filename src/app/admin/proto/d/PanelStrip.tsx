// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useRef, useState } from "react";
import { PageArt } from "./PageArt";
import { rectInFrame, RESIZE_HANDLES, useBoxDrag } from "./BoxFrame";
import type { ClipData, PageData, PanelData, Problem, Rect } from "./data";

const TALL = 360;
const SHORT = 132;

export interface PendingBox {
  panelId: string;
  rect: Rect;
}

/**
 * The top strip: every panel of the page, in reading order, left to right,
 * each cropped out of the page art with its bubbles' boxes drawn on it. The
 * panel the playhead is inside is the enlarged one, and it is also where a
 * new bubble's box is drawn.
 */
export function PanelStrip({
  page,
  panels,
  clips,
  selectedPanelId,
  enlargedPanelId,
  selectedClipId,
  problems,
  drawMode,
  onSelectPanel,
  onSelectClip,
  onMoveClipBox,
  onDrawnBox,
  onToggleDrawMode,
}: {
  page: PageData;
  panels: PanelData[];
  clips: ClipData[];
  selectedPanelId: string | null;
  enlargedPanelId: string | null;
  selectedClipId: string | null;
  problems: Record<string, Problem | null>;
  drawMode: boolean;
  onSelectPanel: (id: string) => void;
  onSelectClip: (id: string) => void;
  onMoveClipBox: (id: string, rect: Rect) => void;
  onDrawnBox: (pending: PendingBox) => void;
  onToggleDrawMode: () => void;
}) {
  const drag = useBoxDrag();
  // panel id -> the element that box occupies on screen. A resize drags from a
  // corner handle, so the scale has to come from the panel behind it.
  const panelHosts = useRef(new Map<string, HTMLDivElement | null>());

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] tracking-wide text-neutral-500 uppercase">
          Page {page.number} — panels in reading order
        </span>
        <button
          type="button"
          onClick={onToggleDrawMode}
          className={`rounded border px-2 py-0.5 text-[11px] ${
            drawMode
              ? "border-emerald-600 bg-emerald-950 text-emerald-300"
              : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {drawMode
            ? "Drawing — drag on the enlarged panel"
            : "Draw bubble (d)"}
        </button>
      </div>

      <div className="flex items-end gap-0 overflow-x-auto px-3 pb-3">
        {panels.map((panel, index) => {
          const enlarged = panel.id === enlargedPanelId;
          const height = enlarged ? TALL : SHORT;
          const aspect =
            (panel.box.w * page.width) / (panel.box.h * page.height);
          const width = Math.max(56, Math.round(height * aspect));
          const panelClips = clips.filter((c) => c.panelId === panel.id);
          const clipCount = panelClips.length;

          return (
            <div key={panel.id} className="flex shrink-0 items-end">
              {index > 0 && (
                <div className="mx-1 h-full w-px self-stretch border-l border-dashed border-neutral-700" />
              )}
              <div className="flex flex-col items-center gap-1">
                <div
                  ref={(el) => {
                    panelHosts.current.set(panel.id, el);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Panel ${index + 1}, ${clipCount} bubbles`}
                  onClick={() => onSelectPanel(panel.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectPanel(panel.id);
                    }
                  }}
                  className={`relative shrink-0 cursor-pointer ring-offset-2 ring-offset-neutral-950 ${
                    selectedPanelId === panel.id
                      ? "ring-2 ring-sky-500"
                      : enlarged
                        ? "ring-1 ring-emerald-600/70"
                        : "ring-1 ring-neutral-700 hover:ring-neutral-500"
                  }`}
                  style={{ width, height }}
                >
                  <PageArt
                    src={page.imageUrl}
                    frame={panel.box}
                    alt=""
                    className="absolute inset-0"
                  />

                  {/* Dashed panel boundary, as on the owner's sketch. */}
                  <div className="pointer-events-none absolute inset-0 border border-dashed border-neutral-500/40" />

                  {drawMode && enlarged && (
                    <DrawSurface
                      frame={panel.box}
                      onDrawn={(rect) =>
                        onDrawnBox({ panelId: panel.id, rect })
                      }
                    />
                  )}

                  {panelClips.map((clip) => {
                    if (!clip.box) return null;
                    const style = rectInFrame(clip.box, panel.box);
                    const isSelected = clip.id === selectedClipId;
                    const problem = problems[clip.id];
                    return (
                      <div
                        key={clip.id}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectClip(clip.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onSelectClip(clip.id);
                          }
                        }}
                        onPointerDown={(e) => {
                          if (drawMode) return;
                          e.stopPropagation();
                          onSelectClip(clip.id);
                          drag.onPointerDown(
                            e,
                            clip.box!,
                            panel.box,
                            (next) => onMoveClipBox(clip.id, next),
                            "move",
                            panelHosts.current.get(panel.id) ?? null,
                          );
                        }}
                        onPointerMove={(e) =>
                          drag.onPointerMove(e, panel.box, (next) =>
                            onMoveClipBox(clip.id, next),
                          )
                        }
                        onPointerUp={drag.onPointerUp}
                        title={clip.text}
                        className={`absolute cursor-move ${
                          isSelected
                            ? "z-20 border-emerald-400 bg-emerald-400/10"
                            : problem
                              ? "z-10 border-amber-500/80 bg-amber-500/10"
                              : "z-10 border-neutral-400/60 bg-neutral-400/5 hover:border-neutral-200"
                        }`}
                        style={{
                          left: `${style.left}%`,
                          top: `${style.top}%`,
                          width: `${style.width}%`,
                          height: `${style.height}%`,
                          borderWidth: 1.5,
                          borderStyle: "solid",
                        }}
                      >
                        {isSelected &&
                          RESIZE_HANDLES.map((handle) => (
                            <span
                              key={handle}
                              onPointerDown={(e) =>
                                drag.onPointerDown(
                                  e,
                                  clip.box!,
                                  panel.box,
                                  (next) => onMoveClipBox(clip.id, next),
                                  handle,
                                  panelHosts.current.get(panel.id) ?? null,
                                )
                              }
                              onPointerMove={(e) =>
                                drag.onPointerMove(e, panel.box, (next) =>
                                  onMoveClipBox(clip.id, next),
                                )
                              }
                              onPointerUp={drag.onPointerUp}
                              className="absolute size-2 rounded-[1px] border border-neutral-950 bg-emerald-300"
                              style={{
                                left: handle.includes("w") ? 0 : undefined,
                                right: handle.includes("e") ? 0 : undefined,
                                top: handle.includes("n") ? 0 : undefined,
                                bottom: handle.includes("s") ? 0 : undefined,
                              }}
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
                <span className="text-[10px] text-neutral-500">
                  {index + 1} · {clipCount}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Drag anywhere on the enlarged panel to lay down a new bubble's box. */
function DrawSurface({
  frame,
  onDrawn,
}: {
  frame: Rect;
  onDrawn: (rect: Rect) => void;
}) {
  const [draft, setDraft] = useState<Rect | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<Rect | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const toPage = (clientX: number, clientY: number) => {
    const host = hostRef.current?.getBoundingClientRect();
    if (!host) return { x: 0, y: 0 };
    return {
      x: frame.x + ((clientX - host.left) / host.width) * frame.w,
      y: frame.y + ((clientY - host.top) / host.height) * frame.h,
    };
  };

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 z-30 cursor-crosshair bg-emerald-500/5"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        originRef.current = toPage(e.clientX, e.clientY);
        const start: Rect = {
          x: originRef.current.x,
          y: originRef.current.y,
          w: 0,
          h: 0,
        };
        draftRef.current = start;
        setDraft(start);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!originRef.current) return;
        const now = toPage(e.clientX, e.clientY);
        const o = originRef.current;
        const next: Rect = {
          x: Math.min(o.x, now.x),
          y: Math.min(o.y, now.y),
          w: Math.abs(now.x - o.x),
          h: Math.abs(now.y - o.y),
        };
        draftRef.current = next;
        setDraft(next);
      }}
      onPointerUp={(e) => {
        const target = e.currentTarget as Element;
        if (target.hasPointerCapture(e.pointerId)) {
          target.releasePointerCapture(e.pointerId);
        }
        originRef.current = null;
        // Read the draft from a ref, not from a setState updater: an updater
        // runs during the next render, and committing the new bubble from
        // inside one sets state on the parent mid-render.
        const drawn = draftRef.current;
        setDraft(null);
        if (drawn && drawn.w > 0.01 && drawn.h > 0.01) onDrawn(drawn);
      }}
    >
      {draft && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-emerald-400"
          style={rectInFrame(draft, frame)}
        />
      )}
    </div>
  );
}
