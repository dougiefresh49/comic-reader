// Left drawer: the page as a tree. Panels in reading order, each panel's bubbles in play order.
"use client";

import { useEffect, useRef, useState } from "react";
import { needYou, plural, tintFor } from "./lib";
import {
  groupMembers,
  SPOKEN,
  visibleBubbles,
  type BubbleDoc,
  type Doc,
  type Flag,
  type PanelDoc,
  type Sel,
} from "./model";
import type { CastMember } from "./types";

interface TreeProps {
  doc: Doc;
  pageNumber: number;
  panels: PanelDoc[];
  flags: Map<string, Flag[]>;
  /** Touching-balloon prompts (#451): each bubble's other balloon. */
  touching: Map<string, string>;
  numbers: Map<string, number>;
  castById: Map<string, CastMember>;
  sel: Sel | null;
  hover: Sel | null;
  onlyFlagged: boolean;
  onSelect: (sel: Sel | null) => void;
  onHover: (sel: Sel | null) => void;
  onMoveBubble: (id: string, panelId: string | null, index: number) => void;
  onMovePanel: (id: string, index: number) => void;
  onDismiss: (id: string) => void;
  onRestore: (id: string) => void;
  onZoomPanel: (id: string) => void;
}

interface DropTarget {
  kind: "bubble" | "panel" | "loose";
  id: string;
  where: "before" | "after" | "into";
}

const LOOSE = "__loose__";

const TYPE_TAG: Record<string, string> = {
  SFX: "sfx",
  BACKGROUND: "background",
  NARRATION: "narration",
  CAPTION: "caption",
};

function speakerCell(
  b: BubbleDoc,
  flags: Flag[] | undefined,
  member: CastMember | undefined,
): { label: string; className: string } {
  if (b.ignored) return { label: "ignored", className: "text-neutral-600" };
  const first = flags?.find((f) => f.kind !== "duplicate");
  if (first?.kind === "no-speaker")
    return { label: "no speaker", className: "text-amber-300" };
  if (first?.kind === "unknown-speaker")
    return { label: `${first.raw} ?`, className: "text-amber-300 italic" };
  if (b.silent) return { label: "silent", className: "text-neutral-500" };
  if (member)
    return {
      label: member.name,
      className: tintFor(member).text,
    };
  return {
    label: SPOKEN.includes(b.type) ? "" : (TYPE_TAG[b.type] ?? ""),
    className: "text-neutral-500",
  };
}

export function Tree({
  doc,
  pageNumber,
  panels,
  flags,
  touching,
  numbers,
  castById,
  sel,
  hover,
  onlyFlagged,
  onSelect,
  onHover,
  onMoveBubble,
  onMovePanel,
  onDismiss,
  onRestore,
  onZoomPanel,
}: TreeProps) {
  const page = doc.pages[pageNumber];
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [showDeleted, setShowDeleted] = useState(false);
  const [dragging, setDragging] = useState<Sel | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row in view, opening its panel if it was folded.
  // Runs when the selection changes, so folding a panel by hand still sticks.
  const selId = sel?.kind === "bubble" ? sel.id : null;
  const holderId = selId
    ? (panels.find((p) => p.bubbleIds.includes(selId))?.id ?? null)
    : null;
  useEffect(() => {
    if (holderId)
      setClosed((prev) =>
        prev.has(holderId)
          ? new Set([...prev].filter((id) => id !== holderId))
          : prev,
      );
  }, [selId, holderId]);
  const rowId = sel?.id ?? null;
  useEffect(() => {
    if (!rowId) return;
    listRef.current
      ?.querySelector(`[data-row="${rowId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [rowId, closed]);

  if (!page) return null;

  const deleted = [...panels.flatMap((p) => p.bubbleIds), ...page.looseIds]
    .flatMap((id) => doc.bubbles[id] ?? [])
    .filter((b) => b.deleted);

  const where = (e: React.DragEvent<HTMLElement>): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };

  const finish = () => {
    setDragging(null);
    setDrop(null);
  };

  const dropOnBubble = (target: BubbleDoc, holder: PanelDoc | null) => {
    if (dragging?.kind !== "bubble" || !drop) return;
    if (dragging.id === target.id) return;
    const ids = (holder ? holder.bubbleIds : page.looseIds).filter(
      (id) => id !== dragging.id,
    );
    const at = ids.indexOf(target.id) + (drop.where === "after" ? 1 : 0);
    onMoveBubble(dragging.id, holder?.id ?? null, at);
  };

  const dropOnPanel = (target: PanelDoc) => {
    if (!dragging || !drop) return;
    if (dragging.kind === "bubble") {
      onMoveBubble(dragging.id, target.id, 0);
      return;
    }
    if (dragging.id === target.id) return;
    const ids = page.panelIds.filter((id) => id !== dragging.id);
    onMovePanel(
      dragging.id,
      ids.indexOf(target.id) + (drop.where === "after" ? 1 : 0),
    );
  };

  const line = (kind: DropTarget["kind"], id: string) => {
    if (drop?.kind !== kind || drop.id !== id) return "";
    if (drop.where === "into") return "bg-neutral-700";
    return drop.where === "before"
      ? "shadow-[inset_0_2px_0_0_white]"
      : "shadow-[inset_0_-2px_0_0_white]";
  };

  const bubbleRow = (b: BubbleDoc, holder: PanelDoc | null) => {
    const f = flags.get(b.id);
    if (onlyFlagged && !f) return null;
    const selected = sel?.kind === "bubble" && sel.id === b.id;
    const hovered = hover?.kind === "bubble" && hover.id === b.id;
    const member = b.speakerId ? castById.get(b.speakerId) : undefined;
    const cell = speakerCell(b, f, member);
    const duplicate = f?.some((x) => x.kind === "duplicate");
    const joined = groupMembers(doc, b.id).length > 0;
    return (
      <div
        key={b.id}
        role="treeitem"
        aria-selected={selected}
        data-row={b.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", b.id);
          setDragging({ kind: "bubble", id: b.id });
        }}
        onDragEnd={finish}
        onDragOver={(e) => {
          if (dragging?.kind !== "bubble") return;
          e.preventDefault();
          const w = where(e);
          if (drop?.id !== b.id || drop.where !== w)
            setDrop({ kind: "bubble", id: b.id, where: w });
        }}
        onDrop={(e) => {
          e.preventDefault();
          dropOnBubble(b, holder);
          finish();
        }}
        onClick={() => onSelect({ kind: "bubble", id: b.id })}
        onMouseEnter={() => onHover({ kind: "bubble", id: b.id })}
        className={`flex h-[26px] cursor-default items-center gap-1.5 border-l-2 pr-2 pl-6 ${
          selected
            ? "border-white bg-neutral-700/70 text-white"
            : hovered
              ? "border-transparent bg-neutral-800/80"
              : "border-transparent"
        } ${line("bubble", b.id)} ${dragging?.id === b.id ? "opacity-40" : ""}`}
      >
        <span className="w-5 shrink-0 text-right text-[11px] text-neutral-500 tabular-nums">
          {numbers.get(b.id)}
        </span>
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            f && !b.ignored
              ? "bg-amber-400"
              : b.ignored || b.silent
                ? "bg-neutral-700"
                : tintFor(member).dot
          }`}
        />
        {cell.label && (
          <span className={`max-w-[92px] shrink-0 truncate ${cell.className}`}>
            {cell.label}
          </span>
        )}
        <span
          className={`min-w-0 flex-1 truncate ${
            b.ignored ? "text-neutral-600 line-through" : "text-neutral-400"
          }`}
        >
          {b.text.replace(/\s+/g, " ")}
        </span>
        {joined && (
          <span
            title="Joined with the next or previous balloon: one line, one clip"
            className="shrink-0 text-[10px] text-neutral-500"
          >
            joined
          </span>
        )}
        {touching.has(b.id) && (
          <span
            title="Touches another speaker's balloon: one line split in two?"
            className="shrink-0 text-[10px] text-sky-300"
          >
            touching?
          </span>
        )}
        {duplicate && (
          <button
            type="button"
            tabIndex={-1}
            title="Dismiss this duplicate (D)"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(b.id);
            }}
            className="shrink-0 rounded-sm border border-amber-400/50 px-1 text-[10px] leading-4 text-amber-300 hover:bg-amber-400 hover:text-neutral-950"
          >
            duplicate? dismiss
          </button>
        )}
      </div>
    );
  };

  const loose = visibleBubbles(doc, page.looseIds);

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label={`Page ${pageNumber}`}
      className="min-h-0 flex-1 overflow-y-auto pb-6 text-[12px] select-none"
      onMouseLeave={() => onHover(null)}
    >
      <div
        role="treeitem"
        aria-selected={!sel}
        onClick={() => onSelect(null)}
        className={`flex h-[26px] cursor-default items-center gap-2 border-l-2 px-2 ${
          sel ? "border-transparent" : "border-white bg-neutral-700/70"
        }`}
      >
        <span className="font-medium text-neutral-100">Page {pageNumber}</span>
        <span className="text-neutral-500">
          {plural(panels.length, "panel")}, {plural(numbers.size, "bubble")}
        </span>
      </div>

      {panels.map((p, i) => {
        const rows = visibleBubbles(doc, p.bubbleIds);
        const flagged = rows.filter((b) => flags.has(b.id)).length;
        const selected = sel?.kind === "panel" && sel.id === p.id;
        const hovered = hover?.kind === "panel" && hover.id === p.id;
        const folded = closed.has(p.id);
        if (onlyFlagged && flagged === 0) return null;
        return (
          <div key={p.id} role="group">
            <div
              role="treeitem"
              aria-selected={selected}
              aria-expanded={!folded}
              data-row={p.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", p.id);
                setDragging({ kind: "panel", id: p.id });
              }}
              onDragEnd={finish}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const w = dragging.kind === "bubble" ? "into" : where(e);
                if (drop?.id !== p.id || drop.where !== w)
                  setDrop({ kind: "panel", id: p.id, where: w });
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropOnPanel(p);
                finish();
              }}
              onClick={() => onSelect({ kind: "panel", id: p.id })}
              onDoubleClick={() => onZoomPanel(p.id)}
              onMouseEnter={() => onHover({ kind: "panel", id: p.id })}
              className={`flex h-[26px] cursor-default items-center gap-1 border-l-2 pr-2 pl-1 ${
                selected
                  ? "border-white bg-neutral-700/70 text-white"
                  : hovered
                    ? "border-transparent bg-neutral-800/80"
                    : "border-transparent"
              } ${line("panel", p.id)} ${
                dragging?.id === p.id ? "opacity-40" : ""
              }`}
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label={folded ? "Unfold panel" : "Fold panel"}
                onClick={(e) => {
                  e.stopPropagation();
                  setClosed((prev) =>
                    prev.has(p.id)
                      ? new Set([...prev].filter((id) => id !== p.id))
                      : new Set([...prev, p.id]),
                  );
                }}
                className="flex size-4 items-center justify-center text-neutral-500 hover:text-neutral-200"
              >
                <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
                  <path
                    d={folded ? "M2 1l4 3-4 3z" : "M1 2l3 4 3-4z"}
                    fill="currentColor"
                  />
                </svg>
              </button>
              <span className="font-medium text-neutral-200">
                Panel {i + 1}
              </span>
              <span className="text-neutral-500">{rows.length}</span>
              <span className="flex-1" />
              {flagged > 0 && (
                <span className="rounded-sm bg-amber-400/15 px-1 text-[10px] leading-4 text-amber-300">
                  {needYou(flagged)}
                </span>
              )}
            </div>
            {!folded && rows.map((b) => bubbleRow(b, p))}
            {!folded && rows.length === 0 && (
              <div className="h-[22px] pl-8 text-[11px] leading-[22px] text-neutral-600">
                no bubbles
              </div>
            )}
          </div>
        );
      })}

      {(loose.length > 0 || dragging?.kind === "bubble") && (
        <div role="group">
          <div
            onDragOver={(e) => {
              if (dragging?.kind !== "bubble") return;
              e.preventDefault();
              if (drop?.id !== LOOSE)
                setDrop({ kind: "loose", id: LOOSE, where: "into" });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging?.kind === "bubble")
                onMoveBubble(dragging.id, null, 0);
              finish();
            }}
            className={`flex h-[26px] items-center gap-1 border-l-2 border-transparent pr-2 pl-6 text-neutral-400 ${line(
              "loose",
              LOOSE,
            )}`}
          >
            Outside every panel
            <span className="text-neutral-500">{loose.length}</span>
          </div>
          {loose.map((b) => bubbleRow(b, null))}
        </div>
      )}

      {deleted.length > 0 && (
        <div className="mt-2 border-t border-neutral-800 pt-1">
          <button
            type="button"
            tabIndex={-1}
            aria-expanded={showDeleted}
            onClick={() => setShowDeleted((v) => !v)}
            className="flex h-[26px] w-full items-center gap-1 pr-2 pl-2 text-left text-neutral-500 hover:text-neutral-300"
          >
            <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
              <path
                d={showDeleted ? "M1 2l3 4 3-4z" : "M2 1l4 3-4 3z"}
                fill="currentColor"
              />
            </svg>
            Deleted bubbles
            <span>{deleted.length}</span>
          </button>
          {showDeleted &&
            deleted.map((b) => (
              <div
                key={b.id}
                className="flex h-[26px] items-center gap-2 pr-2 pl-6 text-neutral-600"
              >
                <span className="min-w-0 flex-1 truncate line-through">
                  {b.text.replace(/\s+/g, " ") || "(no text)"}
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onRestore(b.id)}
                  className="shrink-0 text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
                >
                  restore
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
