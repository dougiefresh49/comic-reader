// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useEffect, useRef, useState } from "react";
import { speakerColor } from "./data";
import type { ClipData, Problem } from "./data";

/** Clip width from the length of its text, so the lane reads as a reel. */
function clipWidth(text: string): number {
  const len = text.trim().length;
  if (len === 0) return 96;
  return Math.max(96, Math.min(420, 44 + len * 6.1));
}

export interface LaneGroup {
  panelId: string | null;
  label: string;
  clips: ClipData[];
}

export function ClipLane({
  groups,
  playheadId,
  selectedId,
  problems,
  needsCount,
  onSelect,
  onStepPlayhead,
  onJumpToProblem,
  onReorder,
  onMoveToPanel,
}: {
  groups: LaneGroup[];
  playheadId: string | null;
  selectedId: string | null;
  problems: Record<string, Problem | null>;
  needsCount: number;
  onSelect: (id: string) => void;
  onStepPlayhead: (delta: number) => void;
  onJumpToProblem: () => void;
  onReorder: (clipId: string, targetId: string) => void;
  onMoveToPanel: (clipId: string, panelId: string) => void;
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [dropHint, setDropHint] = useState<{
    clip: string;
    after: boolean;
  } | null>(null);
  const draggingRef = useRef<string | null>(null);

  // Keep the clip under the playhead in view as the arrow keys walk the lane.
  useEffect(() => {
    if (!playheadId || !laneRef.current) return;
    const el = laneRef.current.querySelector<HTMLElement>(
      `[data-clip-id="${CSS.escape(playheadId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [playheadId]);

  const laneWidth =
    groups.reduce((sum, g) => sum + g.clips.length, 0) > 0 ? undefined : "100%";

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] tracking-wide text-neutral-500 uppercase">
          Clip lane — playback order
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStepPlayhead(-1)}
            aria-label="Previous clip"
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => onStepPlayhead(1)}
            aria-label="Next clip"
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            ▶
          </button>
          <span
            className={`text-[11px] ${needsCount > 0 ? "text-amber-400" : "text-neutral-500"}`}
          >
            {needsCount > 0 ? `${needsCount} need you (n)` : "none flagged"}
          </span>
          <button
            type="button"
            onClick={onJumpToProblem}
            disabled={needsCount === 0}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
          >
            Next problem
          </button>
        </div>
      </div>

      <div
        ref={laneRef}
        style={{ minHeight: 62 }}
        className="relative flex items-stretch gap-0 overflow-x-auto pb-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const clipId = e.dataTransfer.getData("text/clip-id");
          const targetId = e.dataTransfer.getData("text/target-clip-id");
          const panelId = e.dataTransfer.getData("text/panel-id");
          setDropHint(null);
          if (clipId && targetId) onReorder(clipId, targetId);
          else if (clipId && panelId) onMoveToPanel(clipId, panelId);
        }}
      >
        {/* The playhead: a green line that rides the lane as it is scrubbed. */}
        {playheadId && <Playhead playheadId={playheadId} laneRef={laneRef} />}

        {groups.map((group) => (
          <div
            key={group.panelId ?? "none"}
            onDragOver={(e) => {
              if (!draggingRef.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              const clipId = e.dataTransfer.getData("text/clip-id");
              const targetId = e.dataTransfer.getData("text/target-clip-id");
              if (clipId && !targetId && group.panelId) {
                e.preventDefault();
                onMoveToPanel(clipId, group.panelId);
              }
            }}
            className="flex shrink-0 flex-col justify-center border-l-2 border-dashed border-neutral-700/70 px-1.5 first:border-l-0"
          >
            <span className="mb-1 text-[9px] tracking-wider text-neutral-600 uppercase">
              {group.label}
            </span>
            <div className="flex items-stretch gap-1">
              {group.clips.map((clip) => (
                <Clip
                  key={clip.id}
                  clip={clip}
                  isPlayhead={clip.id === playheadId}
                  isSelected={clip.id === selectedId}
                  problem={problems[clip.id] ?? null}
                  showHint={dropHint?.clip === clip.id ? dropHint.after : null}
                  onSelect={onSelect}
                  onDragStart={(e) => {
                    draggingRef.current = clip.id;
                    e.dataTransfer.setData("text/clip-id", clip.id);
                    if (group.panelId) {
                      e.dataTransfer.setData("text/panel-id", group.panelId);
                    }
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    draggingRef.current = null;
                    setDropHint(null);
                  }}
                  onDragOverClip={(after) =>
                    setDropHint({ clip: clip.id, after })
                  }
                  onDropOnClip={(targetId) => {
                    const clipId = draggingRef.current;
                    if (clipId && clipId !== targetId) {
                      onReorder(clipId, targetId);
                    }
                    setDropHint(null);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        {laneWidth === "100%" && (
          <span className="self-center pl-2 text-[11px] text-neutral-600">
            no clips on this page yet
          </span>
        )}
      </div>

      {/* The second lane. Named, empty, and honest about doing nothing yet. */}
      <div className="mt-2 flex items-center gap-2 border-t border-dashed border-neutral-800 pt-2">
        <span className="w-24 shrink-0 text-[10px] tracking-widest text-neutral-600 uppercase">
          Audio track
        </span>
        <div className="h-8 flex-1 rounded border border-dashed border-neutral-800 bg-neutral-900/60" />
        <span className="shrink-0 text-[10px] text-neutral-600">
          future music track — not built, does nothing yet
        </span>
      </div>
    </div>
  );
}

function Playhead({
  playheadId,
  laneRef,
}: {
  playheadId: string;
  laneRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const lane = laneRef.current;
      const el = lane?.querySelector<HTMLElement>(
        `[data-clip-id="${CSS.escape(playheadId)}"]`,
      );
      if (!lane || !el) return;
      setLeft(el.offsetLeft - lane.scrollLeft);
    };
    measure();
    const lane = laneRef.current;
    lane?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      lane?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [playheadId, laneRef]);

  if (left === null) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-30 w-0.5 bg-emerald-400"
      style={{ left: `${left}px`, height: "100%" }}
    >
      <span className="absolute -top-1 -left-[3px] size-1.5 rotate-45 bg-emerald-400" />
    </div>
  );
}

function Clip({
  clip,
  isPlayhead,
  isSelected,
  problem,
  showHint,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOverClip,
  onDropOnClip,
}: {
  clip: ClipData;
  isPlayhead: boolean;
  isSelected: boolean;
  problem: Problem | null;
  showHint: boolean | null;
  onSelect: (id: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOverClip: (after: boolean) => void;
  onDropOnClip: (targetId: string) => void;
}) {
  const width = clipWidth(clip.text);
  const flagged = problem !== null;
  return (
    <div
      data-clip-id={clip.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOverClip(e.clientX > rect.left + rect.width / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.setData("text/target-clip-id", clip.id);
        onDropOnClip(clip.id);
      }}
      onClick={() => onSelect(clip.id)}
      title={clip.text || "(no text)"}
      className={`group relative flex shrink-0 cursor-grab flex-col justify-center overflow-hidden rounded border px-1.5 py-1 ${
        isSelected
          ? "border-neutral-100 ring-1 ring-neutral-100"
          : flagged
            ? "border-amber-500/70"
            : "border-neutral-700/70 hover:border-neutral-400"
      } ${isPlayhead ? "brightness-125" : ""} ${clip.ignored ? "opacity-45" : ""}`}
      style={{
        width,
        height: 46,
        backgroundColor: speakerColor(clip.speaker),
      }}
    >
      <span className="truncate text-[10px] leading-tight text-neutral-50">
        {clip.text || "(no text)"}
      </span>
      <span className="truncate text-[9px] leading-tight text-neutral-200/80">
        {clip.speaker ?? "—"}
        {clip.emotion ? ` · ${clip.emotion}` : ""}
      </span>

      {clip.isNew && (
        <span className="absolute top-0 left-0 bg-sky-600 px-1 text-[8px] tracking-wider text-white uppercase">
          new
        </span>
      )}
      {clip.silent && (
        <span className="absolute right-0 bottom-0 bg-neutral-800 px-1 text-[8px] tracking-wider text-neutral-300 uppercase">
          silent
        </span>
      )}
      {flagged && (
        <span
          title={problem.label}
          className="absolute -top-1 -right-1 size-2.5 rounded-full border border-neutral-900 bg-amber-400"
        />
      )}
      {showHint !== null && (
        <span
          className={`absolute top-0 bottom-0 w-0.5 bg-emerald-400 ${
            showHint ? "right-0" : "left-0"
          }`}
        />
      )}
    </div>
  );
}
