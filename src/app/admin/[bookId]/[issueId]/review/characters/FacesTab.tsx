// The panel's Faces tab (#745): the exemplar summary with two icon buttons, the face tiles with an icon toolbar each, and a select mode that moves or rejects several faces at once.
"use client";

import { useEffect, useRef, useState } from "react";
import {
  FaceCrop,
  ICON_BUTTON,
  ICON_PRIMARY,
  LooseStrip,
  QUIET,
  SVG_ICON,
} from "./shared";
import type { CharacterCard, FaceView, PageView } from "./types";

/** Stacked checkboxes: select mode. */
function SelectIcon() {
  return (
    <svg {...SVG_ICON}>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...SVG_ICON}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** An arrow into a box: move to another character. */
function MoveIcon() {
  return (
    <svg {...SVG_ICON}>
      <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      <path d="M3 12h12" />
      <path d="m11 8 4 4-4 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...SVG_ICON}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg {...SVG_ICON}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** The caption under a crop: the page, then the exemplar's state. */
function FaceCaption({ face }: { face: FaceView }) {
  return (
    <span className="block text-[14px] leading-5">
      <span className="block text-neutral-300">Page {face.page}</span>
      {face.exemplar ? (
        <span
          title={
            face.exemplar.confirmed
              ? "Its exemplar is confirmed: the matcher uses it"
              : "Its exemplar is not confirmed yet"
          }
          className={`block truncate ${
            face.exemplar.confirmed ? "text-emerald-300" : "text-amber-300"
          }`}
        >
          {face.exemplar.confirmed ? "Exemplar ✓" : "Exemplar, unconfirmed"}
        </span>
      ) : (
        <span className="block text-neutral-600">No exemplar</span>
      )}
    </span>
  );
}

/**
 * The panel's face tile: a picture with a caption and a small toolbar (Move,
 * Reject, Show). In select mode the whole tile is a checkbox and the toolbar
 * is gone. The "Needs a name" cards keep shared's FaceTile.
 */
function PanelFaceTile({
  face,
  pages,
  label,
  busy,
  shown,
  selecting,
  selected,
  onToggle,
  onShow,
  onMove,
  onReject,
}: {
  face: FaceView;
  pages: Map<number, PageView>;
  label: string;
  busy: boolean;
  shown: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onShow: () => void;
  /** Opens the move dialog; the button is the control focus returns to. */
  onMove: (opener: HTMLElement) => void;
  onReject: () => void;
}) {
  const frame = `rounded-md border p-2 ${
    shown
      ? "border-amber-300/70 bg-neutral-900"
      : selected
        ? "border-neutral-400 bg-neutral-900"
        : "border-neutral-800 bg-neutral-900/50"
  }`;
  const crop = (
    <FaceCrop
      face={face}
      pages={pages}
      alt={`${label}, page ${face.page}`}
      className="w-full"
    />
  );
  if (selecting) {
    return (
      <button
        type="button"
        role="checkbox"
        name="face"
        aria-checked={selected}
        aria-label={`Page ${face.page} face`}
        onClick={onToggle}
        className={`${frame} text-left hover:border-neutral-500`}
      >
        <span className="relative block overflow-hidden rounded-sm">
          {crop}
          <span
            aria-hidden
            className={`absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-sm border ${
              selected
                ? "border-white bg-white text-neutral-950"
                : "border-neutral-300 bg-neutral-950/70"
            }`}
          >
            {selected && <CheckIcon />}
          </span>
        </span>
        <span className="mt-2 block">
          <FaceCaption face={face} />
        </span>
      </button>
    );
  }
  return (
    <div className={frame}>
      <button
        type="button"
        onClick={onShow}
        title="Show on the page"
        className="block w-full overflow-hidden rounded-sm"
      >
        {crop}
      </button>
      <div className="mt-2">
        <FaceCaption face={face} />
      </div>
      <div className="mt-1 -ml-1.5 flex items-center gap-0.5">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => onMove(e.currentTarget)}
          aria-label="Move to another character"
          title="Move to another character"
          className={ICON_BUTTON}
        >
          <MoveIcon />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          aria-label="Reject this face"
          title="Reject this face: not this character, not anyone"
          className={`${ICON_BUTTON} hover:text-red-200`}
        >
          <TrashIcon />
        </button>
        <button
          type="button"
          onClick={onShow}
          aria-pressed={shown}
          aria-label="Show on the page"
          title={shown ? "Shown on the page" : "Show on the page"}
          className={`${ICON_BUTTON} ${shown ? "bg-neutral-800 text-amber-200" : ""}`}
        >
          <EyeIcon />
        </button>
      </div>
    </div>
  );
}

export interface FacesTabProps {
  card: CharacterCard;
  pages: Map<number, PageView>;
  busy: boolean;
  /** Select mode lives in the panel, so its Escape listener can leave it. */
  selecting: boolean;
  onSelectingChange: (selecting: boolean) => void;
  shownId: string | null;
  onShow: (faceId: string) => void;
  onConfirm: () => void;
  /** Opens the move dialog for these faces; focus returns to `opener` when it closes. */
  onMoveRequest: (faces: FaceView[], opener: HTMLElement) => void;
  onReject: (face: FaceView) => void;
  /** Rejects the selection in one action. */
  onRejectMany: (faces: FaceView[]) => void;
}

/**
 * The Faces tab. The header reads the exemplar summary on the left, and on
 * the right the select icon and the primary check ("Faces are right"). Select
 * mode turns the tiles into checkboxes under a bar with "N selected", the
 * tiles' Move and Reject icons, and Done. The selection is the ids still on
 * the card, so a face that has moved away or been rejected drops out of the
 * count by itself.
 */
export function FacesTab({
  card,
  pages,
  busy,
  selecting,
  onSelectingChange,
  shownId,
  onShow,
  onConfirm,
  onMoveRequest,
  onReject,
  onRejectMany,
}: FacesTabProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectRef = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  // Leaving select mode unmounts Done and the bar's icons; a focus they held goes back to the select icon.
  useEffect(() => {
    if (
      wasSelecting.current &&
      !selecting &&
      document.activeElement === document.body
    )
      selectRef.current?.focus();
    wasSelecting.current = selecting;
  }, [selecting]);

  const selected = card.faces.filter((f) => selectedIds.has(f.id));
  const selectedFaces = `${selected.length} ${selected.length === 1 ? "face" : "faces"}`;
  const unconfirmed =
    card.faces.filter((f) => f.exemplar && !f.exemplar.confirmed).length +
    card.looseExemplars.filter((e) => !e.confirmed).length;
  const exemplars =
    card.faces.filter((f) => f.exemplar).length + card.looseExemplars.length;
  const toggle = (id: string) =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <span className="text-[14px] text-neutral-500">
          {exemplars === 0
            ? "No exemplars yet"
            : `${exemplars} ${exemplars === 1 ? "exemplar" : "exemplars"}${
                unconfirmed > 0
                  ? `, ${unconfirmed} unconfirmed`
                  : ", all confirmed"
              }`}
        </span>
        {card.faces.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              ref={selectRef}
              type="button"
              aria-pressed={selecting}
              aria-label="Select faces"
              title="Select faces"
              onClick={() => {
                if (selecting) onSelectingChange(false);
                else {
                  setSelectedIds(new Set());
                  onSelectingChange(true);
                }
              }}
              className={`${ICON_BUTTON} ${selecting ? "bg-neutral-800 text-white" : ""}`}
            >
              <SelectIcon />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              aria-label="Faces are right"
              title="Faces are right: confirm this character's exemplars from this issue, so the matcher uses them on later issues"
              className={ICON_PRIMARY}
            >
              <CheckIcon />
            </button>
          </div>
        )}
      </div>

      {selecting && card.faces.length > 0 && (
        <div className="mb-3 flex h-9 items-center justify-between gap-2 rounded-sm border border-neutral-700 bg-neutral-900 px-2 text-[14px]">
          <span className="text-neutral-300">{selected.length} selected</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy || selected.length === 0}
              onClick={(e) => onMoveRequest(selected, e.currentTarget)}
              aria-label={`Move ${selectedFaces} to another character`}
              title={`Move ${selectedFaces} to another character`}
              className={ICON_BUTTON}
            >
              <MoveIcon />
            </button>
            <button
              type="button"
              disabled={busy || selected.length === 0}
              onClick={() => onRejectMany(selected)}
              aria-label={`Reject ${selectedFaces}`}
              title={`Reject ${selectedFaces}: not this character, not anyone`}
              className={`${ICON_BUTTON} hover:text-red-200`}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              onClick={() => onSelectingChange(false)}
              className={`${QUIET} ml-1 h-7`}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {card.faces.length === 0 ? (
        <p className="text-[14px] text-neutral-500">
          No face detections in this issue.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {card.faces.map((f) => (
            <PanelFaceTile
              key={f.id}
              face={f}
              pages={pages}
              label={card.name}
              busy={busy}
              shown={f.id === shownId}
              selecting={selecting}
              selected={selectedIds.has(f.id)}
              onToggle={() => toggle(f.id)}
              onShow={() => onShow(f.id)}
              onMove={(opener) => onMoveRequest([f], opener)}
              onReject={() => onReject(f)}
            />
          ))}
        </div>
      )}
      <LooseStrip items={card.looseExemplars} />
    </>
  );
}
