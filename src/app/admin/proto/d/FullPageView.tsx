// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useRef } from "react";
import { PageArt } from "./PageArt";
import { rectInFrame, RESIZE_HANDLES, useBoxDrag } from "./BoxFrame";
import type { ClipData, PageData, PanelData, Rect } from "./data";

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * The whole page at once, one click from the lane, for the things a strip of
 * cropped panels cannot show: reading order across panel gaps, a box that
 * sits outside every panel, and panel boxes being moved or resized.
 */
export function FullPageView({
  page,
  panels,
  clips,
  selectedPanelId,
  selectedClipId,
  problems,
  onSelectPanel,
  onSelectClip,
  onMovePanelBox,
  onMoveClipBox,
}: {
  page: PageData;
  panels: PanelData[];
  clips: ClipData[];
  selectedPanelId: string | null;
  selectedClipId: string | null;
  problems: Record<string, { kind: string; label: string } | null>;
  onSelectPanel: (id: string) => void;
  onSelectClip: (id: string) => void;
  onMovePanelBox: (id: string, rect: Rect) => void;
  onMoveClipBox: (id: string, rect: Rect) => void;
}) {
  const drag = useBoxDrag();
  // The page-sized box the frame occupies on screen; drags scale against it.
  const hostRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-neutral-950 p-4">
      <div
        ref={hostRef}
        className="relative shrink"
        style={{
          aspectRatio: `${page.width} / ${page.height}`,
          height: "100%",
          maxWidth: "100%",
        }}
      >
        <PageArt
          src={page.imageUrl}
          frame={FULL}
          alt=""
          className="absolute inset-0"
        />

        {panels.map((panel, index) => {
          const style = rectInFrame(panel.box, FULL);
          const isSelected = panel.id === selectedPanelId;
          return (
            <div
              key={panel.id}
              role="button"
              tabIndex={0}
              aria-label={`Panel ${index + 1}`}
              onClick={() => onSelectPanel(panel.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectPanel(panel.id);
                }
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectPanel(panel.id);
                // Shift-drag resizes the panel, plain drag moves it: the
                // owner's note is that resizing a panel never worked for him,
                // so both are on the same visible box.
                drag.onPointerDown(
                  e,
                  panel.box,
                  FULL,
                  (next) => onMovePanelBox(panel.id, next),
                  e.shiftKey ? "se" : "move",
                  hostRef.current,
                );
              }}
              onPointerMove={(e) =>
                drag.onPointerMove(e, FULL, (next) =>
                  onMovePanelBox(panel.id, next),
                )
              }
              onPointerUp={drag.onPointerUp}
              title={`Panel ${index + 1} — shift-drag to resize`}
              className={`absolute cursor-move border ${
                isSelected
                  ? "border-emerald-400"
                  : "border-dashed border-emerald-500/50"
              }`}
              style={{
                left: `${style.left}%`,
                top: `${style.top}%`,
                width: `${style.width}%`,
                height: `${style.height}%`,
              }}
            >
              <span className="absolute top-0 left-0 bg-emerald-900/80 px-1 text-[9px] text-emerald-200">
                {index + 1}
              </span>
              {isSelected &&
                RESIZE_HANDLES.map((handle) => (
                  <span
                    key={handle}
                    onPointerDown={(e) =>
                      drag.onPointerDown(
                        e,
                        panel.box,
                        FULL,
                        (next) => onMovePanelBox(panel.id, next),
                        handle,
                        hostRef.current,
                      )
                    }
                    onPointerMove={(e) =>
                      drag.onPointerMove(e, FULL, (next) =>
                        onMovePanelBox(panel.id, next),
                      )
                    }
                    onPointerUp={drag.onPointerUp}
                    className="absolute size-2.5 border border-neutral-950 bg-emerald-300"
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

        {clips.map((clip) => {
          if (!clip.box) return null;
          const style = rectInFrame(clip.box, FULL);
          const isSelected = clip.id === selectedClipId;
          const problem = problems[clip.id];
          return (
            <div
              key={clip.id}
              role="button"
              tabIndex={0}
              aria-label={clip.text || "bubble"}
              title={clip.text}
              onClick={(e) => {
                e.stopPropagation();
                onSelectClip(clip.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectClip(clip.id);
                }
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectClip(clip.id);
                drag.onPointerDown(
                  e,
                  clip.box!,
                  FULL,
                  (next) => onMoveClipBox(clip.id, next),
                  "move",
                  hostRef.current,
                );
              }}
              onPointerMove={(e) =>
                drag.onPointerMove(e, FULL, (next) =>
                  onMoveClipBox(clip.id, next),
                )
              }
              onPointerUp={drag.onPointerUp}
              className={`absolute cursor-move ${
                isSelected
                  ? "z-20 border-emerald-400 bg-emerald-400/10"
                  : problem
                    ? "z-10 border-amber-500/80 bg-amber-500/10"
                    : "z-10 border-neutral-400/50 hover:border-neutral-200"
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
                        FULL,
                        (next) => onMoveClipBox(clip.id, next),
                        handle,
                        hostRef.current,
                      )
                    }
                    onPointerMove={(e) =>
                      drag.onPointerMove(e, FULL, (next) =>
                        onMoveClipBox(clip.id, next),
                      )
                    }
                    onPointerUp={drag.onPointerUp}
                    className="absolute size-3 rounded-sm border border-neutral-950 bg-emerald-300"
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
    </div>
  );
}
