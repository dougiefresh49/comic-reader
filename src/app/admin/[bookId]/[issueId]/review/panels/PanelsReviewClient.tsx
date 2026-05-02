"use client";

import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  EffectAnchor,
  EffectPositions,
  PageDirectedPanel,
  PanelAudioTags,
} from "~/types/panels";

type AudioTags = PanelAudioTags;
import type {
  PanelReviewBubble,
  PanelReviewData,
} from "~/server/admin/panel-review";
import {
  applyPanelFixes,
  type BubbleReassign,
  type PanelEdit,
  type PanelInsert,
} from "./actions";

// ─── Types & helpers ──────────────────────────────────────────────────────────

type WorkingPanel = PageDirectedPanel & {
  /** present only on locally-inserted panels */
  tempId?: string;
  dirty?: boolean;
};

type WorkingBubble = PanelReviewBubble & {
  /** original panel_id when loaded — for diff */
  originalPanelId: string | null;
};

interface TagEnums {
  effect: string[];
  ambience: string[];
  sfx: string[];
  music: string[];
}

const PANEL_PALETTE = [
  "#f97316", // orange
  "#22d3ee", // cyan
  "#a855f7", // purple
  "#84cc16", // lime
  "#ec4899", // pink
  "#facc15", // yellow
  "#3b82f6", // blue
  "#ef4444", // red
];
const UNASSIGNED_COLOR = "#737373"; // neutral-500

function panelColor(idx: number): string {
  return PANEL_PALETTE[idx % PANEL_PALETTE.length] ?? UNASSIGNED_COLOR;
}

function makeTempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function nextPanelId(
  pageNumber: number,
  panels: WorkingPanel[],
): { panelId: string; sortOrder: number } {
  const onPage = panels.filter((p) => p.pageNumber === pageNumber);
  const maxSort = onPage.reduce((m, p) => Math.max(m, p.sortOrder), 0);
  const padded = String(pageNumber).padStart(2, "0");
  const nextNum = String(onPage.length + 1).padStart(2, "0");
  return {
    panelId: `p${padded}-${nextNum}`,
    sortOrder: maxSort + 1,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  data: PanelReviewData;
  tagEnums: TagEnums;
  /** keyed by `${layer}:${base}` → variant slugs */
  variantsByTag?: Record<string, string[]>;
}

function parseTagString(s: string): { base: string; variant: string | null } {
  const at = s.indexOf("@");
  if (at < 0) return { base: s, variant: null };
  return { base: s.slice(0, at), variant: s.slice(at + 1) || null };
}

export function PanelsReviewClient({
  data,
  tagEnums,
  variantsByTag = {},
}: Props) {
  const [pageIdx, setPageIdx] = useState(0);
  const [panels, setPanels] = useState<WorkingPanel[]>(() =>
    data.pages.flatMap((p) => p.panels),
  );
  const [bubbles, setBubbles] = useState<WorkingBubble[]>(() =>
    data.pages.flatMap((p) =>
      p.bubbles.map<WorkingBubble>((b) => ({
        ...b,
        originalPanelId: b.panelId,
      })),
    ),
  );
  const [originalPanels] = useState<PageDirectedPanel[]>(() =>
    data.pages.flatMap((p) => p.panels),
  );
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [reassignFor, setReassignFor] = useState<string | null>(null); // bubble id
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const page = data.pages[pageIdx];
  const pageNumber = page?.pageNumber ?? 1;
  const pagePanels = useMemo(
    () =>
      panels
        .filter((p) => p.pageNumber === pageNumber)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [panels, pageNumber],
  );
  const pageBubbles = useMemo(
    () => bubbles.filter((b) => b.pageNumber === pageNumber),
    [bubbles, pageNumber],
  );
  const selectedPanel =
    pagePanels.find((p) => p.id === selectedPanelId) ?? null;

  const panelColorById = useMemo(() => {
    const m = new Map<string, string>();
    pagePanels.forEach((p, i) => m.set(p.id, panelColor(i)));
    return m;
  }, [pagePanels]);

  const unassignedCount = pageBubbles.filter((b) => !b.panelId).length;

  // ─── Mutations on local state ────────────────────────────────────────────

  function updatePanel(id: string, patch: Partial<WorkingPanel>) {
    setPanels((curr) =>
      curr.map((p) => (p.id === id ? { ...p, ...patch, dirty: true } : p)),
    );
  }

  function deletePanel(id: string) {
    setPanels((curr) => curr.filter((p) => p.id !== id));
    // unassign bubbles pointing at it
    setBubbles((curr) =>
      curr.map((b) => (b.panelId === id ? { ...b, panelId: null } : b)),
    );
    // queue real deletion (skip if it was a temp insert)
    if (!id.startsWith("tmp-")) {
      setPendingDeletes((d) => [...d, id]);
    }
    if (selectedPanelId === id) setSelectedPanelId(null);
  }

  function addPanelOnCurrentPage() {
    const { panelId, sortOrder } = nextPanelId(pageNumber, panels);
    const tempId = makeTempId();
    const fresh: WorkingPanel = {
      id: tempId,
      tempId,
      panelId,
      pageNumber,
      sortOrder,
      boundingBox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
      cinematicDescription: null,
      effectTags: [],
      effectPositions: null,
      audioTags: { ambience: [], sfx: [], music_mood: "transition_neutral" },
      primarySpeaker: null,
      estimatedDurationSeconds: null,
      isNewScene: false,
      source: "manual",
      bubbleIds: [],
      foregroundPolygons: null,
      sceneId: null,
      dirty: true,
    };
    setPanels((curr) => [...curr, fresh]);
    setSelectedPanelId(tempId);
  }

  function reassignBubble(bubbleId: string, panelId: string | null) {
    setBubbles((curr) =>
      curr.map((b) => (b.id === bubbleId ? { ...b, panelId } : b)),
    );
    setReassignFor(null);
  }

  // ─── Drag-resize on the selected panel ───────────────────────────────────

  const imageWrapRef = useRef<HTMLDivElement>(null);

  function startDrag(
    e: React.PointerEvent,
    mode: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
    panel: WorkingPanel,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = imageWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...panel.boundingBox };

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      let { x, y, w, h } = start;
      if (mode === "move") {
        x = clamp01(x + dx);
        y = clamp01(y + dy);
        x = Math.min(x, 1 - w);
        y = Math.min(y, 1 - h);
      } else {
        if (mode.includes("e")) w = clamp01(start.w + dx);
        if (mode.includes("w")) {
          const nx = clamp01(start.x + dx);
          w = clamp01(start.x + start.w - nx);
          x = nx;
        }
        if (mode.includes("s")) h = clamp01(start.h + dy);
        if (mode.includes("n")) {
          const ny = clamp01(start.y + dy);
          h = clamp01(start.y + start.h - ny);
          y = ny;
        }
        w = Math.max(0.02, w);
        h = Math.max(0.02, h);
      }
      updatePanel(panel.id, { boundingBox: { x, y, w, h } });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─── Apply ────────────────────────────────────────────────────────────────

  async function onApply() {
    setSaving(true);
    setError(null);
    try {
      const inserts: PanelInsert[] = panels
        .filter((p) => p.tempId)
        .map((p) => ({
          tempId: p.tempId!,
          pageNumber: p.pageNumber,
          panelId: p.panelId,
          sortOrder: p.sortOrder,
          boundingBox: p.boundingBox,
          cinematicDescription: p.cinematicDescription,
          effectTags: p.effectTags,
          audioTags: p.audioTags,
          primarySpeaker: p.primarySpeaker,
          isNewScene: p.isNewScene,
        }));

      const originalById = new Map(originalPanels.map((p) => [p.id, p]));
      const edits: PanelEdit[] = panels
        .filter((p) => !p.tempId && p.dirty)
        .map((p) => {
          const orig = originalById.get(p.id);
          const edit: PanelEdit = { id: p.id };
          if (
            !orig ||
            JSON.stringify(orig.boundingBox) !== JSON.stringify(p.boundingBox)
          )
            edit.boundingBox = p.boundingBox;
          if (orig?.cinematicDescription !== p.cinematicDescription)
            edit.cinematicDescription = p.cinematicDescription;
          if (
            JSON.stringify(orig?.effectTags ?? []) !==
            JSON.stringify(p.effectTags)
          )
            edit.effectTags = p.effectTags;
          if (
            JSON.stringify(orig?.effectPositions ?? null) !==
            JSON.stringify(p.effectPositions ?? null)
          )
            edit.effectPositions = p.effectPositions ?? null;
          if (
            JSON.stringify(orig?.audioTags ?? {}) !==
            JSON.stringify(p.audioTags)
          )
            edit.audioTags = p.audioTags;
          if (orig?.primarySpeaker !== p.primarySpeaker)
            edit.primarySpeaker = p.primarySpeaker;
          if (orig?.isNewScene !== p.isNewScene) edit.isNewScene = p.isNewScene;
          if (orig?.sortOrder !== p.sortOrder) edit.sortOrder = p.sortOrder;
          if (orig?.source !== p.source) edit.source = p.source;
          return edit;
        });

      const reassigns: BubbleReassign[] = bubbles
        .filter((b) => {
          // skip any reassign whose target is a temp-id panel — those need
          // to be re-pointed to the inserted real uuid in a second pass
          if (b.panelId?.startsWith("tmp-")) return false;
          return b.panelId !== b.originalPanelId;
        })
        .map((b) => ({ bubbleId: b.id, panelId: b.panelId }));

      const result = await applyPanelFixes({
        bookId: data.bookId,
        issueId: data.issueId,
        edits,
        inserts,
        deletes: pendingDeletes,
        reassigns,
      });
      if (!result.ok) {
        setError(result.error ?? "Apply failed");
        return;
      }

      // Second pass: bubbles that pointed at temp-id panels
      const tempReassigns: BubbleReassign[] = bubbles
        .filter((b) => b.panelId?.startsWith("tmp-"))
        .map((b) => ({
          bubbleId: b.id,
          panelId: result.insertedIds[b.panelId!] ?? null,
        }))
        .filter((r) => r.panelId !== null);
      if (tempReassigns.length > 0) {
        const r2 = await applyPanelFixes({
          bookId: data.bookId,
          issueId: data.issueId,
          edits: [],
          inserts: [],
          deletes: [],
          reassigns: tempReassigns,
        });
        if (!r2.ok) {
          setError(r2.error ?? "Reassign-to-new-panel failed");
          return;
        }
      }

      setSavedAt(new Date().toLocaleTimeString());
      setPendingDeletes([]);
      // reload to re-fetch canonical state with real uuids
      window.location.reload();
    } finally {
      setSaving(false);
    }
  }

  // ─── Drag-to-reorder panels ────────────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = pagePanels.map((p) => p.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(ids, oldIndex, newIndex);
    setPanels((curr) => {
      const updated = [...curr];
      reordered.forEach((id, i) => {
        const idx = updated.findIndex((p) => p.id === id);
        const existing = updated[idx];
        if (idx !== -1 && existing) {
          updated[idx] = {
            ...existing,
            sortOrder: i,
            source: "manual",
            dirty: true,
          };
        }
      });
      return updated;
    });
  }

  const dirtyCount =
    panels.filter((p) => p.tempId ?? p.dirty).length +
    pendingDeletes.length +
    bubbles.filter((b) => b.panelId !== b.originalPanelId).length;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="grid grid-cols-[1fr_400px] gap-6">
      {/* Left: page navigator + image with overlays */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
            disabled={pageIdx === 0}
            className="rounded bg-neutral-800 px-3 py-1 text-sm disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-sm text-neutral-300">
            Page {pageNumber} of {data.pages.length}
          </span>
          <button
            type="button"
            onClick={() =>
              setPageIdx((i) => Math.min(data.pages.length - 1, i + 1))
            }
            disabled={pageIdx >= data.pages.length - 1}
            className="rounded bg-neutral-800 px-3 py-1 text-sm disabled:opacity-30"
          >
            Next →
          </button>
          <select
            value={pageIdx}
            onChange={(e) => setPageIdx(Number(e.target.value))}
            className="rounded bg-neutral-800 px-2 py-1 text-sm"
          >
            {data.pages.map((p, i) => (
              <option key={p.pageNumber} value={i}>
                Page {p.pageNumber}
                {p.panels.length === 0 ? " (no panels)" : ""}
              </option>
            ))}
          </select>
          {unassignedCount > 0 && (
            <span className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-200">
              {unassignedCount} unassigned bubble
              {unassignedCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <div
          ref={imageWrapRef}
          className="relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 select-none"
          onClick={() => {
            setSelectedPanelId(null);
            setReassignFor(null);
          }}
        >
          {page && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={page.imageUrl}
              alt={`Page ${pageNumber}`}
              className="block w-full"
              draggable={false}
            />
          )}

          {/* Panel rectangles */}
          {pagePanels.map((p) => {
            const color = panelColorById.get(p.id) ?? UNASSIGNED_COLOR;
            const isSelected = p.id === selectedPanelId;
            return (
              <div
                key={p.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelectedPanelId(p.id);
                  startDrag(e, "move", p);
                }}
                style={{
                  left: `${p.boundingBox.x * 100}%`,
                  top: `${p.boundingBox.y * 100}%`,
                  width: `${p.boundingBox.w * 100}%`,
                  height: `${p.boundingBox.h * 100}%`,
                  borderColor: color,
                  backgroundColor: `${color}22`,
                  outline: isSelected ? `2px solid ${color}` : undefined,
                }}
                className="absolute cursor-move border-2"
              >
                <div
                  className="absolute -top-5 left-0 rounded px-1 py-0.5 text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {p.panelId}
                  {p.tempId ? " ✦" : p.dirty ? " •" : ""}
                </div>
                {isSelected && (
                  <>
                    {(
                      ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const
                    ).map((mode) => (
                      <Handle
                        key={mode}
                        mode={mode}
                        color={color}
                        onPointerDown={(e) => startDrag(e, mode, p)}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}

          {/* Bubble dots */}
          {pageBubbles.map((b) => {
            if (!b.style) return null;
            const color = b.panelId
              ? (panelColorById.get(b.panelId) ?? UNASSIGNED_COLOR)
              : "#ef4444";
            const left = parseFloat(b.style.left);
            const top = parseFloat(b.style.top);
            const width = parseFloat(b.style.width);
            const height = parseFloat(b.style.height);
            const cx = left + width / 2;
            const cy = top + height / 2;
            return (
              <button
                type="button"
                key={b.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selectedPanel) {
                    reassignBubble(b.id, selectedPanel.id);
                  } else {
                    setReassignFor(b.id);
                  }
                }}
                title={`${b.legacyId ?? b.id.slice(0, 8)} ${b.speaker ?? "?"}: ${b.ocrText.slice(0, 60)}`}
                style={{
                  left: `${cx}%`,
                  top: `${cy}%`,
                  backgroundColor: color,
                }}
                className="absolute -mt-2 -ml-2 h-4 w-4 rounded-full border-2 border-white shadow"
              />
            );
          })}

          {reassignFor && (
            <div className="absolute top-2 right-2 rounded-lg bg-neutral-800 p-3 shadow-xl">
              <div className="mb-2 text-xs text-neutral-400">
                Reassign bubble to:
              </div>
              <div className="flex flex-col gap-1">
                {pagePanels.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => reassignBubble(reassignFor, p.id)}
                    className="rounded bg-neutral-700 px-2 py-1 text-left text-xs hover:bg-neutral-600"
                  >
                    <span
                      className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                      style={{ backgroundColor: panelColorById.get(p.id) }}
                    />
                    {p.panelId}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => reassignBubble(reassignFor, null)}
                  className="rounded bg-red-900/50 px-2 py-1 text-left text-xs hover:bg-red-900"
                >
                  Unassign
                </button>
                <button
                  type="button"
                  onClick={() => setReassignFor(null)}
                  className="rounded px-2 py-1 text-left text-xs text-neutral-400 hover:text-neutral-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 text-xs text-neutral-500">
          Click a panel to select. Click a bubble dot to reassign it to the
          selected panel (or pick from a menu if no panel is selected).
        </div>
      </div>

      {/* Right: panel list + actions */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addPanelOnCurrentPage}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium hover:bg-emerald-600"
          >
            + Add panel
          </button>
          <button
            type="button"
            disabled={dirtyCount === 0 || saving}
            onClick={onApply}
            className="rounded bg-cyan-700 px-3 py-1.5 text-sm font-medium hover:bg-cyan-600 disabled:opacity-30"
          >
            {saving ? "Applying…" : `Apply (${dirtyCount})`}
          </button>
          {savedAt && (
            <span className="text-xs text-emerald-400">Saved {savedAt}</span>
          )}
        </div>
        {error && (
          <div className="rounded border border-red-700 bg-red-900/30 px-2 py-1 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3 overflow-y-auto">
          {pagePanels.length === 0 && (
            <div className="rounded border border-neutral-800 p-3 text-xs text-neutral-400">
              No panels on this page yet. Click <em>+ Add panel</em> to create
              one, then drag the corners to size it.
            </div>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={pagePanels.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {pagePanels.map((p) => (
                <SortablePanelCard
                  key={p.id}
                  panel={p}
                  color={panelColorById.get(p.id) ?? UNASSIGNED_COLOR}
                  selected={p.id === selectedPanelId}
                  tagEnums={tagEnums}
                  variantsByTag={variantsByTag}
                  bubbleCount={
                    pageBubbles.filter((b) => b.panelId === p.id).length
                  }
                  onSelect={() => setSelectedPanelId(p.id)}
                  onChange={(patch) => updatePanel(p.id, patch)}
                  onDelete={() => deletePanel(p.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Handle({
  mode,
  color,
  onPointerDown,
}: {
  mode: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  color: string;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const positions: Record<typeof mode, React.CSSProperties> = {
    nw: { left: -5, top: -5, cursor: "nwse-resize" },
    n: { left: "50%", top: -5, marginLeft: -5, cursor: "ns-resize" },
    ne: { right: -5, top: -5, cursor: "nesw-resize" },
    e: { right: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
    se: { right: -5, bottom: -5, cursor: "nwse-resize" },
    s: { left: "50%", bottom: -5, marginLeft: -5, cursor: "ns-resize" },
    sw: { left: -5, bottom: -5, cursor: "nesw-resize" },
    w: { left: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
  };
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        ...positions[mode],
        position: "absolute",
        width: 10,
        height: 10,
        backgroundColor: color,
        border: "1px solid white",
      }}
    />
  );
}

interface PanelCardProps {
  panel: WorkingPanel;
  color: string;
  selected: boolean;
  bubbleCount: number;
  tagEnums: TagEnums;
  variantsByTag: Record<string, string[]>;
  onSelect: () => void;
  onChange: (patch: Partial<WorkingPanel>) => void;
  onDelete: () => void;
}

function SortablePanelCard(props: PanelCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.panel.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "opacity-50 shadow-lg shadow-black/50" : ""}
    >
      <PanelCard
        {...props}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
    </div>
  );
}

function PanelCard({
  panel,
  color,
  selected,
  bubbleCount,
  tagEnums,
  variantsByTag,
  onSelect,
  onChange,
  onDelete,
  dragAttributes,
  dragListeners,
}: PanelCardProps & {
  dragAttributes?: DraggableAttributes;
  dragListeners?: ReturnType<typeof useSortable>["listeners"];
}) {
  function toggleTag(list: string[], tag: string): string[] {
    return list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
  }
  function setBaseVariant(
    list: string[],
    base: string,
    variant: string | null,
  ): string[] {
    const next = list.filter((s) => parseTagString(s).base !== base);
    next.push(variant ? `${base}@${variant}` : base);
    return next;
  }
  function updateAudio(patch: Partial<AudioTags>) {
    onChange({ audioTags: { ...panel.audioTags, ...patch } });
  }

  return (
    <div
      onClick={onSelect}
      className={`rounded-lg border bg-neutral-900 p-3 ${selected ? "border-cyan-500" : "border-neutral-800"}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {dragAttributes && dragListeners && (
            <button
              className="flex shrink-0 cursor-grab items-center text-neutral-600 hover:text-neutral-400 active:cursor-grabbing"
              {...dragAttributes}
              {...dragListeners}
              tabIndex={-1}
              aria-label="Drag to reorder"
            >
              ⠿
            </button>
          )}
          <span
            className="inline-block h-3 w-3 rounded"
            style={{ backgroundColor: color }}
          />
          <span className="font-mono text-sm">{panel.panelId}</span>
          <span className="text-xs text-neutral-500">
            {panel.source}
            {panel.tempId ? " · new" : panel.dirty ? " · edited" : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete ${panel.panelId}?`)) onDelete();
          }}
          className="text-xs text-red-400 hover:text-red-300"
        >
          Delete
        </button>
      </div>

      <div className="mb-2 text-xs text-neutral-400">{bubbleCount} bubbles</div>

      <label className="mb-2 block text-xs text-neutral-400">
        Cinematic description
        <textarea
          value={panel.cinematicDescription ?? ""}
          onChange={(e) =>
            onChange({ cinematicDescription: e.target.value || null })
          }
          rows={2}
          className="mt-1 w-full rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100"
        />
      </label>

      <TagChips
        label="Effect tags"
        all={tagEnums.effect}
        selected={panel.effectTags}
        onToggle={(tag) => {
          const next = toggleTag(panel.effectTags, tag);
          const patch: Partial<WorkingPanel> = { effectTags: next };
          if (!next.includes(tag) && panel.effectPositions?.[tag]) {
            const ep = { ...panel.effectPositions };
            delete ep[tag];
            patch.effectPositions = Object.keys(ep).length > 0 ? ep : null;
          }
          onChange(patch);
        }}
      />
      <EffectPositionPicker
        effectTags={panel.effectTags}
        effectPositions={panel.effectPositions}
        onChange={(ep) => onChange({ effectPositions: ep })}
      />
      <AudioTagChips
        label="Ambience"
        layer="ambience"
        all={tagEnums.ambience}
        selected={panel.audioTags.ambience}
        variantsByTag={variantsByTag}
        onToggle={(tag) =>
          updateAudio({ ambience: toggleTag(panel.audioTags.ambience, tag) })
        }
        onPickVariant={(base, variant) =>
          updateAudio({
            ambience: setBaseVariant(panel.audioTags.ambience, base, variant),
          })
        }
      />
      <AudioTagChips
        label="SFX"
        layer="sfx"
        all={tagEnums.sfx}
        selected={panel.audioTags.sfx}
        variantsByTag={variantsByTag}
        onToggle={(tag) =>
          updateAudio({ sfx: toggleTag(panel.audioTags.sfx, tag) })
        }
        onPickVariant={(base, variant) =>
          updateAudio({
            sfx: setBaseVariant(panel.audioTags.sfx, base, variant),
          })
        }
      />
      <label className="mt-2 block text-xs text-neutral-400">
        Music mood
        <select
          value={panel.audioTags.music_mood}
          onChange={(e) => updateAudio({ music_mood: e.target.value })}
          className="ml-2 rounded bg-neutral-800 px-1 py-0.5 text-xs"
        >
          {tagEnums.music.flatMap((m) => {
            const variants = variantsByTag[`music:${m}`] ?? [];
            return [
              <option key={m} value={m}>
                {m}
              </option>,
              ...variants.map((v) => (
                <option key={`${m}@${v}`} value={`${m}@${v}`}>
                  {m} @{v}
                </option>
              )),
            ];
          })}
        </select>
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={panel.isNewScene}
          onChange={(e) => onChange({ isNewScene: e.target.checked })}
        />
        New scene (music transition)
      </label>
    </div>
  );
}

const CAMERA_PREFIXES = ["camera_", "panel_shake"];

const ANCHOR_GRID: Array<{ value: EffectAnchor; label: string }> = [
  { value: "top-left", label: "TL" },
  { value: "top-center", label: "TC" },
  { value: "top-right", label: "TR" },
  { value: "left-center", label: "ML" },
  { value: "center", label: "C" },
  { value: "right-center", label: "MR" },
  { value: "bottom-left", label: "BL" },
  { value: "bottom-center", label: "BC" },
  { value: "bottom-right", label: "BR" },
];

function EffectPositionPicker({
  effectTags,
  effectPositions,
  onChange,
}: {
  effectTags: string[];
  effectPositions: EffectPositions | null;
  onChange: (ep: EffectPositions | null) => void;
}) {
  const positionable = effectTags.filter(
    (t) => !CAMERA_PREFIXES.some((p) => t.startsWith(p)),
  );
  if (positionable.length === 0) return null;

  function setAnchor(tag: string, anchor: EffectAnchor | null) {
    const current = { ...(effectPositions ?? {}) };
    if (anchor === null) {
      delete current[tag];
    } else {
      current[tag] = { anchor };
    }
    onChange(Object.keys(current).length > 0 ? current : null);
  }

  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">Effect positions</div>
      <div className="flex flex-col gap-2">
        {positionable.map((tag) => {
          const pos = effectPositions?.[tag];
          const activeAnchor = pos?.anchor ?? null;
          return (
            <div key={tag} className="flex items-start gap-2">
              <span className="mt-0.5 min-w-0 shrink text-[10px] leading-tight break-all text-neutral-500">
                {tag.replace(/_/g, " ")}
              </span>
              <div className="grid shrink-0 grid-cols-3 gap-px">
                {ANCHOR_GRID.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    title={a.value}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAnchor(tag, activeAnchor === a.value ? null : a.value);
                    }}
                    className={`h-4 w-5 text-[8px] leading-none ${
                      activeAnchor === a.value
                        ? "bg-cyan-700 text-white"
                        : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagChips({
  label,
  all,
  selected,
  onToggle,
}: {
  label: string;
  all: string[];
  selected: string[];
  onToggle: (tag: string) => void;
}) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {all.map((tag) => {
          const on = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(tag);
              }}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                on
                  ? "bg-cyan-700 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Variant-aware tag chips for audio layers (ambience / sfx).
 *
 * Each chip represents a base tag. A tag is "on" if any string in
 * `selected[]` parses to that base. Clicking a chip toggles the bare
 * tag (or removes all variants of that base). When the chip is on AND
 * variants exist, an inline ▾ button reveals a variant menu.
 */
function AudioTagChips({
  label,
  layer,
  all,
  selected,
  variantsByTag,
  onToggle,
  onPickVariant,
}: {
  label: string;
  layer: "ambience" | "sfx";
  all: string[];
  selected: string[];
  variantsByTag: Record<string, string[]>;
  onToggle: (tag: string) => void;
  onPickVariant: (base: string, variant: string | null) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-neutral-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {all.map((base) => {
          const selectedString = selected.find(
            (s) => parseTagString(s).base === base,
          );
          const on = Boolean(selectedString);
          const currentVariant = selectedString
            ? parseTagString(selectedString).variant
            : null;
          const variants = variantsByTag[`${layer}:${base}`] ?? [];
          return (
            <span key={base} className="relative inline-flex items-stretch">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(base);
                }}
                className={`rounded-l px-1.5 py-0.5 text-[10px] ${
                  on
                    ? "bg-cyan-700 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                } ${variants.length === 0 ? "rounded-r" : ""}`}
              >
                {base}
                {currentVariant ? (
                  <span className="ml-1 text-cyan-200">@{currentVariant}</span>
                ) : null}
              </button>
              {variants.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu(openMenu === base ? null : base);
                  }}
                  className={`rounded-r border-l border-neutral-900 px-1 text-[10px] ${
                    on
                      ? "bg-cyan-700 text-white hover:bg-cyan-600"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                  }`}
                  aria-label={`Variants for ${base}`}
                >
                  ▾
                </button>
              )}
              {openMenu === base && (
                <div
                  className="absolute top-full left-0 z-10 mt-0.5 flex flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onPickVariant(base, null);
                      setOpenMenu(null);
                    }}
                    className={`rounded px-2 py-0.5 text-left text-[10px] ${currentVariant === null && on ? "bg-cyan-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
                  >
                    default
                  </button>
                  {variants.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        onPickVariant(base, v);
                        setOpenMenu(null);
                      }}
                      className={`rounded px-2 py-0.5 text-left text-[10px] ${currentVariant === v ? "bg-cyan-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
                    >
                      @{v}
                    </button>
                  ))}
                </div>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
