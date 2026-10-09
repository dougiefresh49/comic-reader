// The casting page's small parts: button classes in the app's neutral theme
// with the mockup's amber accent, icons, a portrait, and an anchored popover.
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FaceCrop, bestFace } from "./shared";
import type { CharacterCard, PageView } from "./types";

/** A visible keyboard focus ring, for every control on the page. */
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400";

export const BTN = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] font-medium whitespace-nowrap text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
export const BTN_PRIMARY = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-400 bg-amber-400 px-3 text-[13px] font-medium whitespace-nowrap text-neutral-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
export const BTN_GHOST = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
export const BTN_SMALL = `inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-[12px] whitespace-nowrap text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
/** A menu row in a popover. */
export const MENU_ITEM = `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
/** A count inside a button: "Review 3". */
export const COUNT = "rounded bg-black/20 px-1.5 font-mono text-[12px]";
/** A small uppercase section label: "Leads", "Voices". */
export const LABEL =
  "text-[11px] font-semibold tracking-[0.08em] text-neutral-500 uppercase";

const ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  "aria-hidden": true,
} as const;

export const Icon = {
  lock: (
    <svg {...ICON}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  ),
  more: (
    <svg {...ICON} fill="currentColor" stroke="none">
      <circle cx="3" cy="8" r="1.6" />
      <circle cx="8" cy="8" r="1.6" />
      <circle cx="13" cy="8" r="1.6" />
    </svg>
  ),
  chev: (
    <svg {...ICON} strokeWidth={1.8}>
      <path d="M5 3l5 5-5 5" />
    </svg>
  ),
  pencil: (
    <svg {...ICON}>
      <path d="M11 2l3 3-8 8H3v-3z" />
    </svg>
  ),
  sit: (
    <svg {...ICON}>
      <path d="M3 13h10M5 13V8h6v5M8 3v3" />
    </svg>
  ),
  out: (
    <svg {...ICON}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
};

/** A character's face: its exemplar crop when it has one, else its best face cut from the page, else its initial. */
export function Portrait({
  card,
  pages,
  className,
}: {
  card: Pick<CharacterCard, "faces" | "looseExemplars" | "name">;
  pages: Map<number, PageView>;
  className: string;
}) {
  const best = bestFace(card.faces, pages);
  const crop =
    best?.exemplar?.cropUrl ??
    [...card.looseExemplars].sort(
      (a, b) => Number(b.confirmed) - Number(a.confirmed),
    )[0]?.cropUrl;
  if (crop)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={crop}
        alt=""
        loading="lazy"
        className={`object-cover ${className}`}
      />
    );
  return (
    <FaceCrop face={best} pages={pages} alt={card.name} className={className} />
  );
}

/**
 * A small box anchored under (or over) the control that opened it. Escape
 * and a click outside close it and hand focus back to that control; focus
 * starts on its first control. Escape stops here, so the panel behind it
 * stays open.
 */
export function Popover({
  anchor,
  label,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.left;
    let y = r.bottom + 6;
    if (x + w > window.innerWidth - 10) x = r.right - w;
    if (y + h > window.innerHeight - 10) y = r.top - 6 - h;
    setPos({
      left: Math.max(10, Math.min(x, window.innerWidth - 10 - w)),
      top: Math.max(10, Math.min(y, window.innerHeight - 10 - h)),
    });
  }, [anchor]);

  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>(
      "input, button:not(:disabled), select, [tabindex='0']",
    );
    first?.focus();
    return () => {
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        width,
        maxHeight: "calc(100vh - 20px)",
      }}
      className="fixed z-50 min-w-[180px] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-1.5 text-[13px] text-neutral-200 shadow-2xl shadow-black/60"
    >
      {children}
    </div>
  );
}
