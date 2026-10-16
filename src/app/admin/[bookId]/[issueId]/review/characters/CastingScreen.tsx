// The casting page (#787): one page for characters and voices. A contact
// sheet of face cards, a docked panel per character, the account's slot
// strip in the header, and Review, the one list of the staged moves. Every
// voice and cast change is staged in the browser and runs at Confirm; the
// Faces work still saves as it is done. Two modes (#854): before any bubble
// has a speaker it is faces only; once lines exist the cards group by what
// each needs for its voice.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  clearLocal,
  readLocal,
  writeLocal,
} from "~/components/review-editor/storage";
import { useTabTrap } from "~/hooks/useTabTrap";
import type {
  ArchiveMove,
  CreateDesignMove,
  Move,
  Roster,
  RosterSlot,
  RunResult,
} from "~/lib/casting-moves";
import { nameResolver, nameWords } from "~/lib/character-aliases";
import { slugify } from "~/lib/character-id";
import {
  approveCharacters,
  confirmFaces,
  continueRun,
  moveFace,
  moveFaces,
  nameGroup,
  rejectFace,
  rejectFaces,
  rejectGroup,
  relabelCharacter,
  voicePreview,
  makeVoiceSample,
  type ActionResult,
  type NameTarget,
} from "./actions";
import { loadRoster } from "./casting-actions";
import { CharacterPanel, type PanelTab } from "./CharacterPanel";
import { acceptedFor } from "./design-sheet/accepted";
import { DesignSheet, WandIcon } from "./design-sheet/DesignSheet";
import { PlayButton, PlayerProvider } from "./player";
import { ReviewSheet } from "./ReviewSheet";
import { FacesPanel, NameField, matchesName } from "./shared";
import { SlotStrip, type Carry } from "./SlotStrip";
import {
  archiveOf,
  asDraft,
  cardState,
  characterOf,
  draftKey,
  freeFor,
  isPick,
  isVoiced,
  oneEach,
  lockReason,
  pickMove,
  pickVoiceId,
  plays,
  rekey,
  restorable,
  slotAfter,
  slotModel,
  takesSlot,
  voicePick,
  withoutPick,
  type CardState,
  type Draft,
  type FormBase,
  type SlotModel,
  type SlotView,
  type Staged,
} from "./staging";
import type {
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  PageView,
  VoiceOption,
} from "./types";
import type { SilentWhy, VoiceUser, VoiceUsers } from "./VoiceTab";
import {
  BTN,
  BTN_GHOST,
  BTN_PRIMARY,
  COUNT,
  FOCUS,
  Icon,
  MENU_ITEM,
  Popover,
  Portrait,
} from "./ui";

type Toast = { text: string; bad?: boolean } | null;

const moves = (n: number) => `${n} staged ${n === 1 ? "move" : "moves"}`;

/** A draft's `savedAt` in local time. */
function savedWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "an earlier visit"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The DOM id of a card, so closing the panel can hand focus back to it. */
const cardDomId = (id: string) => `cast-card-${id}`;

type GroupKey = "here" | "needs" | "ready" | "silent" | "role";

/** The board's groups in order: faces mode, then voices mode (#854). */
const GROUPS: Record<"faces" | "voices", { key: GroupKey; label: string }[]> = {
  faces: [
    { key: "here", label: "In this issue" },
    { key: "role", label: "Roles" },
  ],
  voices: [
    { key: "needs", label: "Needs a voice" },
    { key: "ready", label: "Ready" },
    { key: "silent", label: "Silent here" },
    { key: "role", label: "Roles" },
  ],
};

/** What Approve does, for its tooltip (#757). */
const APPROVE_DOES =
  "Seeds the cast as shown and resumes the paused run: Gemini then reads every page (paid).";

/** A card for a character + Add brings in that has no card here. */
function blankCard(id: string, name: string, known: boolean): CharacterCard {
  return {
    id,
    name,
    group: "here",
    sources: [],
    wikiNames: [],
    known,
    removed: false,
    faces: [],
    looseExemplars: [],
    noAudio: false,
    voice: null,
    lines: 0,
    pages: null,
    samples: [],
  };
}

/** The card's voice chip: kind and slot, `as X`, `no voice`, `sitting out`. */
function Chip({
  card,
  state,
  voices,
  slotOf,
  landing,
  outIds,
  noSlot,
}: {
  card: CharacterCard;
  state: CardState;
  voices: Map<string, VoiceOption>;
  slotOf: Map<string, number>;
  landing: number | null;
  /** Voices a staged archive takes out. */
  outIds: Set<string>;
  /** Voiced, but under Needs a voice: say "no slot" (#854). */
  noSlot: boolean;
}) {
  const dot = (cls: string, title?: string) => (
    <span title={title} className={`size-[7px] shrink-0 rounded-full ${cls}`} />
  );
  const dim = "truncate text-neutral-400";
  const noSlotTag = <span className="text-[11px] text-red-400">no slot</span>;
  if (state.removed)
    return (
      <>
        {dot("bg-neutral-500")}
        <span className={dim}>not in issue</span>
      </>
    );
  if (state.sitOut)
    return (
      <>
        {dot("bg-neutral-500")}
        <span className={dim}>sitting out</span>
      </>
    );
  const v = state.voiceId ? voices.get(state.voiceId) : undefined;
  if (v) {
    const own = v.characterId === card.id;
    const pending = voicePick(state) !== null;
    const slot = slotAfter(state, slotOf, landing, outIds);
    const lost = !pending && outIds.has(v.id);
    if (lost)
      return (
        <>
          {dot("bg-red-400")}
          <span className="truncate text-neutral-100">lost its voice</span>
          {noSlot && noSlotTag}
        </>
      );
    return (
      <>
        {dot(
          pending
            ? "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.18)]"
            : v.status === "library"
              ? "bg-neutral-300"
              : !slot && slotOf.size > 0
                ? "bg-red-400"
                : own
                  ? "bg-emerald-400"
                  : "bg-sky-400",
          pending ? "changes at confirm" : undefined,
        )}
        <span
          className={`truncate ${v.status === "library" ? "text-neutral-400" : "text-neutral-100"}`}
        >
          {v.status === "library" ? v.name : own ? v.kind : `as ${v.name}`}
        </span>
        {slot ? (
          <span className="font-mono text-[11px] text-neutral-500">{slot}</span>
        ) : v.status === "archived" || noSlot ? (
          noSlotTag
        ) : null}
        <span className="ml-auto">
          <PlayButton voiceId={v.id} name={v.name} size="sm" />
        </span>
      </>
    );
  }
  const vp = voicePick(state);
  const design = vp?.move.kind === "create_design" ? vp.move : null;
  if (design) {
    const accepted = acceptedFor(design);
    const take = accepted?.takes.find(
      (t) => t.generated_voice_id === design.generated_voice_id,
    );
    const label = accepted ? `designed · take ${accepted.take}` : "designed";
    return (
      <>
        {dot(
          "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.18)]",
          "changes at confirm",
        )}
        <span className="truncate text-neutral-100">{label}</span>
        {landing ? (
          <span className="font-mono text-[11px] text-neutral-500">
            {landing}
          </span>
        ) : noSlot ? (
          noSlotTag
        ) : null}
        {take?.url ? (
          <span className="ml-auto">
            <PlayButton
              url={take.url}
              playKey={`take:${design.generated_voice_id}`}
              name={label}
              size="sm"
            />
          </span>
        ) : null}
      </>
    );
  }
  if (card.lines === 0)
    return (
      <>
        {dot("bg-neutral-500")}
        <span className={dim}>none needed</span>
      </>
    );
  return (
    <>
      {dot("bg-red-400")}
      <span className="truncate text-neutral-100">no voice</span>
    </>
  );
}

/** A faces-mode card's line: its face count, none on a role with no faces. */
function FaceCount({
  faces,
  role,
  removed,
}: {
  faces: number;
  role: boolean;
  removed: boolean;
}) {
  const count =
    faces > 0
      ? `${faces} ${faces === 1 ? "face" : "faces"}`
      : role
        ? ""
        : "no faces";
  const text = [count, removed ? "not in issue" : ""]
    .filter(Boolean)
    .join(" · ");
  return text ? (
    <span className="truncate text-neutral-400">{text}</span>
  ) : null;
}

function CastCard({
  card,
  state,
  formOf,
  isNew,
  selected,
  pages,
  voiceMode,
  chip,
  onOpen,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  card: CharacterCard;
  state: CardState;
  /** The character it is a form of (#891), from its known row. */
  formOf: KnownCharacter["formOf"];
  isNew: boolean;
  selected: boolean;
  pages: Map<number, PageView>;
  /** Voices mode: the line badge shows and the card drags to the slot strip. */
  voiceMode: boolean;
  chip: React.ReactNode;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const unvoiced =
    !isVoiced(state) && !state.sitOut && !state.removed && card.lines > 0;
  const quiet = state.sitOut || state.removed;
  return (
    <div
      ref={ref}
      id={cardDomId(card.id)}
      role="button"
      tabIndex={0}
      aria-label={state.name}
      aria-pressed={selected}
      draggable={voiceMode && !state.removed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `char:${card.id}`);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-neutral-900 text-left transition hover:-translate-y-px ${
        selected
          ? "border-amber-400 ring-1 ring-amber-400"
          : state.pending
            ? "border-t-2 border-neutral-700 border-t-amber-400"
            : unvoiced
              ? "border-red-900"
              : "border-neutral-700 hover:border-neutral-500"
      } ${state.removed ? "opacity-50" : ""} ${FOCUS}`}
    >
      <div className="relative aspect-[1/0.82] overflow-hidden bg-neutral-800">
        <Portrait
          card={card}
          pages={pages}
          className={`h-full w-full ${quiet ? "brightness-[.55] grayscale" : ""}`}
        />
        {voiceMode && (
          <span
            title={`${card.lines} lines`}
            className={`absolute top-1.5 right-1.5 rounded-[5px] px-1.5 font-mono text-[11px] font-semibold ${
              card.lines
                ? "bg-black/45 text-white"
                : "bg-black/30 text-neutral-400"
            }`}
          >
            {card.lines}
          </span>
        )}
        {isNew && (
          <span className="absolute top-1.5 left-1.5 rounded-[5px] bg-amber-400 px-1.5 text-[10px] font-semibold text-neutral-950 uppercase">
            new
          </span>
        )}
        <button
          type="button"
          aria-label={`${state.name}: more`}
          title="Actions"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e.currentTarget);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={`absolute z-[2] grid size-[22px] place-items-center rounded-md bg-black/60 text-white opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100 ${
            isNew ? "top-7 right-1.5" : "top-1.5 left-1.5"
          } ${FOCUS}`}
        >
          {Icon.more}
        </button>
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-neutral-950/95 via-neutral-950/75 to-transparent px-2 pt-5 pb-1.5 text-[13px] leading-tight font-semibold ${
            quiet ? "text-neutral-400" : "text-white"
          }`}
        >
          <div className="truncate">{state.name}</div>
          {formOf && (
            <div className="truncate text-[11px] font-normal text-neutral-300">
              form of {formOf.name}
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-8 items-center gap-1.5 overflow-hidden px-2 py-1.5 text-[11.5px] whitespace-nowrap">
        {chip}
      </div>
    </div>
  );
}

/** + Add: the book's earlier cast, wiki names and every known character by search, or a new name. */
function AddMenu({
  anchor,
  data,
  onBoard,
  voices,
  onAdd,
  onClose,
}: {
  anchor: HTMLElement;
  data: CharactersData;
  /** The cards on the board, id to name. */
  onBoard: Map<string, string>;
  voices: VoiceOption[];
  onAdd: (id: string | null, name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = slugify(query);
  const archived = (id: string) =>
    voices.some((v) => v.characterId === id && v.status === "archived");
  const rows: { id: string | null; name: string; note: string }[] = [
    ...data.earlierCast
      .filter((c) => !onBoard.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        note: archived(c.id) ? "archived voice" : "cast before",
      })),
    ...data.wikiNames
      .filter((n) => !onBoard.has(slugify(n)))
      .map((n) => ({ id: null, name: n, note: "wiki" })),
  ];
  const seen = new Set(rows.map((r) => r.id ?? slugify(r.name)));
  if (q)
    for (const k of data.known)
      if (!onBoard.has(k.id) && !seen.has(k.id) && matchesName(k, q))
        rows.push({
          id: k.id,
          name: k.name,
          note: archived(k.id) ? "archived voice" : "",
        });
  // A row or card as the shared name match reads it, aliases from the book's known row.
  const asKnown = (id: string, name: string) =>
    data.known.find((k) => k.id === id) ?? { id, name, aliases: [] };
  // Who a name means, by the server's rule (`nameResolver`): a known row's id,
  // or for a name no row has, its words in any order (prefixed, so a word key
  // never equals an id).
  const resolve = useMemo(
    () =>
      nameResolver(
        data.known.map((k) => ({
          ...k,
          display_name: k.name,
          // This book's aliases get their own tier, as on the server (`nameResolver` has the order).
          bookAliases: (k.aliasRows ?? [])
            .filter((a) => a.scope === "book")
            .map((a) => a.alias),
        })),
      ),
    [data.known],
  );
  const who = (name: string) => resolve(name)?.id ?? `words:${nameWords(name)}`;
  const board = [...onBoard].map(([id, name]) => ({
    who: resolve(id)?.id ?? `words:${nameWords(name)}`,
    name,
  }));
  const rowWho = (r: { id: string | null; name: string }) =>
    r.id ?? who(r.name);
  const shown = rows
    .filter((r) => !board.some((b) => b.who === rowWho(r)))
    .filter(
      (r) => !q || matchesName(asKnown(r.id ?? slugify(r.name), r.name), q),
    )
    .slice(0, 12);
  const meant = q ? who(query) : null;
  const exact = shown.find((r) => rowWho(r) === meant);
  // The typed name is a character already on the board: nothing to add.
  const onBoardAs = board.find((b) => b.who === meant);
  const add = (id: string | null, name: string) => {
    onAdd(id, name);
    onClose();
  };
  return (
    <Popover
      anchor={anchor}
      label="Add a character"
      width={280}
      onClose={onClose}
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !query.trim()) return;
          e.preventDefault();
          if (onBoardAs) return;
          if (exact) add(exact.id, exact.name);
          // A lone match is taken on Enter only as a substring; a word match is a click.
          else if (
            shown.length === 1 &&
            (slugify(shown[0]!.name).includes(q) || shown[0]!.id?.includes(q))
          )
            add(shown[0]!.id, shown[0]!.name);
          else add(null, query.trim());
        }}
        placeholder="Name"
        aria-label="Name"
        className={`mb-1.5 h-8 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 text-[13px] text-neutral-100 placeholder:text-neutral-500 ${FOCUS}`}
      />
      <div className="max-h-[260px] overflow-y-auto">
        {shown.map((r) => (
          <button
            key={r.id ?? `new:${r.name}`}
            type="button"
            onClick={() => add(r.id, r.name)}
            className={MENU_ITEM}
          >
            <span className="truncate">{r.name}</span>
            {r.note && (
              <span className="ml-auto text-[11px] text-neutral-500">
                {r.note}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mx-0.5 my-1 h-px bg-neutral-800" />
      {onBoardAs ? (
        <button type="button" disabled className={MENU_ITEM}>
          Already on the board: {onBoardAs.name}
        </button>
      ) : (
        <button
          type="button"
          disabled={!query.trim() || exact !== undefined}
          onClick={() => add(null, query.trim())}
          className={MENU_ITEM}
        >
          {Icon.pencil} New: {query.trim() || "…"}
        </button>
      )}
    </Popover>
  );
}

/** Faces: the face groups no character has yet. Naming and dropping save at once. */
function FacesDialog({
  data,
  pages,
  busy,
  run,
  onClose,
}: {
  data: CharactersData;
  pages: Map<number, PageView>;
  busy: boolean;
  run: (label: string, work: () => Promise<ActionResult>) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  useTabTrap(box);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const scope = { bookId: data.bookId, issueId: data.issueId };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Faces"
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-8"
    >
      <div
        ref={box}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[760px] max-w-full flex-col rounded-2xl border border-neutral-700 bg-neutral-900 text-[13px] text-neutral-200"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-neutral-100">Faces</h3>
          <span className="font-mono text-neutral-400">
            {data.unknown.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${BTN_GHOST} ml-auto size-7 justify-center px-0`}
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-3.5">
          {data.unknown.length === 0 && (
            <p className="py-8 text-center text-neutral-500">
              Every face has a name
            </p>
          )}
          {data.unknown.map((g) => {
            const pagesOf = [...new Set(g.faces.map((f) => f.page))].sort(
              (a, b) => a - b,
            );
            const label = g.suggestedNames.join(", ") || "Unknown";
            return (
              <section
                key={g.key}
                aria-label={label}
                className="rounded-lg border border-neutral-800 p-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <Portrait
                    card={{
                      faces: g.faces,
                      looseExemplars: g.looseExemplars,
                      name: label,
                    }}
                    pages={pages}
                    className="size-11 shrink-0 rounded-md"
                  />
                  <span className="min-w-[56px] font-mono text-[12px] text-neutral-400">
                    p.{pagesOf.join(", ")}
                  </span>
                  <span className="text-[12px] text-neutral-500">
                    {g.faces.length}
                  </span>
                  <NameField
                    known={data.known}
                    placeholder="Who?"
                    initial={g.suggestedNames[0] ?? ""}
                    submitLabel="Name"
                    busy={busy}
                    onPick={(target, name) =>
                      run(`Naming ${name}`, () =>
                        nameGroup({
                          scope,
                          detectionIds: g.faces.map((f) => f.id),
                          suggestedNames: g.suggestedNames,
                          target,
                          franchiseId: data.franchiseId,
                        }),
                      )
                    }
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run("Dropping the group", () =>
                        rejectGroup({
                          scope,
                          detectionIds: g.faces.map((f) => f.id),
                          suggestedNames: g.suggestedNames,
                        }),
                      )
                    }
                    className={`${BTN_GHOST} text-red-400`}
                  >
                    Not a character
                  </button>
                  <button
                    type="button"
                    aria-expanded={open === g.key}
                    onClick={() => setOpen((k) => (k === g.key ? null : g.key))}
                    className={BTN_GHOST}
                  >
                    {open === g.key ? "Less" : "Every face"}
                  </button>
                </div>
                {open === g.key && (
                  <FacesPanel
                    faces={g.faces}
                    loose={g.looseExemplars}
                    pages={pages}
                    label={label}
                    known={data.known}
                    busy={busy}
                    onMove={(face, target, name) =>
                      run(`Naming the page ${face.page} face ${name}`, () =>
                        moveFace({
                          scope,
                          detectionId: face.id,
                          target,
                          franchiseId: data.franchiseId,
                        }),
                      )
                    }
                    onReject={(face) =>
                      run(`Dropping the page ${face.page} face`, () =>
                        rejectFace({ scope, detectionId: face.id }),
                      )
                    }
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CastingScreen({ data }: { data: CharactersData }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [staged, setStagedRaw] = useState<Staged[]>([]);
  /** Every change to the staged list, with no move doubled (`oneEach`). */
  const setStaged = useCallback(
    (u: Staged[] | ((s: Staged[]) => Staged[])) =>
      setStagedRaw((s) => oneEach(typeof u === "function" ? u(s) : u)),
    [],
  );
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The open card now, for a save's answer that lands after a re-render (#846). */
  const openIdRef = useRef(openId);
  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("voice");
  const [menu, setMenu] = useState<
    | { kind: "card"; id: string; anchor: HTMLElement }
    | { kind: "add"; anchor: HTMLElement }
    | null
  >(null);
  const [facesOpen, setFacesOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The character the design sheet is open for. */
  const [designFor, setDesignFor] = useState<string | null>(null);
  const [carry, setCarry] = useState<Carry | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [resumed, setResumed] = useState(false);
  /** Silent here is folded until opened. */
  const [silentOpen, setSilentOpen] = useState(false);
  const silentGridId = useId();
  /** The open card Silent here last unfolded for. */
  const [silentPull, setSilentPull] = useState<string | null>(null);
  /** Speakers exist (#854); before that the page is faces only. */
  const voiceMode = data.hasSpeakers;
  const scope = useMemo(
    () => ({ bookId: data.bookId, issueId: data.issueId }),
    [data.bookId, data.issueId],
  );
  const pages = useMemo(
    () => new Map(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );
  const voiceById = useMemo(
    () => new Map(data.voices.map((v) => [v.id, v])),
    [data.voices],
  );

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.bad ? 4200 : 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const readRoster = useCallback(() => {
    loadRoster()
      .then((r) => {
        if (r.ok) {
          setRoster(r.data);
          setRosterError(null);
        } else setRosterError(r.error);
      })
      .catch((err: unknown) =>
        setRosterError(err instanceof Error ? err.message : String(err)),
      );
  }, []);
  // Faces mode shows no slots, so it reads none.
  useEffect(() => {
    if (voiceMode) readRoster();
  }, [voiceMode, readRoster]);

  // The staged list as a browser draft (#904). Restored in an effect, not
  // during render (the page is server rendered), then written on every
  // change; writes wait for the restore, so the first render's empty list
  // never overwrites a stored draft.
  const draft = draftKey(data.bookId, data.issueId);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  /** The list the restore set: not written back, so the draft keeps its time. */
  const restoredList = useRef<Staged[] | null>(null);
  /** What the restore brought back and dropped; stays until dismissed. */
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  useEffect(() => {
    if (restoredFor === draft) return;
    const saved = asDraft(readLocal(draft));
    const { keep, dropped, reasons } = restorable(saved?.staged ?? [], {
      voiceIds: new Set(data.voices.map((v) => v.id)),
      characterIds: new Set(
        [...data.cards, ...data.earlierCast, ...data.known].map((c) => c.id),
      ),
    });
    const next = oneEach(keep);
    restoredList.current = next;
    setStagedRaw(next);
    if (saved && dropped > 0) {
      if (next.length) writeLocal(draft, { ...saved, staged: next });
      else clearLocal(draft);
    }
    setRestoreNote(
      saved && saved.staged.length > 0
        ? `Restored ${moves(next.length)} from ${savedWhen(saved.savedAt)}${
            dropped > 0 ? ` · dropped ${dropped}: ${reasons.join("; ")}` : ""
          }`
        : null,
    );
    setRestoredFor(draft);
  }, [
    draft,
    restoredFor,
    data.voices,
    data.cards,
    data.earlierCast,
    data.known,
  ]);
  useEffect(() => {
    if (restoredFor !== draft || staged === restoredList.current) return;
    if (staged.length === 0) clearLocal(draft);
    else
      writeLocal(draft, {
        v: 1,
        savedAt: new Date().toISOString(),
        staged,
      } satisfies Draft);
  }, [draft, restoredFor, staged]);

  /** Re-reads voices and characters (`router.refresh` keeps the staged list); says so once the refresh lands. */
  const [reloading, setReloading] = useState(false);
  const reloadVoices = () => {
    setReloading(true);
    startTransition(() => router.refresh());
    if (voiceMode) readRoster();
  };
  useEffect(() => {
    if (!reloading || busy) return;
    setReloading(false);
    say("Reloaded");
  }, [reloading, busy, say]);
  const discardStaged = () => {
    if (
      !window.confirm(
        `Discard all ${moves(staged.length)}? Nothing has been confirmed.`,
      )
    )
      return;
    setStaged([]);
    setRestoreNote(null);
  };

  /** An immediate write (the Faces work, Approve, Continue): run, say the answer, then `onOk` on success, refresh. */
  const run = useCallback(
    <R extends ActionResult>(
      label: string,
      work: () => Promise<R>,
      onOk?: (r: Extract<R, { ok: true }>) => void,
    ) => {
      say(`${label}…`);
      startTransition(async () => {
        try {
          const r = await work();
          say(r.ok ? r.message : r.error, !r.ok);
          if (r.ok) onOk?.(r as Extract<R, { ok: true }>);
        } catch (err) {
          say(err instanceof Error ? err.message : String(err), true);
        }
        router.refresh();
      });
    },
    [router, say],
  );

  // The cards: the loaded ones, then the ones a staged + Add brings in.
  const addedCards = useMemo(() => {
    const out: CharacterCard[] = [];
    const have = new Set(data.cards.map((c) => c.id));
    for (const { move } of staged) {
      if (move.kind !== "add_character") continue;
      const id = characterOf(move)!;
      if (have.has(id)) continue;
      have.add(id);
      const earlier = data.earlierCast.find((c) => c.id === id);
      const known = data.known.find((k) => k.id === id);
      out.push(
        earlier ?? blankCard(id, known?.name ?? move.name, known !== undefined),
      );
    }
    return out;
  }, [staged, data.cards, data.earlierCast, data.known]);
  const cards = useMemo(
    () => [...data.cards, ...addedCards],
    [data.cards, addedCards],
  );
  const addedIds = useMemo(
    () => new Set(addedCards.map((c) => c.id)),
    [addedCards],
  );
  const onBoard = useMemo(
    () => new Map(cards.map((c) => [c.id, c.name])),
    [cards],
  );

  const model: SlotModel | null = useMemo(
    () => (roster ? slotModel(roster, staged) : null),
    [roster, staged],
  );
  const slotOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of roster?.slots ?? [])
      if (s.holder.kind !== "free" && s.holder.voiceUuid)
        m.set(s.holder.voiceUuid, s.index);
    return m;
  }, [roster]);
  const outIds = useMemo(() => {
    const s = new Set<string>();
    for (const v of model?.slots ?? [])
      if (
        v.outBy !== null &&
        v.slot.holder.kind !== "free" &&
        v.slot.holder.voiceUuid
      )
        s.add(v.slot.holder.voiceUuid);
    return s;
  }, [model]);
  /** Whether a card's voice plays after the staged moves: Ready or Needs a voice. */
  const playsNow = useMemo(() => {
    const slots = model ? { slotOf, outIds, landing: model.landing } : null;
    return (st: CardState) =>
      plays(st, slots, (id) => voiceById.get(id)?.status);
  }, [model, slotOf, outIds, voiceById]);
  /** A form's base (#891) for `cardState`, with its card when it is on the board. */
  const formBaseOf = useMemo(() => {
    // A base out of this issue may have no card on the board, only an
    // earlier issue's: it still says why the form has no voice.
    const byId = new Map(
      [...data.earlierCast, ...cards].map((c) => [c.id, c] as const),
    );
    const formOf = new Map(data.known.map((k) => [k.id, k.formOf ?? null]));
    return (c: CharacterCard): FormBase | null => {
      const f = formOf.get(c.id);
      return f ? { ...f, card: byId.get(f.id), plays: playsNow } : null;
    };
  }, [cards, data.earlierCast, data.known, playsNow]);
  const states = useMemo(
    () =>
      new Map(cards.map((c) => [c.id, cardState(c, staged, formBaseOf(c))])),
    [cards, staged, formBaseOf],
  );
  const stateOf = (c: CharacterCard) =>
    states.get(c.id) ?? cardState(c, staged, formBaseOf(c));
  const nameOf = useCallback(
    (id: string) =>
      states.get(id)?.name ?? cards.find((c) => c.id === id)?.name ?? id,
    [states, cards],
  );
  /**
   * Voice id to the board's characters whose voice it is, once the staged
   * moves run (#882). One speaks in it when it has lines here and is neither
   * sitting out nor out of the issue: Silent here's rule, staged moves and
   * picks included, so the Swap out list, Leaves X silent and the slot strip
   * never disagree with the board. A silent one carries why.
   */
  const speakers = useMemo(() => {
    const m: VoiceUsers = new Map();
    const add = (voiceId: string, u: VoiceUser) =>
      m.set(voiceId, [...(m.get(voiceId) ?? []), u]);
    for (const c of cards) {
      const st = states.get(c.id) ?? cardState(c, staged, formBaseOf(c));
      const why: SilentWhy | null = st.removed
        ? "not in this issue"
        : st.sitOut
          ? "sitting out"
          : null;
      const u = { id: c.id, name: st.name, why };
      if (why === null) {
        if (c.lines > 0 && st.voiceId) add(st.voiceId, u);
        continue;
      }
      // A saved sit-out loads with no voice (#410): name its own active ones.
      const ids = st.voiceId
        ? [st.voiceId]
        : data.voices
            .filter((v) => v.characterId === c.id && v.status === "active")
            .map((v) => v.id);
      for (const id of ids) add(id, u);
    }
    return m;
  }, [cards, states, staged, formBaseOf, data.voices]);

  // ---- staging: every control below only edits `staged` ----

  const forChar = (id: string) => (s: Staged) => characterOf(s.move) === id;

  /** A voice pick, or an accepted design. A slot comes free when one is, else from swapping out its own voice. */
  const pick = (
    card: CharacterCard,
    choice: VoiceOption | CreateDesignMove,
    opts: { slot?: SlotView; keep?: boolean } = {},
  ) => {
    const { slot } = opts;
    const st = stateOf(card);
    // Only a voice the card owns: one it borrows from its base is a new pick.
    const base = card.voice?.borrowedFromId ? null : (card.voice?.uuid ?? null);
    const design = "generated_voice_id" in choice ? choice : null;
    const voice = design ? null : (choice as VoiceOption);
    if (
      voice &&
      st.pick &&
      pickVoiceId(st.pick.move) === voice.id &&
      !opts.keep
    ) {
      setStaged((s) => withoutPick(s, card.id));
      say("Back to how it is");
      return;
    }
    let next = withoutPick(staged, card.id).filter(
      (s) => !(forChar(card.id)(s) && s.move.kind === "sit_out"),
    );
    const isBase =
      voice !== null && voice.id === base && voice.status === "active";
    const label = voice ? voice.name : "a new design";
    let how = "";
    if (!isBase) {
      const m = design ?? pickMove(card, voice!);
      if (takesSlot(m)) {
        // Read the slots from the list without the old pick, whose archive
        // it just dropped, so that slot can be swapped out again.
        const after = roster ? slotModel(roster, next) : null;
        const free = after ? freeFor(after, null) : 1;
        // The swap the old pick had, so switching between archived voices
        // keeps the voice already chosen to swap out.
        const prior = staged.find(
          (s) => s.pickFor === card.id && s.move.kind === "archive",
        )?.move;
        const target =
          slot ??
          (free > 0
            ? undefined
            : (after?.slots.find(
                (v) =>
                  v.slot.holder.kind === "repo" &&
                  v.slot.holder.characterId === card.id &&
                  v.slot.lock === "movable" &&
                  v.outBy === null,
              ) ??
              after?.slots.find(
                (v) =>
                  prior?.kind === "archive" &&
                  v.slot.holder.kind !== "free" &&
                  v.outBy === null &&
                  (prior.voice_uuid
                    ? v.slot.holder.voiceUuid === prior.voice_uuid
                    : v.slot.holder.elevenLabsId === prior.elevenlabs_id),
              )));
        const fresh =
          target && target.slot.holder.kind !== "free"
            ? archiveOf(target.slot)
            : null;
        // Same voice as the old swap: keep its Back up first and lossy ticks.
        const out =
          fresh &&
          prior?.kind === "archive" &&
          prior.voice_uuid === fresh.voice_uuid &&
          (prior.elevenlabs_id ?? null) === (fresh.elevenlabs_id ?? null)
            ? prior
            : fresh;
        if (out) next = [...next, { move: out, pickFor: card.id }];
        how = out
          ? ` · swaps out ${target!.slot.holder.kind !== "free" ? target!.slot.holder.name : ""}`
          : free > 0
            ? " · takes a free slot"
            : " · pick a voice to swap out";
      }
      // A card dropped on a free segment lands there on the strip.
      next = [
        ...next,
        slot?.slot.holder.kind === "free"
          ? { move: m, slotHint: slot.slot.index }
          : { move: m },
      ];
    }
    // One back_in: the one Back in staged, else one tied to this pick.
    if (
      card.noAudio &&
      !next.some((s) => forChar(card.id)(s) && s.move.kind === "back_in")
    )
      next = [
        ...next,
        { move: { kind: "back_in", character_id: card.id }, pickFor: card.id },
      ];
    setStaged(next);
    say(isBase ? `${st.name} → ${label}` : `${st.name} → ${label}${how}`);
  };

  const setSlotFree = (cid: string) =>
    setStaged((s) =>
      s.filter((x) => !(x.pickFor === cid && x.move.kind === "archive")),
    );
  const setSlotSwap = (cid: string, slot: RosterSlot) => {
    const out = archiveOf(slot);
    if (!out || slot.lock !== "movable") return;
    setStaged((s) => {
      const i = s.findIndex(
        (x) => x.pickFor === cid && x.move.kind === "archive",
      );
      if (i >= 0)
        return s.map((x, j) => (j === i ? { move: out, pickFor: cid } : x));
      // The archive goes before the pick, as Review lists a swap.
      const p = s.findIndex(
        (x) => isPick(x.move) && characterOf(x.move) === cid,
      );
      const at = p >= 0 ? p : s.length;
      return [...s.slice(0, at), { move: out, pickFor: cid }, ...s.slice(at)];
    });
  };
  const setArchiveFlags = (
    index: number,
    patch: Partial<Pick<ArchiveMove, "backup" | "lossy_ok">>,
  ) =>
    setStaged((s) =>
      s.map((x, i) =>
        i === index && x.move.kind === "archive"
          ? { ...x, move: { ...x.move, ...patch } }
          : x,
      ),
    );
  const sitOut = (card: CharacterCard) => {
    setStaged((s) => {
      const next = withoutPick(s, card.id).filter(
        (x) =>
          !(
            forChar(card.id)(x) &&
            (x.move.kind === "sit_out" || x.move.kind === "back_in")
          ),
      );
      return card.noAudio
        ? next
        : [...next, { move: { kind: "sit_out", character_id: card.id } }];
    });
    say(`${nameOf(card.id)} sits out this run`);
  };
  const backIn = (card: CharacterCard) => {
    setStaged((s) => {
      const next = s.filter(
        (x) =>
          !(
            forChar(card.id)(x) &&
            (x.move.kind === "sit_out" || x.move.kind === "back_in")
          ),
      );
      return card.noAudio
        ? [...next, { move: { kind: "back_in", character_id: card.id } }]
        : next;
    });
  };
  const remove = (card: CharacterCard) => {
    if (addedIds.has(card.id)) {
      setStaged((s) =>
        withoutPick(s, card.id).filter((x) => !forChar(card.id)(x)),
      );
      if (openId === card.id) setOpenId(null);
      return;
    }
    setStaged((s) => [
      // The pick's swap archive and back_in go with it (`withoutPick`).
      ...withoutPick(s, card.id).filter(
        (x) => !forChar(card.id)(x) || x.move.kind === "rename",
      ),
      ...(card.removed
        ? []
        : [
            {
              move: { kind: "remove_character", character_id: card.id } as Move,
            },
          ]),
    ]);
    say(`${nameOf(card.id)}: not in this issue`);
  };
  const putBack = (card: CharacterCard) =>
    setStaged((s) => {
      const next = s.filter(
        (x) => !(forChar(card.id)(x) && x.move.kind === "remove_character"),
      );
      return card.removed
        ? [
            ...next,
            {
              move: {
                kind: "add_character",
                character_id: card.id,
                name: card.name,
              },
            },
          ]
        : next;
    });
  const rename = (card: CharacterCard, name: string) =>
    setStaged((s) => {
      const next = s.filter(
        (x) => !(forChar(card.id)(x) && x.move.kind === "rename"),
      );
      return name && name !== card.name
        ? [...next, { move: { kind: "rename", character_id: card.id, name } }]
        : next;
    });
  const add = (id: string | null, name: string) => {
    const cid = id ?? slugify(name);
    if (!cid) return;
    setStaged((s) => [
      ...s,
      { move: { kind: "add_character", character_id: id, name } },
    ]);
    setTab("voice");
    setOpenId(cid);
    say(`Add ${name}`);
  };
  // A by-name + Add card's id is its name's slug, but a move to it resolves
  // the name and may land on a row with another id (#866): the card's staged
  // moves, its panel and its rename follow the faces there.
  const follow = (target: NameTarget, id: string) => {
    if (target.kind !== "new") return;
    const from = slugify(target.name);
    if (from === id) return;
    setStaged((s) => rekey(s, from, id));
    setOpenId((cur) => (cur === from ? id : cur));
    setRenameId((cur) => (cur === from ? id : cur));
  };
  const freeSlot = (v: SlotView) => {
    const out = archiveOf(v.slot);
    if (!out || v.slot.lock !== "movable") return;
    setStaged((s) => [...s, { move: out }]);
    say(
      `${v.slot.holder.kind !== "free" ? v.slot.holder.name : "Slot"} is freed at confirm${v.slot.backup === "lossy" ? " · no backup" : ", backed up first"}`,
      v.slot.backup === "lossy",
    );
  };
  const undo = (index: number) =>
    setStaged((s) => {
      const m = s[index];
      if (!m) return s;
      if (isPick(m.move)) return withoutPick(s, characterOf(m.move)!);
      return s.filter((_, i) => i !== index);
    });
  /** A card dropped on a slot: its waiting voice takes that slot, swapping out the holder. */
  const dropCard = (cid: string, v: SlotView) => {
    const card = cards.find((c) => c.id === cid);
    if (!card) return;
    const st = stateOf(card);
    const why = lockReason(v.slot);
    if (why) return say(why, true);
    if (v.state === "in" || v.state === "out")
      return say(`Slot ${v.slot.index} already changes at confirm`, true);
    const waiting =
      (st.pick?.move.kind === "restore"
        ? voiceById.get(st.pick.move.voice_uuid)
        : undefined) ??
      data.voices
        .filter((x) => x.characterId === cid && x.status === "archived")
        .sort((a, b) => Number(b.labPick) - Number(a.labPick))[0];
    if (!waiting) return say(`${st.name} has nothing waiting for a slot`, true);
    pick(card, waiting, {
      slot: v,
      keep: true,
    });
    setTab("voice");
    setOpenId(cid);
  };

  // ---- the panel ----

  const openCard = cards.find((c) => c.id === openId) ?? null;
  const closePanel = useCallback(() => {
    const id = openId;
    setOpenId(null);
    setRenameId(null);
    if (id) document.getElementById(cardDomId(id))?.focus();
  }, [openId]);
  const open = (id: string) => {
    setRenameId(null);
    setOpenId(id);
  };

  const onRan = (result: RunResult) => {
    if (result.status === "refused") return;
    const done = new Set(
      result.moves.filter((m) => m.status === "done").map((m) => m.moveIndex),
    );
    setStaged((s) => s.filter((_, i) => !done.has(i)));
    say(
      result.status === "done"
        ? voiceMode
          ? "Confirmed · the account matches the strip"
          : "Confirmed"
        : "Stopped · what did not run is still staged",
      result.status !== "done",
    );
    if (voiceMode) readRoster();
    router.refresh();
  };

  // A form speaking with its base's staged pick lands where that pick does.
  const landingOf = (st: CardState) => {
    const p = voicePick(st);
    return p && model ? (model.landing.get(p.index) ?? null) : null;
  };
  /** The card's group by its staged state (#854). */
  const groupOf = (c: CharacterCard): GroupKey => {
    if (c.group === "role") return "role";
    if (!voiceMode) return "here";
    const st = stateOf(c);
    if (c.lines === 0 || st.sitOut || st.removed) return "silent";
    // Slots still loading go by the voice's status (`plays`), so a card does
    // not jump to Needs a voice and back when the roster lands.
    return playsNow(st) ? "ready" : "needs";
  };
  const grouped = new Map<GroupKey, CharacterCard[]>();
  for (const c of cards) {
    const k = groupOf(c);
    grouped.set(k, [...(grouped.get(k) ?? []), c]);
  }
  // Roles keep load.ts's `ROLE_IDS` order.
  for (const [k, list] of grouped)
    if (k !== "role")
      list.sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  const groupById = new Map(
    [...grouped].flatMap(([k, list]) => list.map((c) => [c.id, k] as const)),
  );
  // The open card (a card just added opens) landing in Silent here unfolds
  // it, and it stays unfolded, so closing the panel can focus the card. Only
  // on arrival: the toggle can still fold it after.
  const pull =
    openId !== null && groupById.get(openId) === "silent" ? openId : null;
  if (pull !== silentPull) {
    setSilentPull(pull);
    if (pull !== null) setSilentOpen(true);
  }

  const pause = data.pause;
  const pauseLabel =
    pause?.step === "casting" ? "Continue" : "Approve the cast";
  const pauseWhy =
    staged.length > 0
      ? "Confirm or undo the staged moves first"
      : (pause?.blocker ??
        (pause?.step === "casting"
          ? "Resumes the paused run: the audio step renders the lines (paid)."
          : APPROVE_DOES));

  const menuCard =
    menu?.kind === "card" ? cards.find((c) => c.id === menu.id) : undefined;
  const designCard = designFor
    ? cards.find((c) => c.id === designFor)
    : undefined;

  return (
    <PlayerProvider
      preview={(voiceId) => voicePreview({ scope, voiceId })}
      makeSample={(voiceId) => makeVoiceSample({ scope, voiceId })}
      onError={(m) => say(m, true)}
    >
      <div className="flex h-screen flex-col bg-neutral-950 text-[13px] text-neutral-200">
        <header className="flex h-[54px] shrink-0 items-center gap-4 border-b border-neutral-800 bg-neutral-900 px-[18px]">
          <nav className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-neutral-400">
            <Link href="/admin" className={`hover:text-neutral-100 ${FOCUS}`}>
              Admin
            </Link>
            <span className="text-neutral-600">/</span>
            <Link
              href={`/admin/${data.bookId}/${data.issueId}/review/pipeline`}
              className={`truncate hover:text-neutral-100 ${FOCUS}`}
            >
              {data.bookName}, {data.issueName}
            </Link>
            <span className="text-neutral-600">/</span>
            <b className="font-semibold text-neutral-100">Casting</b>
          </nav>
          {data.unknown.length > 0 && (
            <button
              type="button"
              onClick={() => setFacesOpen(true)}
              className={BTN_GHOST}
            >
              Faces <span className={COUNT}>{data.unknown.length}</span>
            </button>
          )}
          {voiceMode ? (
            <SlotStrip
              roster={roster}
              error={rosterError}
              model={model}
              staged={staged}
              voices={voiceById}
              speakers={speakers}
              nameOf={nameOf}
              onBoard={(id) => onBoard.has(id)}
              carry={carry}
              onCarry={setCarry}
              onFree={freeSlot}
              onKeep={(i) => setStaged((s) => s.filter((_, j) => j !== i))}
              onOpen={open}
              onDropCard={dropCard}
            />
          ) : (
            <span className="flex-1" />
          )}
          <button
            type="button"
            onClick={(e) => setMenu({ kind: "add", anchor: e.currentTarget })}
            className={BTN}
          >
            + Add
          </button>
          <button
            type="button"
            disabled={busy}
            title="Re-read voices and characters from the database; staged moves stay"
            onClick={reloadVoices}
            className={BTN_GHOST}
          >
            Reload voices
          </button>
          {staged.length > 0 && (
            <button type="button" onClick={discardStaged} className={BTN_GHOST}>
              Discard staged
            </button>
          )}
          {/* Faces mode stages only adds, renames and removals: Review shows once one is staged. */}
          {(voiceMode || staged.length > 0) && (
            <button
              type="button"
              disabled={staged.length === 0}
              onClick={() => setReviewOpen(true)}
              className={BTN_PRIMARY}
            >
              Review <span className={COUNT}>{staged.length}</span>
            </button>
          )}
          {resumed ? (
            <span className="rounded-md bg-emerald-700/30 px-3 py-1.5 font-medium whitespace-nowrap text-emerald-200">
              Resumed
            </span>
          ) : (
            pause && (
              <button
                type="button"
                disabled={busy || pause.blocker !== null || staged.length > 0}
                title={pauseWhy}
                onClick={() =>
                  run(pauseLabel, async () => {
                    const r =
                      pause.step === "casting"
                        ? await continueRun(scope)
                        : await approveCharacters(scope);
                    if (r.ok) setResumed(true);
                    return r;
                  })
                }
                className={BTN}
              >
                {pauseLabel}
              </button>
            )
          )}
        </header>
        {restoreNote && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 px-[18px] py-1 text-[12px] text-neutral-400"
          >
            <span className="min-w-0 flex-1 truncate" title={restoreNote}>
              {restoreNote}
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setRestoreNote(null)}
              className={`${BTN_GHOST} size-6 justify-center px-0`}
            >
              ×
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <main
            aria-label="Cast"
            className="min-w-0 flex-1 overflow-y-auto px-[18px] pt-1.5 pb-10"
          >
            {!voiceMode && (
              <p className="truncate px-0.5 pt-3 text-[12px] text-neutral-500">
                Faces · voices come after the pages stop
              </p>
            )}
            {GROUPS[voiceMode ? "voices" : "faces"].map((g) => {
              const list = grouped.get(g.key) ?? [];
              if (list.length === 0) return null;
              const folds = g.key === "silent";
              const heading = (
                <>
                  <b className="font-semibold text-neutral-400">{g.label}</b>
                  <span className="font-mono tracking-normal text-neutral-400">
                    {list.length}
                  </span>
                </>
              );
              return (
                <section key={g.key} aria-label={g.label}>
                  <h2 className="flex items-baseline gap-2.5 px-0.5 pt-[18px] pb-2 text-[11px] tracking-[0.08em] text-neutral-500 uppercase">
                    {folds ? (
                      <button
                        type="button"
                        aria-expanded={silentOpen}
                        aria-controls={silentGridId}
                        onClick={() => setSilentOpen((o) => !o)}
                        className={`flex items-baseline gap-2.5 uppercase hover:text-neutral-300 ${FOCUS}`}
                      >
                        <span
                          className={`self-center transition-transform ${silentOpen ? "rotate-90" : ""}`}
                        >
                          {Icon.chev}
                        </span>
                        {heading}
                      </button>
                    ) : (
                      heading
                    )}
                  </h2>
                  <div
                    id={folds ? silentGridId : undefined}
                    className={`${folds && !silentOpen ? "hidden" : "grid"} grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5`}
                  >
                    {list.map((c) => {
                      const st = stateOf(c);
                      return (
                        <CastCard
                          key={c.id}
                          card={c}
                          state={st}
                          formOf={
                            data.known.find((k) => k.id === c.id)?.formOf ??
                            null
                          }
                          isNew={addedIds.has(c.id)}
                          selected={openId === c.id}
                          pages={pages}
                          voiceMode={voiceMode}
                          chip={
                            voiceMode ? (
                              <Chip
                                card={c}
                                state={st}
                                voices={voiceById}
                                slotOf={slotOf}
                                landing={landingOf(st)}
                                outIds={outIds}
                                noSlot={
                                  isVoiced(st) &&
                                  groupById.get(c.id) === "needs"
                                }
                              />
                            ) : (
                              <FaceCount
                                faces={c.faces.length}
                                role={c.group === "role"}
                                removed={st.removed}
                              />
                            )
                          }
                          onOpen={() =>
                            openId === c.id ? undefined : open(c.id)
                          }
                          onMenu={(anchor) =>
                            setMenu({ kind: "card", id: c.id, anchor })
                          }
                          onDragStart={() =>
                            setCarry({ type: "char", id: c.id })
                          }
                          onDragEnd={() => setCarry(null)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5 pt-[18px]">
              <button
                type="button"
                onClick={(e) =>
                  setMenu({ kind: "add", anchor: e.currentTarget })
                }
                className={`flex min-h-[150px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-neutral-700 font-medium text-neutral-500 hover:border-neutral-500 hover:text-neutral-100 ${FOCUS}`}
              >
                <span className="grid size-[34px] place-items-center rounded-full border border-dashed border-neutral-600 text-[20px] leading-none">
                  +
                </span>
                Add
              </button>
            </div>
          </main>

          {openCard && (
            <CharacterPanel
              key={openCard.id}
              card={openCard}
              state={stateOf(openCard)}
              pages={pages}
              cards={cards}
              known={data.known}
              bookId={data.bookId}
              issueId={data.issueId}
              revoice={
                data.revoice.find((r) => r.characterId === openCard.id) ?? null
              }
              busy={busy}
              voiceMode={voiceMode}
              tab={tab}
              onTabChange={setTab}
              renameOnOpen={renameId === openCard.id}
              onClose={closePanel}
              onRename={(name) => rename(openCard, name)}
              onSitOut={() => sitOut(openCard)}
              onBackIn={() => backIn(openCard)}
              onRemove={() => remove(openCard)}
              onPutBack={() => putBack(openCard)}
              onConfirmFaces={() =>
                run("Confirming the faces", () =>
                  confirmFaces({ scope, characterId: openCard.id }),
                )
              }
              onMove={(face: FaceView, target: NameTarget, name: string) =>
                run(
                  `Moving the page ${face.page} face to ${name}`,
                  () =>
                    moveFace({
                      scope,
                      detectionId: face.id,
                      target,
                      franchiseId: data.franchiseId,
                    }),
                  (r) => follow(target, r.characterId),
                )
              }
              onMoveMany={(faces, target, name) =>
                run(
                  `Moving ${faces.length} faces to ${name}`,
                  () =>
                    moveFaces({
                      scope,
                      detectionIds: faces.map((f) => f.id),
                      target,
                      franchiseId: data.franchiseId,
                    }),
                  (r) => follow(target, r.characterId),
                )
              }
              onRelabel={(target, name) => {
                const from = openCard.id;
                run(
                  `Moving all of ${openCard.name}'s faces to ${name}`,
                  () =>
                    relabelCharacter({
                      scope,
                      fromId: from,
                      target,
                      franchiseId: data.franchiseId,
                    }),
                  (r) => {
                    // What is staged for the old card was about it, not the
                    // target: a rename or a voice pick must not carry over.
                    setStaged((s) =>
                      withoutPick(s, from).filter((x) => !forChar(from)(x)),
                    );
                    setRenameId((cur) => (cur === from ? null : cur));
                    // Doug may have closed the panel or opened another card
                    // while the save ran: follow only if it still shows `from`.
                    if (openIdRef.current === from) setTab("voice");
                    setOpenId((cur) => (cur === from ? r.characterId : cur));
                    follow(target, r.characterId);
                  },
                );
              }}
              onReject={(face) =>
                run(`Dropping the page ${face.page} face`, () =>
                  rejectFace({ scope, detectionId: face.id }),
                )
              }
              onRejectMany={(faces) =>
                run(
                  `Dropping ${faces.length} ${faces.length === 1 ? "face" : "faces"}`,
                  () =>
                    rejectFaces({
                      scope,
                      detectionIds: faces.map((f) => f.id),
                    }),
                )
              }
              staged={staged}
              voices={data.voices}
              roster={roster}
              model={model}
              speakers={speakers}
              onPick={(v) => pick(openCard, v)}
              onDesign={() => setDesignFor(openCard.id)}
              onSlotFree={() => setSlotFree(openCard.id)}
              onSlotSwap={(slot) => setSlotSwap(openCard.id, slot)}
              onSwapFlags={(patch) => {
                const i = staged.findIndex(
                  (x) => x.pickFor === openCard.id && x.move.kind === "archive",
                );
                if (i >= 0) setArchiveFlags(i, patch);
              }}
            />
          )}
        </div>
      </div>

      {menu?.kind === "card" && menuCard && (
        <Popover
          anchor={menu.anchor}
          label={nameOf(menuCard.id)}
          onClose={() => setMenu(null)}
        >
          <div className="px-2.5 pt-1.5 pb-1 text-[12px] font-semibold text-neutral-100">
            {nameOf(menuCard.id)}
          </div>
          {voiceMode && (
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setMenu(null);
                setDesignFor(menuCard.id);
              }}
            >
              {WandIcon} Design a voice
            </button>
          )}
          {!voiceMode ? null : stateOf(menuCard).sitOut ? (
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                backIn(menuCard);
                setMenu(null);
              }}
            >
              {Icon.sit} Back in
            </button>
          ) : (
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                sitOut(menuCard);
                setMenu(null);
              }}
            >
              {Icon.sit} Sit out this run
            </button>
          )}
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() => {
              setMenu(null);
              setTab("voice");
              setOpenId(menuCard.id);
              setRenameId(menuCard.id);
            }}
          >
            {Icon.pencil} Rename
          </button>
          <div className="mx-0.5 my-1 h-px bg-neutral-800" />
          {stateOf(menuCard).removed ? (
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                putBack(menuCard);
                setMenu(null);
              }}
            >
              Put back in the issue
            </button>
          ) : (
            <button
              type="button"
              className={`${MENU_ITEM} text-red-400`}
              onClick={() => {
                remove(menuCard);
                setMenu(null);
              }}
            >
              {Icon.out} Not in this issue
            </button>
          )}
        </Popover>
      )}

      {menu?.kind === "add" && (
        <AddMenu
          anchor={menu.anchor}
          data={data}
          onBoard={onBoard}
          voices={data.voices}
          onAdd={add}
          onClose={() => setMenu(null)}
        />
      )}

      {facesOpen && (
        <FacesDialog
          data={data}
          pages={pages}
          busy={busy}
          run={run}
          onClose={() => setFacesOpen(false)}
        />
      )}

      {designCard && (
        <DesignSheet
          key={designCard.id}
          scope={scope}
          card={designCard}
          name={nameOf(designCard.id)}
          staged={(() => {
            const m = stateOf(designCard).pick?.move;
            return m?.kind === "create_design" ? m : null;
          })()}
          onAccept={(move) => {
            pick(designCard, move);
            setDesignFor(null);
            setTab("voice");
            if (openId !== designCard.id) open(designCard.id);
          }}
          onClose={() => setDesignFor(null)}
        />
      )}

      {reviewOpen && (
        <ReviewSheet
          scope={scope}
          staged={staged}
          voiceMode={voiceMode}
          names={cards.map((c) => ({ id: c.id, name: nameOf(c.id) }))}
          onUndo={undo}
          onArchiveFlags={setArchiveFlags}
          onSitOut={(id) => {
            const c = cards.find((x) => x.id === id);
            if (c) sitOut(c);
          }}
          onRan={onRan}
          onClose={() => setReviewOpen(false)}
        />
      )}

      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed bottom-[22px] left-1/2 z-[60] -translate-x-1/2 rounded-lg border bg-neutral-800 px-3.5 py-2 text-[12.5px] shadow-xl shadow-black/50 transition ${
          toast ? "opacity-100" : "translate-y-2.5 opacity-0"
        } ${toast?.bad ? "border-red-900 text-red-400" : "border-neutral-700 text-neutral-100"}`}
      >
        {toast?.text}
      </div>
    </PlayerProvider>
  );
}
