// Pieces the character cards, the unknown groups and the character panel share: the button classes, face crops, the name picker and the face tiles.
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PageCrop } from "~/components/review-editor/PageCrop";
import { slugify } from "~/lib/character-id";
import type { NameTarget } from "./actions";
import type {
  CharacterCard,
  FaceView,
  KnownCharacter,
  LooseExemplar,
  PageView,
} from "./types";

export const BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-neutral-700 px-3 text-[14px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
export const PRIMARY =
  "inline-flex h-8 shrink-0 items-center rounded-sm bg-neutral-100 px-3 text-[14px] font-medium whitespace-nowrap text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400";
export const QUIET =
  "inline-flex h-8 shrink-0 items-center rounded-sm px-2 text-[14px] whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";
export const DANGER =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-red-500/40 px-3 text-[14px] whitespace-nowrap text-red-200 hover:border-red-400 hover:bg-red-500/10 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
/** QUIET in red: a destructive text button with no border (the panel's Remove from this issue). */
export const QUIET_DANGER =
  "inline-flex h-8 shrink-0 items-center rounded-sm px-2 text-[14px] whitespace-nowrap text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:text-neutral-600 disabled:hover:bg-transparent";
export const INPUT =
  "h-8 w-full rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-[14px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400";
/** A square icon-only button, 28px: the panel's Rename pencil, the tiles' toolbar. Pair with an `aria-label` and a `title`. */
export const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:text-neutral-600 disabled:hover:bg-transparent";
/** ICON_BUTTON in the primary style: the Faces tab's check. */
export const ICON_PRIMARY =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-sm bg-neutral-100 text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400";
/** The props of a 16px stroked inline icon: spread onto an `<svg>`, then draw its paths. */
export const SVG_ICON = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** The name picker's match: a slugified query against the id, the name and the aliases. `q` is already slugified. */
export function matchesName(k: KnownCharacter, q: string): boolean {
  return (
    k.id.includes(q) ||
    slugify(k.name).includes(q) ||
    k.aliases.some((a) => slugify(a).includes(q))
  );
}

/** The query names this row outright, so "New character" is not offered. */
export function isExactName(k: KnownCharacter, q: string): boolean {
  return (
    k.id === q ||
    slugify(k.name) === q ||
    k.aliases.some((a) => slugify(a) === q)
  );
}

/** "1 face on page 3", "4 faces on pages 1, 2". */
export function facesLine(faces: FaceView[]): string {
  if (faces.length === 0) return "No faces in this issue";
  const pages = [...new Set(faces.map((f) => f.page))].sort((a, b) => a - b);
  return `${faces.length} ${faces.length === 1 ? "face" : "faces"} on ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`;
}

/** The most portrait-like face: close to square, not panel-sized, confident. */
export function bestFace(
  faces: FaceView[],
  pages: Map<number, PageView>,
): FaceView | null {
  let best: { f: FaceView; score: number } | null = null;
  for (const f of faces) {
    const p = pages.get(f.page);
    const aspect = p ? p.width / p.height : 0.65;
    const squareness = Math.abs(Math.log((f.rect.w * aspect) / f.rect.h));
    const score = f.confidence - squareness - f.rect.h * 2;
    if (!best || score > best.score) best = { f, score };
  }
  return best?.f ?? null;
}

export function FaceCrop({
  face,
  pages,
  className,
  alt,
  pad = 0.15,
}: {
  face: FaceView | null;
  pages: Map<number, PageView>;
  className: string;
  alt: string;
  pad?: number;
}) {
  const page = face ? pages.get(face.page) : undefined;
  if (!face || !page) {
    return (
      <div
        className={`flex aspect-square items-center justify-center bg-neutral-800 text-[22px] text-neutral-500 ${className}`}
      >
        {alt.charAt(0).toUpperCase() || "?"}
      </div>
    );
  }
  return (
    <PageCrop
      url={page.imageUrl}
      rect={face.rect}
      pageAspect={page.width / page.height}
      boxAspect={1}
      mode="cover"
      pad={pad}
      alt={alt}
      className={`bg-neutral-800 ${className}`}
    />
  );
}

/**
 * A name box: type, pick a character the book knows, or make a new one.
 * Enter takes the highlighted row; Escape cancels.
 */
export function NameField({
  known,
  placeholder,
  initial = "",
  autoFocus = false,
  submitLabel,
  busy = false,
  onPick,
  onCancel,
}: {
  known: KnownCharacter[];
  placeholder: string;
  initial?: string;
  autoFocus?: boolean;
  /** Shows a button that takes the highlighted row, for a box that arrives filled in. */
  submitLabel?: string;
  busy?: boolean;
  onPick: (target: NameTarget, label: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(autoFocus);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);

  const q = slugify(value);
  const matches = useMemo(() => {
    if (!q) return [] as KnownCharacter[];
    return known.filter((k) => matchesName(k, q)).slice(0, 6);
  }, [known, q]);
  const exact = known.find((k) => isExactName(k, q));
  const rows: { label: string; target: NameTarget; name: string }[] = [
    ...matches.map((m) => ({
      label: m.name,
      name: m.name,
      target: { kind: "existing", id: m.id } as NameTarget,
    })),
    ...(q && !exact
      ? [
          {
            label: `New character "${value.trim()}"`,
            name: value.trim(),
            target: { kind: "new", name: value.trim() } as NameTarget,
          },
        ]
      : []),
  ];
  const index = Math.min(active, Math.max(0, rows.length - 1));
  const take = () => {
    const row = rows[index];
    if (!row) return;
    onPick(row.target, row.name);
    setValue("");
    setOpen(false);
  };

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setValue(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((index + 1) % Math.max(1, rows.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((index - 1 + rows.length) % Math.max(1, rows.length));
          } else if (e.key === "Enter") {
            e.preventDefault();
            take();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setValue("");
            setOpen(false);
            onCancel?.();
          }
        }}
        className={INPUT}
      />
      {submitLabel && (
        <button
          type="button"
          disabled={busy || rows.length === 0}
          onClick={take}
          title={
            rows[index]
              ? rows[index].target.kind === "existing"
                ? `Name as ${rows[index].name}`
                : `Make a new character, ${rows[index].name}`
              : "Type a name first"
          }
          className={PRIMARY}
        >
          {submitLabel}
        </button>
      )}
      {open && rows.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-sm border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
          {rows.map((row, i) => (
            <button
              key={row.label}
              type="button"
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(row.target, row.name);
                setValue("");
                setOpen(false);
              }}
              className={`block h-8 w-full truncate px-2 text-left text-[14px] ${
                i === index
                  ? "bg-neutral-700/70 text-white"
                  : "text-neutral-300"
              }`}
            >
              {row.target.kind === "existing" ? (
                row.label
              ) : (
                <span className="text-emerald-200">{row.label}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The page with one face boxed: beside the faces, or large in the panel's overlay. */
export function PageWithBox({
  face,
  pages,
  label,
  frameClass = "max-h-[72vh]",
}: {
  face: FaceView;
  pages: Map<number, PageView>;
  label: string;
  /** The page frame's height cap. */
  frameClass?: string;
}) {
  const page = pages.get(face.page);
  if (!page) return null;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-[14px] text-neutral-400">
        Page {face.page}, {label}
      </figcaption>
      <div
        className={`relative overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900 ${frameClass}`}
        style={{ aspectRatio: `${page.width} / ${page.height}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={page.imageUrl}
          alt={`Page ${face.page}`}
          decoding="async"
          draggable={false}
          className="block h-full w-full select-none"
        />
        <div
          aria-hidden
          className="absolute rounded-sm border-2 border-amber-300 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
          style={{
            left: `${face.rect.x * 100}%`,
            top: `${face.rect.y * 100}%`,
            width: `${face.rect.w * 100}%`,
            height: `${face.rect.h * 100}%`,
          }}
        />
      </div>
    </figure>
  );
}

export function FaceTile({
  face,
  pages,
  label,
  known,
  busy,
  shown,
  onShow,
  onMove,
  onReject,
}: {
  face: FaceView;
  pages: Map<number, PageView>;
  label: string;
  known: KnownCharacter[];
  busy: boolean;
  shown: boolean;
  onShow: () => void;
  onMove: (target: NameTarget, name: string) => void;
  onReject: () => void;
}) {
  const [moving, setMoving] = useState(false);
  return (
    // 176px wide: a 160px crop, the caption on two lines, and three buttons in
    // three equal cells, so the longest labels ("Reject", "Shown", "no
    // exemplar") each stay inside their own tile at every width.
    <div
      className={`w-44 shrink-0 rounded-md border p-2 ${
        shown
          ? "border-amber-300/70 bg-neutral-900"
          : "border-neutral-800 bg-neutral-900/50"
      }`}
    >
      <button
        type="button"
        onClick={onShow}
        title="Show on the page"
        className="block w-full overflow-hidden rounded-sm"
      >
        <FaceCrop
          face={face}
          pages={pages}
          alt={`${label}, page ${face.page}`}
          className="w-full"
        />
      </button>
      <div className="mt-2 text-[14px] leading-5">
        <div className="text-neutral-300">Page {face.page}</div>
        {face.exemplar ? (
          <div
            title={
              face.exemplar.confirmed
                ? "Its exemplar is confirmed: the matcher uses it"
                : "Its exemplar is not confirmed yet"
            }
            className={
              face.exemplar.confirmed ? "text-emerald-300" : "text-amber-300"
            }
          >
            {face.exemplar.confirmed ? "Exemplar ✓" : "Exemplar, unconfirmed"}
          </div>
        ) : (
          <div className="text-neutral-600">No exemplar</div>
        )}
      </div>
      {moving ? (
        <div className="mt-2">
          <NameField
            known={known}
            placeholder="Move to…"
            autoFocus
            onPick={(target, name) => {
              setMoving(false);
              onMove(target, name);
            }}
            onCancel={() => setMoving(false)}
          />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-3 gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => setMoving(true)}
            className={`${QUIET} justify-center px-0`}
          >
            Move
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className={`${QUIET} justify-center px-0 hover:text-red-200`}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onShow}
            className={`${QUIET} justify-center px-0`}
            aria-pressed={shown}
          >
            {shown ? "Shown" : "Show"}
          </button>
        </div>
      )}
    </div>
  );
}

export function LooseStrip({ items }: { items: LooseExemplar[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 text-[14px] text-neutral-400">
        {items.length === 1 ? "An exemplar" : `${items.length} exemplars`} tied
        to a page, not a face. When the page has one face of this character, a
        move or reject takes {items.length === 1 ? "it" : "them"} along; with
        more faces there, {items.length === 1 ? "it stays" : "they stay"} here,
        unconfirmed. An unconfirmed one stays out of the matcher until it is
        dealt with; &quot;Faces are right&quot; does not confirm it.
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((e) => (
          <figure key={e.id} className="w-24">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={e.cropUrl}
              alt={`Exemplar from page ${e.page}`}
              className="aspect-square w-full rounded-sm bg-neutral-800 object-cover"
            />
            <figcaption className="mt-1 flex justify-between text-[14px]">
              <span className="text-neutral-400">Page {e.page}</span>
              <span
                className={e.confirmed ? "text-emerald-300" : "text-amber-300"}
              >
                {e.confirmed ? "✓" : "unconfirmed"}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The card's voice, as the collapsed card and the panel both state it. */
export function VoiceLine({ card }: { card: CharacterCard }) {
  if (card.noAudio)
    return <span className="text-neutral-300">No audio this run</span>;
  if (card.voice)
    return (
      <span className="text-neutral-300">
        {card.voice.name}
        {card.voice.borrowedFrom && (
          <span className="text-neutral-500">
            , {card.voice.borrowedFrom}&apos;s
          </span>
        )}
      </span>
    );
  return <span className="text-amber-300/90">No voice yet</span>;
}

/** The face tiles and the loose exemplars. The parent owns which face is shown and draws the page. */
export function FaceTiles({
  faces,
  loose,
  pages,
  label,
  known,
  busy,
  shownId,
  onShow,
  onMove,
  onReject,
}: {
  faces: FaceView[];
  loose: LooseExemplar[];
  pages: Map<number, PageView>;
  label: string;
  known: KnownCharacter[];
  busy: boolean;
  shownId: string | null;
  onShow: (faceId: string) => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
}) {
  return (
    <div className="min-w-0">
      {faces.length === 0 ? (
        <p className="text-[14px] text-neutral-500">
          No face detections in this issue.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {faces.map((f) => (
            <FaceTile
              key={f.id}
              face={f}
              pages={pages}
              label={label}
              known={known}
              busy={busy}
              shown={f.id === shownId}
              onShow={() => onShow(f.id)}
              onMove={(target, name) => onMove(f, target, name)}
              onReject={() => onReject(f)}
            />
          ))}
        </div>
      )}
      <LooseStrip items={loose} />
    </div>
  );
}

/** An opened unknown group's faces, with the page beside them once a face is shown. */
export function FacesPanel({
  faces,
  loose,
  pages,
  label,
  known,
  busy,
  onMove,
  onReject,
}: {
  faces: FaceView[];
  loose: LooseExemplar[];
  pages: Map<number, PageView>;
  label: string;
  known: KnownCharacter[];
  busy: boolean;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
}) {
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = faces.find((f) => f.id === shownId) ?? null;
  return (
    <div
      className={`mt-4 grid gap-5 ${shown ? "lg:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]" : ""}`}
    >
      <FaceTiles
        faces={faces}
        loose={loose}
        pages={pages}
        label={label}
        known={known}
        busy={busy}
        shownId={shownId}
        onShow={(id) => setShownId((cur) => (cur === id ? null : id))}
        onMove={onMove}
        onReject={onReject}
      />
      {shown && <PageWithBox face={shown} pages={pages} label={label} />}
    </div>
  );
}

/**
 * A modal's chrome: the shape of the admin's StartConfirmDialog, a dimmed
 * backdrop that cancels on click, the box in the middle. Escape is the
 * caller's to handle (the character panel's window listener closes the
 * innermost open thing first), so this adds no key listener. `className`
 * sizes and lays out the box; the default is the confirm's 440px.
 */
export function DialogFrame({
  role = "dialog",
  labelledBy,
  describedBy,
  className = "w-[440px] space-y-3",
  onCancel,
  children,
}: {
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  className?: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={onCancel}
      className="fixed inset-0 z-[35] flex items-center justify-center bg-neutral-950/80 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`max-w-full rounded-md border border-neutral-700 bg-neutral-900 p-4 text-[14px] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** A yes-or-no confirm over the screen, in the DialogFrame, without StartConfirmDialog's typed check. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <DialogFrame
      role="alertdialog"
      labelledBy={headingId}
      describedBy={bodyId}
      onCancel={onCancel}
    >
      <h2 id={headingId} className="text-[16px] font-medium text-neutral-100">
        {title}
      </h2>
      <p id={bodyId} className="text-neutral-400">
        {body}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={DANGER}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}
