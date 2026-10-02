// The characters stop: the cast and its faces on one screen, in four groups. Every action saves when made.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { PageCrop } from "~/components/review-editor/PageCrop";
import { slugify } from "~/lib/character-id";
import {
  addCharacter,
  approveCharacters,
  confirmFaces,
  moveFace,
  nameGroup,
  nameWikiSuggestion,
  rejectFace,
  rejectGroup,
  removeCharacter,
  renameCharacter,
  type ActionResult,
  type NameTarget,
} from "./actions";
import type {
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  LooseExemplar,
  PageView,
  UnknownGroupView,
  WikiSuggestion,
} from "./types";

const BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-neutral-700 px-3 text-[14px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
const PRIMARY =
  "inline-flex h-8 shrink-0 items-center rounded-sm bg-neutral-100 px-3 text-[14px] font-medium whitespace-nowrap text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400";
const QUIET =
  "inline-flex h-8 shrink-0 items-center rounded-sm px-2 text-[14px] whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";
const DANGER =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-red-500/40 px-3 text-[14px] whitespace-nowrap text-red-200 hover:border-red-400 hover:bg-red-500/10 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
const INPUT =
  "h-8 w-full rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-[14px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400";

type Note = { text: string; tone: "plain" | "warn" } | null;

/** "1 face on page 3", "4 faces on pages 1, 2". */
function facesLine(faces: FaceView[]): string {
  if (faces.length === 0) return "No faces in this issue";
  const pages = [...new Set(faces.map((f) => f.page))].sort((a, b) => a - b);
  return `${faces.length} ${faces.length === 1 ? "face" : "faces"} on ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`;
}

/** The most portrait-like face: close to square, not panel-sized, confident. */
function bestFace(
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

function FaceCrop({
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
function NameField({
  known,
  placeholder,
  initial = "",
  autoFocus = false,
  onPick,
  onCancel,
}: {
  known: KnownCharacter[];
  placeholder: string;
  initial?: string;
  autoFocus?: boolean;
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
    return known
      .filter(
        (k) =>
          k.id.includes(q) ||
          slugify(k.name).includes(q) ||
          k.aliases.some((a) => slugify(a).includes(q)),
      )
      .slice(0, 6);
  }, [known, q]);
  const exact = known.find(
    (k) =>
      k.id === q ||
      slugify(k.name) === q ||
      k.aliases.some((a) => slugify(a) === q),
  );
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

  return (
    <div className="relative min-w-0 flex-1">
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
            const row = rows[index];
            if (row) {
              onPick(row.target, row.name);
              setValue("");
              setOpen(false);
            }
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setValue("");
            setOpen(false);
            onCancel?.();
          }
        }}
        className={INPUT}
      />
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

/** The page with one face boxed, scaled to fit beside the faces. */
function PageWithBox({
  face,
  pages,
  label,
}: {
  face: FaceView;
  pages: Map<number, PageView>;
  label: string;
}) {
  const page = pages.get(face.page);
  if (!page) return null;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-[14px] text-neutral-400">
        Page {face.page}, {label}
      </figcaption>
      <div
        className="relative max-h-[72vh] overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900"
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

function FaceTile({
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
    <div
      className={`w-36 shrink-0 rounded-md border p-2 ${
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
      <div className="mt-2 flex items-center justify-between text-[14px]">
        <span className="text-neutral-300">Page {face.page}</span>
        {face.exemplar ? (
          <span
            title={
              face.exemplar.confirmed
                ? "Its exemplar is confirmed: the matcher uses it"
                : "Its exemplar is not confirmed yet"
            }
            className={`text-[13px] ${face.exemplar.confirmed ? "text-emerald-300" : "text-amber-300"}`}
          >
            {face.exemplar.confirmed ? "exemplar ✓" : "exemplar"}
          </span>
        ) : (
          <span className="text-[13px] text-neutral-600">no exemplar</span>
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
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => setMoving(true)}
            className={`${QUIET} px-1.5`}
          >
            Move
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className={`${QUIET} px-1.5 hover:text-red-200`}
          >
            Reject
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onShow}
            className={`${QUIET} px-1.5`}
            aria-pressed={shown}
          >
            {shown ? "Shown" : "Show"}
          </button>
        </div>
      )}
    </div>
  );
}

function LooseStrip({ items }: { items: LooseExemplar[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 text-[14px] text-neutral-400">
        {items.length === 1 ? "An exemplar" : `${items.length} exemplars`} tied
        to a page, not a face. A move or reject on that page leaves{" "}
        {items.length === 1 ? "it" : "them"} here, unconfirmed.
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
            <figcaption className="mt-1 flex justify-between text-[13px]">
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

/** The opened card's faces, with the page beside them once a face is shown. */
function FacesPanel({
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
                onShow={() => setShownId((id) => (id === f.id ? null : f.id))}
                onMove={(target, name) => onMove(f, target, name)}
                onReject={() => onReject(f)}
              />
            ))}
          </div>
        )}
        <LooseStrip items={loose} />
      </div>
      {shown && <PageWithBox face={shown} pages={pages} label={label} />}
    </div>
  );
}

function CharacterCardView({
  card,
  pages,
  known,
  open,
  busy,
  onOpen,
  onClose,
  onRename,
  onRemove,
  onAddBack,
  onConfirm,
  onMakeRow,
  onMove,
  onReject,
}: {
  card: CharacterCard;
  pages: Map<number, PageView>;
  known: KnownCharacter[];
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onAddBack: () => void;
  onConfirm: () => void;
  onMakeRow: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(card.name);
  const portrait = useMemo(
    () => bestFace(card.faces, pages),
    [card.faces, pages],
  );
  const unconfirmed =
    card.faces.filter((f) => f.exemplar && !f.exemplar.confirmed).length +
    card.looseExemplars.filter((e) => !e.confirmed).length;
  const exemplars =
    card.faces.filter((f) => f.exemplar).length + card.looseExemplars.length;

  const voice = card.voice ? (
    <span className="text-neutral-300">
      {card.voice.name}
      {card.voice.borrowedFrom && (
        <span className="text-neutral-500">
          , {card.voice.borrowedFrom}&apos;s
        </span>
      )}
    </span>
  ) : (
    <span className="text-amber-300/90">No voice yet</span>
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full items-start gap-4 rounded-md border border-neutral-800 bg-neutral-900/60 p-4 text-left hover:border-neutral-600 ${
          card.removed ? "opacity-60" : ""
        }`}
      >
        <FaceCrop
          face={portrait}
          pages={pages}
          alt={card.name}
          className="size-20 shrink-0 rounded-md"
        />
        <div className="min-w-0 flex-1 text-[14px]">
          <div className="truncate text-[16px] font-medium text-neutral-100">
            {card.name}
          </div>
          <div className="mt-1 text-neutral-400">
            {card.group === "role" ? "Role, no faces" : facesLine(card.faces)}
          </div>
          <div className="mt-1 truncate">{voice}</div>
          {card.removed && (
            <div className="mt-1 text-amber-300">Out of this issue</div>
          )}
          {!card.removed &&
            card.group === "here" &&
            card.faces.length === 0 && (
              <div className="mt-1 truncate text-neutral-500">
                From the wiki
                {card.wikiNames.length > 0
                  ? `: ${card.wikiNames.join(", ")}`
                  : ""}
              </div>
            )}
        </div>
      </button>
    );
  }

  return (
    <section
      className="col-span-full rounded-md border border-neutral-600 bg-neutral-900/80 p-5"
      aria-label={card.name}
    >
      <div className="flex flex-wrap items-start gap-4">
        <FaceCrop
          face={portrait}
          pages={pages}
          alt={card.name}
          className="size-24 shrink-0 rounded-md"
        />
        <div className="min-w-0 flex-1 text-[14px]">
          {renaming ? (
            <form
              className="flex max-w-md items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
                if (draft.trim() && draft.trim() !== card.name) onRename(draft);
              }}
            >
              <input
                value={draft}
                autoFocus
                aria-label="Display name"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(false);
                    setDraft(card.name);
                  }
                }}
                className={`${INPUT} text-[16px]`}
              />
              <button type="submit" className={PRIMARY} disabled={busy}>
                Save
              </button>
              <button
                type="button"
                className={QUIET}
                onClick={() => {
                  setRenaming(false);
                  setDraft(card.name);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-[18px] font-semibold text-neutral-50">
                {card.name}
              </h3>
              <span className="text-neutral-500">{card.id}</span>
              {card.hasRow && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(card.name);
                    setRenaming(true);
                  }}
                  className={`${QUIET} h-7`}
                >
                  Rename
                </button>
              )}
            </div>
          )}
          <div className="mt-1 text-neutral-400">
            {card.group === "role" ? "Role, no faces" : facesLine(card.faces)}
            {exemplars > 0 && (
              <>
                {" · "}
                {exemplars} {exemplars === 1 ? "exemplar" : "exemplars"}
                {unconfirmed > 0
                  ? `, ${unconfirmed} unconfirmed`
                  : ", all confirmed"}
              </>
            )}
          </div>
          <div className="mt-1">
            <span className="text-neutral-500">Voice: </span>
            {voice}
            <span className="text-neutral-600"> · set at the voices stop</span>
          </div>
          {card.wikiNames.length > 0 && (
            <div className="mt-1 text-neutral-500">
              Wiki: {card.wikiNames.join(", ")}
            </div>
          )}
          {!card.hasRow && (
            <div className="mt-1 text-amber-300">
              A castlist name with no character row. Make the row to give it
              faces and a voice.
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {card.faces.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className={PRIMARY}
              title="Confirm this character's exemplars from this issue, so the matcher uses them on later issues"
            >
              Faces are right
            </button>
          )}
          {!card.hasRow ? (
            <button
              type="button"
              disabled={busy}
              onClick={onMakeRow}
              className={BUTTON}
            >
              Make the character row
            </button>
          ) : card.removed ? (
            <button
              type="button"
              disabled={busy}
              onClick={onAddBack}
              className={BUTTON}
            >
              Add back to this issue
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className={DANGER}
            >
              Remove from this issue
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={QUIET}
            aria-label="Close"
          >
            Close
          </button>
        </div>
      </div>
      {card.group !== "role" && (
        <FacesPanel
          faces={card.faces}
          loose={card.looseExemplars}
          pages={pages}
          label={card.name}
          known={known}
          busy={busy}
          onMove={onMove}
          onReject={onReject}
        />
      )}
    </section>
  );
}

function UnknownCardView({
  group,
  pages,
  known,
  open,
  busy,
  onOpen,
  onClose,
  onName,
  onReject,
  onMove,
  onRejectFace,
}: {
  group: UnknownGroupView;
  pages: Map<number, PageView>;
  known: KnownCharacter[];
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onName: (target: NameTarget, name: string) => void;
  onReject: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onRejectFace: (face: FaceView) => void;
}) {
  const hint = group.suggestedNames.join(", ");
  const label = hint ? `Unknown, maybe ${hint}` : "Unknown";
  const strip = group.faces.slice(0, open ? 0 : 3);
  return (
    <section
      className={`rounded-md border p-4 ${
        open
          ? "col-span-full border-amber-300/60 bg-neutral-900/80 p-5"
          : "border-amber-400/40 bg-amber-400/5"
      }`}
      aria-label={label}
    >
      <div className="flex flex-wrap items-start gap-4">
        {open ? (
          <FaceCrop
            face={group.faces[0] ?? null}
            pages={pages}
            alt={label}
            className="size-24 shrink-0 rounded-md"
          />
        ) : (
          <button
            type="button"
            onClick={onOpen}
            title="See every face"
            className="flex shrink-0 gap-1"
          >
            {strip.map((f) => (
              <FaceCrop
                key={f.id}
                face={f}
                pages={pages}
                alt={`${label}, page ${f.page}`}
                className="size-20 rounded-md"
              />
            ))}
          </button>
        )}
        <div className="min-w-0 flex-1 text-[14px]">
          <div className="text-[16px] font-medium text-amber-100">
            Who is this?
          </div>
          <div className="mt-1 text-neutral-300">{facesLine(group.faces)}</div>
          {hint && (
            <div className="mt-1 text-neutral-400">
              The lookahead guessed:{" "}
              <span className="text-neutral-200">{hint}</span>
            </div>
          )}
          <div className="mt-3 flex max-w-md items-center gap-2">
            <NameField
              known={known}
              placeholder="Name this group, or type a new name"
              initial={group.suggestedNames[0] ?? ""}
              onPick={onName}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className={DANGER}
          >
            Not a character
          </button>
          <button
            type="button"
            onClick={open ? onClose : onOpen}
            className={QUIET}
          >
            {open ? "Close" : "Every face"}
          </button>
        </div>
      </div>
      {open && (
        <FacesPanel
          faces={group.faces}
          loose={group.looseExemplars}
          pages={pages}
          label={label}
          known={known}
          busy={busy}
          onMove={onMove}
          onReject={onRejectFace}
        />
      )}
    </section>
  );
}

function SuggestionRow({
  suggestion,
  known,
  busy,
  onName,
}: {
  suggestion: WikiSuggestion;
  known: KnownCharacter[];
  busy: boolean;
  onName: (target: NameTarget, name: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const label = suggestion.qualifier
    ? `${suggestion.name} (${suggestion.qualifier})`
    : suggestion.name;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-1">
        <span className="text-neutral-100">{label}</span>
        <span className="text-neutral-500">
          {" "}
          · named on the wiki, no character row
        </span>
      </span>
      {naming ? (
        <div className="flex w-full max-w-md items-center gap-2">
          <NameField
            known={known}
            placeholder="Who is this?"
            initial={suggestion.name}
            autoFocus
            onPick={(target, name) => {
              setNaming(false);
              onName(target, name);
            }}
            onCancel={() => setNaming(false)}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onName({ kind: "new", name: suggestion.name }, suggestion.name)
            }
            className={BUTTON}
          >
            New character
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setNaming(true)}
            className={BUTTON}
          >
            Is someone known…
          </button>
        </>
      )}
    </li>
  );
}

function Section({
  title,
  blurb,
  count,
  action,
  children,
}: {
  title: string;
  blurb: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <h2 className="text-[18px] font-semibold text-neutral-50">
          {title} <span className="font-normal text-neutral-500">{count}</span>
        </h2>
        <p className="min-w-0 flex-1 text-[14px] text-neutral-500">{blurb}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3";

export function CharactersScreen({ data }: { data: CharactersData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [approved, setApproved] = useState(false);
  const pages = useMemo(
    () => new Map(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );
  const scope = useMemo(
    () => ({ bookId: data.bookId, issueId: data.issueId }),
    [data.bookId, data.issueId],
  );

  const run = useCallback(
    (label: string, work: () => Promise<ActionResult>) => {
      setNote({ text: `${label}…`, tone: "plain" });
      startTransition(async () => {
        const result = await work();
        setNote(
          result.ok
            ? { text: result.message, tone: "plain" }
            : { text: result.error, tone: "warn" },
        );
        router.refresh();
      });
    },
    [router],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const here = data.cards.filter((c) => c.group === "here");
  const before = data.cards.filter((c) => c.group === "before");
  const roles = data.cards.filter((c) => c.group === "role");
  const castCount = data.cards.filter((c) => !c.removed).length;
  const needs = data.unknown.length;
  const notInCast = useMemo(() => {
    const present = new Set(
      data.cards.filter((c) => !c.removed).map((c) => c.id),
    );
    return data.known.filter((k) => !present.has(k.id));
  }, [data.cards, data.known]);

  const cardProps = (card: CharacterCard) => ({
    card,
    pages,
    known: data.known,
    open: openKey === card.id,
    busy: pending,
    onOpen: () => setOpenKey(card.id),
    onClose: () => setOpenKey(null),
    onRename: (name: string) =>
      run("Renaming", () =>
        renameCharacter({ scope, characterId: card.id, name }),
      ),
    onRemove: () =>
      run(`Removing ${card.name}`, () =>
        removeCharacter({ scope, characterId: card.id, name: card.name }),
      ),
    onAddBack: () =>
      run(`Adding ${card.name} back`, () =>
        addCharacter({
          scope,
          target: { kind: "existing", id: card.id },
          franchise: data.franchise,
        }),
      ),
    onConfirm: () =>
      run("Confirming the faces", () =>
        confirmFaces({ scope, characterId: card.id }),
      ),
    onMakeRow: () =>
      run(`Making ${card.name}`, () =>
        addCharacter({
          scope,
          target: { kind: "new", name: card.name },
          franchise: data.franchise,
        }),
      ),
    onMove: (face: FaceView, target: NameTarget, name: string) =>
      run(`Moving the page ${face.page} face to ${name}`, () =>
        moveFace({
          scope,
          detectionId: face.id,
          target,
          franchise: data.franchise,
        }),
      ),
    onReject: (face: FaceView) =>
      run(`Dropping the page ${face.page} face`, () =>
        rejectFace({ scope, detectionId: face.id }),
      ),
  });

  return (
    <div className="min-h-screen bg-neutral-950 text-[14px] text-neutral-200">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-4 backdrop-blur">
        <nav className="flex min-w-0 items-center gap-1.5 text-neutral-500">
          <Link href="/admin" className="hover:text-neutral-100">
            Admin
          </Link>
          <span>/</span>
          <Link
            href={`/admin/${data.bookId}/${data.issueId}/review/pipeline`}
            className="truncate hover:text-neutral-100"
          >
            {data.bookName}, {data.issueName}
          </Link>
          <span>/</span>
          <span className="shrink-0 text-neutral-100">Characters</span>
        </nav>
        <span className="flex-1" />
        <span
          className={`hidden truncate sm:inline ${data.blocker ? "text-amber-200" : "text-emerald-300"}`}
        >
          {data.blocker ?? `Cast of ${castCount}. Nothing needs you.`}
        </span>
        {approved ? (
          <span className="rounded-sm bg-emerald-700/30 px-3 py-1.5 font-medium text-emerald-200">
            Pipeline resumed
          </span>
        ) : (
          <button
            type="button"
            disabled={pending || data.blocker !== null}
            title={
              data.blocker ?? "Seed the cast as shown and resume the pipeline"
            }
            onClick={() =>
              run("Approving", async () => {
                const result = await approveCharacters(scope);
                if (result.ok) setApproved(true);
                return result;
              })
            }
            className={PRIMARY}
          >
            Approve the cast
          </button>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="mb-8 max-w-3xl text-[15px] text-neutral-400">
          Everyone the run thinks is in {data.issueName}: faces the lookahead
          could not name first, then the characters it saw or the wiki lists,
          then the book&apos;s earlier cast, then the roles. Open a card for
          every face. Each change saves as you make it.
        </p>

        <Section
          title="Needs a name"
          blurb="Faces with no character, and wiki names the book does not know. Faces block Approve; wiki names do not."
          count={needs + data.suggestions.length}
        >
          {needs === 0 && data.suggestions.length === 0 ? (
            <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
              Every face has a name.
            </p>
          ) : (
            <>
              {needs > 0 && (
                <div className={`${GRID} mb-3`}>
                  {data.unknown.map((g) => (
                    <UnknownCardView
                      key={g.key}
                      group={g}
                      pages={pages}
                      known={data.known}
                      open={openKey === `unknown:${g.key}`}
                      busy={pending}
                      onOpen={() => setOpenKey(`unknown:${g.key}`)}
                      onClose={() => setOpenKey(null)}
                      onName={(target, name) =>
                        run(
                          `Naming ${g.faces.length} ${g.faces.length === 1 ? "face" : "faces"} ${name}`,
                          () =>
                            nameGroup({
                              scope,
                              detectionIds: g.faces.map((f) => f.id),
                              suggestedNames: g.suggestedNames,
                              target,
                              franchise: data.franchise,
                            }),
                        )
                      }
                      onReject={() =>
                        run("Dropping the group", () =>
                          rejectGroup({
                            scope,
                            detectionIds: g.faces.map((f) => f.id),
                            suggestedNames: g.suggestedNames,
                          }),
                        )
                      }
                      onMove={(face, target, name) =>
                        run(`Naming the page ${face.page} face ${name}`, () =>
                          moveFace({
                            scope,
                            detectionId: face.id,
                            target,
                            franchise: data.franchise,
                          }),
                        )
                      }
                      onRejectFace={(face) =>
                        run(`Dropping the page ${face.page} face`, () =>
                          rejectFace({ scope, detectionId: face.id }),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              {data.suggestions.length > 0 && (
                <ul className="space-y-2">
                  {data.suggestions.map((s) => (
                    <SuggestionRow
                      key={`${s.name}|${s.qualifier}`}
                      suggestion={s}
                      known={data.known}
                      busy={pending}
                      onName={(target, name) =>
                        run(`Naming ${s.name} as ${name}`, () =>
                          nameWikiSuggestion({
                            scope,
                            name: s.name,
                            target,
                            franchise: data.franchise,
                          }),
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>

        <Section
          title="In this issue"
          blurb="A face the lookahead named, or a wiki mention. Remove who is not here."
          count={here.filter((c) => !c.removed).length}
          action={
            adding ? (
              <div className="flex w-full max-w-md items-center gap-2 sm:w-auto">
                <NameField
                  known={notInCast}
                  placeholder="Add a character, known or new"
                  autoFocus
                  onPick={(target, name) => {
                    setAdding(false);
                    run(`Adding ${name}`, () =>
                      addCharacter({
                        scope,
                        target,
                        franchise: data.franchise,
                      }),
                    );
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className={BUTTON}
              >
                Add a character
              </button>
            )
          }
        >
          {here.length === 0 ? (
            <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
              No named faces and no wiki names yet.
            </p>
          ) : (
            <div className={GRID}>
              {here.map((card) => (
                <CharacterCardView key={card.id} {...cardProps(card)} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Cast before, no sign here"
          blurb="In the book's castlist from an earlier issue, with no face or wiki mention in this one. Remove who is absent."
          count={before.length}
        >
          {before.length === 0 ? (
            <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
              Nobody carried over without a sign here.
            </p>
          ) : (
            <div className={GRID}>
              {before.map((card) => (
                <CharacterCardView key={card.id} {...cardProps(card)} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Roles"
          blurb="The narrator, off-panel speech and the crowd. Always offered; their voices are set at the voices stop."
          count={roles.length}
        >
          <div className={GRID}>
            {roles.map((card) => (
              <CharacterCardView key={card.id} {...cardProps(card)} />
            ))}
          </div>
        </Section>
      </main>

      {note && (
        <div
          role="status"
          className={`pointer-events-none fixed bottom-4 left-1/2 z-40 max-w-[80vw] -translate-x-1/2 rounded-sm border px-4 py-2 text-[14px] shadow-lg ${
            note.tone === "warn"
              ? "border-amber-400/60 bg-neutral-950 text-amber-200"
              : "border-neutral-600 bg-neutral-950 text-neutral-100"
          }`}
        >
          {pending ? <span className="text-neutral-400">Saving: </span> : null}
          {note.text}
        </div>
      )}
    </div>
  );
}
