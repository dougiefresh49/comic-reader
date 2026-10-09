"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTabTrap } from "~/hooks/useTabTrap";

function counted(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * The typed confirm for Start Pipeline on an issue that already has bubbles
 * (#319). trigger-ingest refuses that start until the issue id is sent back.
 * Portalled to the body so a table cell or clipped ancestor cannot trap it.
 */
export function StartConfirmDialog({
  issueId,
  bubbles,
  pages,
  busy,
  onConfirm,
  onCancel,
}: {
  issueId: string;
  bubbles: number;
  pages: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const headingId = useId();
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const matches = typed.trim() === issueId;

  useTabTrap(formRef);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/80"
      onClick={onCancel}
    >
      <form
        ref={formRef}
        className="w-[440px] max-w-[94vw] space-y-3 rounded border border-neutral-700 bg-neutral-900 p-4 text-left text-sm"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm();
        }}
      >
        <h2 id={headingId} className="font-medium text-neutral-100">
          Start the pipeline on {issueId} again?
        </h2>
        <p className="text-neutral-400">
          {issueId} already has {counted(bubbles, "bubble")} on{" "}
          {counted(pages, "page")}. Starting from the beginning rewrites the
          reading order of every panel and bubble and the word boxes of every
          spoken bubble, fills in text, speaker, emotion and cues on any bubble
          that has none of them yet, and renders audio for any bubble without
          it. It spends Gemini on reading order and on each bubble with no text
          yet, Cloud Vision on every page with spoken bubbles, and ElevenLabs
          credits on each bubble it renders. Roboflow segments only pages it has
          not segmented yet, and runs text detection on any page with no bubble
          rows.
        </p>
        <p className="font-mono text-xs text-neutral-500">
          Columns rewritten: panels.sort_order, panels.foreground_polygons,
          bubbles.sort_order, bubbles.text_geometry, bubbles.fill_color
        </p>
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-xs text-neutral-300">
            Type {issueId} to confirm
          </label>
          <input
            id={inputId}
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm text-neutral-100 focus:border-amber-600 focus:outline-none"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-neutral-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {busy ? "..." : "Start anyway"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
