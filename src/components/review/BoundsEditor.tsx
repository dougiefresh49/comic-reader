"use client";

import { useBoundsEditor } from "~/hooks/useBoundsEditor";
import type { HandleType } from "~/hooks/useBoundsEditor";
import type { BubbleBounds } from "~/hooks/useReviewEdits";

interface BoundsEditorProps {
  style: { left: string; top: string; width: string; height: string };
  containerRef: React.RefObject<HTMLDivElement | null>;
  onBoundsChange: (bounds: BubbleBounds) => void;
  onBodyDragStart: () => void;
}

const HANDLES: { key: HandleType; style: React.CSSProperties; cursor: string }[] = [
  { key: "nw", style: { top: -4, left: -4 }, cursor: "nw-resize" },
  { key: "n",  style: { top: -4, left: "calc(50% - 4px)" }, cursor: "n-resize" },
  { key: "ne", style: { top: -4, right: -4 }, cursor: "ne-resize" },
  { key: "e",  style: { top: "calc(50% - 4px)", right: -4 }, cursor: "e-resize" },
  { key: "se", style: { bottom: -4, right: -4 }, cursor: "se-resize" },
  { key: "s",  style: { bottom: -4, left: "calc(50% - 4px)" }, cursor: "s-resize" },
  { key: "sw", style: { bottom: -4, left: -4 }, cursor: "sw-resize" },
  { key: "w",  style: { top: "calc(50% - 4px)", left: -4 }, cursor: "w-resize" },
];

export function BoundsEditor({
  style,
  containerRef,
  onBoundsChange,
  onBodyDragStart,
}: BoundsEditorProps) {
  const { onHandlePointerDown, onPointerMove, onPointerUp } = useBoundsEditor({
    style,
    containerRef,
    onBoundsCommit: onBoundsChange,
  });

  return (
    <>
      {/* body drag layer — transparent overlay so clicking bubble body moves it */}
      <div
        className="absolute inset-0 cursor-move"
        onPointerDown={(e) => {
          onBodyDragStart();
          onHandlePointerDown("body")(e);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {HANDLES.map(({ key, style: pos, cursor }) => (
        <div
          key={key}
          className="absolute z-10 h-2 w-2 rounded-sm border border-white bg-cyan-400"
          style={{ ...pos, cursor, position: "absolute" }}
          onPointerDown={onHandlePointerDown(key)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      ))}
    </>
  );
}
