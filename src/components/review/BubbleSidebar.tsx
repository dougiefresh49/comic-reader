"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LocalBubble, EditChanges } from "~/hooks/useReviewEdits";

interface BubbleSidebarProps {
  bubble: LocalBubble | null;
  bubbles: LocalBubble[];
  characters: string[];
  redoSet: Set<string>;
  selectedId: string | null;
  speakerRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (id: string) => void;
  onAdvance: () => void;
  onSetPageOrder: (ids: string[]) => void;
  onChange: (id: string, changes: EditChanges) => void;
  onMarkRedo: (id: string) => void;
  onDelete: (id: string) => void;
}

const COMMON_EMOTIONS = [
  "Angry",
  "Calm",
  "Confident",
  "Determined",
  "Excited",
  "Fearful",
  "Frustrated",
  "Happy",
  "Mysterious",
  "Sad",
  "Serious",
  "Shocked",
  "Solemn",
  "Worried",
];

const BUBBLE_TYPES = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
] as const;

function statusLabel(b: LocalBubble, isRedo: boolean): string {
  if (isRedo) return "✕ redo";
  if (b._status === "deleted") return "✕ deleted";
  if (b._status === "modified") return "● modified";
  if (b._status === "new") return "★ new";
  return "✓";
}

function statusColor(b: LocalBubble, isRedo: boolean): string {
  if (isRedo) return "text-red-400";
  if (b._status === "deleted") return "text-red-400";
  if (b._status === "modified") return "text-amber-400";
  if (b._status === "new") return "text-cyan-400";
  return "text-neutral-400";
}

function styleToPctValues(style: LocalBubble["style"]) {
  if (!style) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: parseFloat(style.left),
    y: parseFloat(style.top),
    w: parseFloat(style.width),
    h: parseFloat(style.height),
  };
}

function BubbleDetail({
  bubble,
  characters,
  isRedo,
  speakerRef,
  onAdvance,
  onChange,
  onMarkRedo,
  onDelete,
}: {
  bubble: LocalBubble;
  characters: string[];
  isRedo: boolean;
  speakerRef: React.RefObject<HTMLInputElement | null>;
  onAdvance: () => void;
  onChange: (changes: EditChanges) => void;
  onMarkRedo: () => void;
  onDelete: () => void;
}) {
  const [aiExpanded, setAiExpanded] = useState(false);
  const pct = styleToPctValues(bubble.style);
  const readingIndex =
    bubble.box_2d.index !== undefined ? bubble.box_2d.index + 1 : "?";

  // Auto-focus speaker when bubble changes
  useEffect(() => {
    speakerRef.current?.focus();
    speakerRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble.id]);

  const speakerOptions = useMemo(
    () => characters.map((c) => <option key={c} value={c} />),
    [characters],
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-neutral-100">
          Bubble #{readingIndex}
        </span>
        <button
          onClick={onMarkRedo}
          className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
            isRedo
              ? "bg-red-900/60 text-red-300 hover:bg-red-900/80"
              : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
          }`}
        >
          {isRedo ? "✕ Marked for Redo" : "Mark for Redo"}
        </button>
      </div>

      {/* Speaker */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Speaker</span>
        <input
          ref={speakerRef}
          list="speaker-list"
          value={bubble.speaker ?? ""}
          onChange={(e) => onChange({ speaker: e.target.value || null })}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.stopPropagation();
          }}
          tabIndex={0}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none"
          placeholder="Unknown"
        />
        <datalist id="speaker-list">{speakerOptions}</datalist>
      </label>

      {/* Emotion */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Emotion</span>
        <input
          list="emotion-list"
          value={bubble.emotion}
          onChange={(e) => onChange({ emotion: e.target.value })}
          tabIndex={0}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none"
        />
        <datalist id="emotion-list">
          {COMMON_EMOTIONS.map((em) => (
            <option key={em} value={em} />
          ))}
        </datalist>
      </label>

      {/* Type */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Type</span>
        <div className="flex flex-wrap gap-2">
          {BUBBLE_TYPES.map((t, i) => (
            <label key={t} className="flex cursor-pointer items-center gap-1">
              <input
                type="radio"
                name="bubble-type"
                value={t}
                checked={bubble.type === t}
                onChange={() => onChange({ type: t })}
                tabIndex={i === 0 ? 0 : -1}
                className="accent-cyan-500"
              />
              <span className="text-xs text-neutral-300">{t}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Text (OCR) */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Text (OCR)</span>
        <textarea
          value={bubble.ocr_text}
          onChange={(e) => onChange({ ocr_text: e.target.value })}
          rows={3}
          tabIndex={0}
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none"
        />
      </label>

      {/* textWithCues */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">
          textWithCues
        </span>
        <textarea
          value={bubble.textWithCues ?? ""}
          onChange={(e) =>
            onChange({ textWithCues: e.target.value || undefined })
          }
          rows={3}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              onAdvance();
            }
          }}
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-cyan-500 focus:outline-none"
        />
      </label>

      {/* AI Reasoning */}
      {bubble.aiReasoning && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setAiExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-neutral-400 hover:text-neutral-200"
          >
            <span>{aiExpanded ? "▼" : "▶"}</span>
            AI Reasoning
          </button>
          {aiExpanded && (
            <div
              tabIndex={-1}
              className="max-h-32 overflow-y-auto rounded border border-neutral-700 bg-neutral-900/50 px-2 py-1.5 text-xs text-neutral-400"
            >
              {bubble.aiReasoning}
            </div>
          )}
        </div>
      )}

      {/* Bounding Box */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">
          Bounding Box (%)
        </span>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-300">
          <span>x: {pct.x.toFixed(1)}</span>
          <span>y: {pct.y.toFixed(1)}</span>
          <span>w: {pct.w.toFixed(1)}</span>
          <span>h: {pct.h.toFixed(1)}</span>
        </div>
      </div>

      {/* Phase B buttons — grayed out */}
      <div className="flex flex-col gap-1 pt-1">
        <button
          disabled
          className="cursor-not-allowed rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-600"
          title="Available in Phase B"
        >
          ↻ Re-run Gemini Context
        </button>
        <button
          disabled
          className="cursor-not-allowed rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-600"
          title="Available in Phase B"
        >
          🔊 Re-generate Audio
        </button>
      </div>

      {/* Delete */}
      <button
        onClick={onDelete}
        className="mt-1 rounded border border-red-900 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30"
      >
        Delete Bubble
      </button>
    </div>
  );
}

function SortableBubbleRow({
  bubble,
  isSelected,
  isRedo,
  onSelect,
}: {
  bubble: LocalBubble;
  isSelected: boolean;
  isRedo: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bubble.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const readingIndex =
    bubble.box_2d.index !== undefined ? bubble.box_2d.index + 1 : "?";
  const previewText =
    bubble.ocr_text.length > 35
      ? bubble.ocr_text.slice(0, 35) + "…"
      : bubble.ocr_text;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-bubble-id={bubble.id}
      className={`flex items-center ${isDragging ? "opacity-50 shadow-lg shadow-black/50" : ""}`}
    >
      {/* Drag handle */}
      <button
        className="flex shrink-0 cursor-grab items-center px-2 py-1.5 text-neutral-600 hover:text-neutral-400 active:cursor-grabbing"
        {...attributes}
        {...listeners}
        tabIndex={-1}
        aria-label="Drag to reorder"
      >
        ⠿
      </button>
      {/* Row content */}
      <button
        onClick={onSelect}
        className={`flex flex-1 items-baseline gap-2 py-1.5 pr-3 text-left text-xs hover:bg-neutral-800 ${
          isSelected ? "bg-neutral-800/70" : ""
        }`}
      >
        <span className="w-5 shrink-0 font-mono text-neutral-500">
          #{readingIndex}
        </span>
        <span className="w-20 shrink-0 truncate font-medium text-neutral-300">
          {bubble.speaker ?? "[unassigned]"}
        </span>
        <span className="flex-1 truncate text-neutral-500">
          &ldquo;{previewText}&rdquo;
        </span>
        <span className={`shrink-0 text-[10px] ${statusColor(bubble, isRedo)}`}>
          {statusLabel(bubble, isRedo)}
        </span>
      </button>
    </div>
  );
}

export function BubbleSidebar({
  bubble,
  bubbles,
  characters,
  redoSet,
  selectedId,
  speakerRef,
  onSelect,
  onAdvance,
  onSetPageOrder,
  onChange,
  onMarkRedo,
  onDelete,
}: BubbleSidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Scroll selected bubble into view when selectedId changes (e.g. Tab nav)
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(
      `[data-bubble-id="${selectedId}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const visibleBubbles = bubbles.filter((b) => b._status !== "deleted");
  const visibleIds = visibleBubbles.map((b) => b.id);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleIds.indexOf(String(active.id));
    const newIndex = visibleIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const newIds = arrayMove(visibleIds, oldIndex, newIndex);
    onSetPageOrder(newIds);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950">
      {/* Selected bubble panel */}
      <div className="flex-1 overflow-y-auto">
        {bubble ? (
          <BubbleDetail
            bubble={bubble}
            characters={characters}
            isRedo={redoSet.has(bubble.id)}
            speakerRef={speakerRef}
            onAdvance={onAdvance}
            onChange={(changes) => onChange(bubble.id, changes)}
            onMarkRedo={() => onMarkRedo(bubble.id)}
            onDelete={() => onDelete(bubble.id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Click a bubble to select it
          </div>
        )}
      </div>

      {/* Divider + Bubble list */}
      <div className="flex flex-col border-t border-neutral-800">
        <div className="px-3 py-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Bubbles on this page
        </div>
        <div ref={listRef} className="max-h-48 overflow-y-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visibleIds}
              strategy={verticalListSortingStrategy}
            >
              {visibleBubbles.map((b) => (
                <SortableBubbleRow
                  key={b.id}
                  bubble={b}
                  isSelected={b.id === selectedId}
                  isRedo={redoSet.has(b.id)}
                  onSelect={() => onSelect(b.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  );
}
