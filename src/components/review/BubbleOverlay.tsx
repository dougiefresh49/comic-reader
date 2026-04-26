"use client";

import type { LocalBubble } from "~/hooks/useReviewEdits";
import type { BubbleBounds } from "~/hooks/useReviewEdits";
import { BoundsEditor } from "./BoundsEditor";

interface BubbleOverlayProps {
  bubbles: LocalBubble[];
  selectedBubbleId: string | null;
  redoSet: Set<string>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onBoundsChange: (id: string, bounds: BubbleBounds) => void;
}

function bubbleClass(bubble: LocalBubble, isSelected: boolean): string {
  const base = "absolute transition-colors duration-100";

  if (isSelected) {
    return `${base} border-2 border-cyan-400 shadow-[0_0_0_2px_rgba(34,211,238,0.4)] z-10`;
  }

  if (bubble._status === "deleted") {
    return `${base} border border-red-500/40 bg-red-500/10 opacity-40`;
  }

  if (bubble._status === "redo") {
    return `${base} border-2 border-red-500 bg-red-500/10 cursor-pointer hover:bg-red-500/20`;
  }

  if (bubble._status === "modified" || bubble._status === "new") {
    return `${base} border border-amber-400/70 bg-amber-400/10 cursor-pointer hover:bg-amber-400/20`;
  }

  // default
  return `${base} border border-white/20 bg-white/5 cursor-pointer hover:border-white/50 hover:bg-white/10`;
}

export function BubbleOverlay({
  bubbles,
  selectedBubbleId,
  redoSet,
  containerRef,
  onSelect,
  onBoundsChange,
}: BubbleOverlayProps) {
  return (
    <>
      {bubbles.map((bubble) => {
        if (!bubble.style) return null;
        if (bubble._status === "deleted") return null;

        const isSelected = bubble.id === selectedBubbleId;
        const isRedo = redoSet.has(bubble.id);
        const displayBubble: LocalBubble = isRedo
          ? { ...bubble, _status: "redo" }
          : bubble;

        return (
          <div
            key={bubble.id}
            className={bubbleClass(displayBubble, isSelected)}
            style={{
              left: bubble.style.left,
              top: bubble.style.top,
              width: bubble.style.width,
              height: bubble.style.height,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(bubble.id);
            }}
            aria-label={`Bubble ${bubble.id}`}
          >
            {isSelected && bubble.style && (
              <BoundsEditor
                style={bubble.style}
                containerRef={containerRef}
                onBoundsChange={(bounds) => onBoundsChange(bubble.id, bounds)}
                onBodyDragStart={() => onSelect(bubble.id)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
