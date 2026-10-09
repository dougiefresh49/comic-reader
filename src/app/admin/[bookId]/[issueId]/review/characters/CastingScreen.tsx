// The casting page (#787): one page for characters and voices. A contact
// sheet of face cards grouped by lines, a docked panel per character, the
// account's slot strip in the header, and Review, the one list of the
// staged moves. Every voice and cast change is staged in the browser and
// runs at Confirm; the Faces work still saves as it is done.
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
import { useTabTrap } from "~/hooks/useTabTrap";
import type {
  ArchiveMove,
  CreateDesignMove,
  Move,
  Roster,
  RosterSlot,
  RunResult,
} from "~/lib/casting-moves";
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
  voicePreview,
  type ActionResult,
  type NameTarget,
} from "./actions";
import { loadRoster } from "./casting-actions";
import { CharacterPanel, type PanelTab } from "./CharacterPanel";
import { DesignSheet, WandIcon } from "./design-sheet/DesignSheet";
import { PlayButton, PlayerProvider } from "./player";
import { ReviewSheet } from "./ReviewSheet";
import { FacesPanel, NameField, matchesName } from "./shared";
import { SlotStrip, type Carry } from "./SlotStrip";
import {
  archiveOf,
  cardState,
  characterOf,
  freeFor,
  isPick,
  oneEach,
  lockReason,
  pickMove,
  pickVoiceId,
  slotModel,
  takesSlot,
  withoutPick,
  type CardState,
  type SlotModel,
  type SlotView,
  type Staged,
} from "./staging";
import type {
  CharacterCard,
  CharactersData,
  FaceView,
  PageView,
  VoiceOption,
} from "./types";
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

/** The DOM id of a card, so closing the panel can hand focus back to it. */
const cardDomId = (id: string) => `cast-card-${id}`;

const GROUPS = [
  { key: "lead", label: "Leads", hint: "10+ lines" },
  { key: "sup", label: "Supporting", hint: "3–9 lines" },
  { key: "one", label: "One-offs", hint: "1–2 lines" },
  { key: "silent", label: "No lines", hint: "silent here" },
  { key: "role", label: "Roles", hint: "captions" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

const groupOf = (c: CharacterCard): GroupKey =>
  c.group === "role"
    ? "role"
    : c.lines >= 10
      ? "lead"
      : c.lines >= 3
        ? "sup"
        : c.lines >= 1
          ? "one"
          : "silent";

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
}: {
  card: CharacterCard;
  state: CardState;
  voices: Map<string, VoiceOption>;
  slotOf: Map<string, number>;
  landing: number | null;
  /** Voices a staged archive takes out. */
  outIds: Set<string>;
}) {
  const dot = (cls: string, title?: string) => (
    <span title={title} className={`size-[7px] shrink-0 rounded-full ${cls}`} />
  );
  const dim = "truncate text-neutral-400";
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
    const pending = state.pick !== null;
    const slot =
      pending && takesSlot(state.pick!.move) ? landing : slotOf.get(v.id);
    const lost = !pending && outIds.has(v.id);
    if (lost)
      return (
        <>
          {dot("bg-red-400")}
          <span className="truncate text-neutral-100">lost its voice</span>
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
        ) : v.status === "archived" ? (
          <span className="text-[11px] text-red-400">no slot</span>
        ) : null}
        <span className="ml-auto">
          <PlayButton voiceId={v.id} name={v.name} size="sm" />
        </span>
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

function CastCard({
  card,
  state,
  isNew,
  selected,
  pages,
  chip,
  onOpen,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  card: CharacterCard;
  state: CardState;
  isNew: boolean;
  selected: boolean;
  pages: Map<number, PageView>;
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
    !state.voiceId && !state.sitOut && !state.removed && card.lines > 0;
  const quiet = state.sitOut || state.removed;
  return (
    <div
      ref={ref}
      id={cardDomId(card.id)}
      role="button"
      tabIndex={0}
      aria-label={state.name}
      aria-pressed={selected}
      draggable={!state.removed}
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
          className={`absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-neutral-950/95 via-neutral-950/75 to-transparent px-2 pt-5 pb-1.5 text-[13px] leading-tight font-semibold ${
            quiet ? "text-neutral-400" : "text-white"
          }`}
        >
          {state.name}
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
  onBoard: Set<string>;
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
  const shown = rows
    .filter((r) => !q || slugify(r.name).includes(q) || r.id?.includes(q))
    .slice(0, 12);
  const exact = shown.find(
    (r) => slugify(r.name) === q || (r.id !== null && r.id === q),
  );
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
          if (exact) add(exact.id, exact.name);
          else if (shown.length === 1) add(shown[0]!.id, shown[0]!.name);
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
      <button
        type="button"
        disabled={!query.trim() || exact !== undefined}
        onClick={() => add(null, query.trim())}
        className={MENU_ITEM}
      >
        {Icon.pencil} New: {query.trim() || "…"}
      </button>
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
  useEffect(readRoster, [readRoster]);

  /** An immediate write (the Faces work, Approve, Continue): run, say the answer, refresh. */
  const run = useCallback(
    (label: string, work: () => Promise<ActionResult>) => {
      say(`${label}…`);
      startTransition(async () => {
        try {
          const r = await work();
          say(r.ok ? r.message : r.error, !r.ok);
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
  const states = useMemo(
    () => new Map(cards.map((c) => [c.id, cardState(c, staged)])),
    [cards, staged],
  );
  const stateOf = (c: CharacterCard) =>
    states.get(c.id) ?? cardState(c, staged);
  const onBoard = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const nameOf = useCallback(
    (id: string) =>
      states.get(id)?.name ?? cards.find((c) => c.id === id)?.name ?? id,
    [states, cards],
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
  /** Voice id to the board's characters that speak in it now. */
  const speakers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of cards)
      if (c.voice?.uuid && !c.noAudio && !c.removed)
        m.set(c.voice.uuid, [...(m.get(c.voice.uuid) ?? []), c.name]);
    return m;
  }, [cards]);

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
    const base = card.voice?.uuid ?? null;
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
        ? "Confirmed · the account matches the strip"
        : "Stopped · what did not run is still staged",
      result.status !== "done",
    );
    readRoster();
    router.refresh();
  };

  const grouped = new Map<GroupKey, CharacterCard[]>();
  for (const c of cards) {
    const k = groupOf(c);
    grouped.set(k, [...(grouped.get(k) ?? []), c]);
  }
  for (const list of grouped.values())
    list.sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

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
          <button
            type="button"
            onClick={(e) => setMenu({ kind: "add", anchor: e.currentTarget })}
            className={BTN}
          >
            + Add
          </button>
          <button
            type="button"
            disabled={staged.length === 0}
            onClick={() => setReviewOpen(true)}
            className={BTN_PRIMARY}
          >
            Review <span className={COUNT}>{staged.length}</span>
          </button>
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

        <div className="flex min-h-0 flex-1">
          <main
            aria-label="Cast"
            className="min-w-0 flex-1 overflow-y-auto px-[18px] pt-1.5 pb-10"
          >
            {GROUPS.map((g) => {
              const list = grouped.get(g.key) ?? [];
              if (list.length === 0 && g.key !== "silent") return null;
              return (
                <section key={g.key} aria-label={g.label}>
                  <h2 className="flex items-baseline gap-2.5 px-0.5 pt-[18px] pb-2 text-[11px] tracking-[0.08em] text-neutral-500 uppercase">
                    <b className="font-semibold text-neutral-400">{g.label}</b>
                    <span className="font-mono tracking-normal text-neutral-400">
                      {list.length}
                    </span>
                    <span className="tracking-normal normal-case">
                      {g.hint}
                    </span>
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5">
                    {list.map((c) => {
                      const st = stateOf(c);
                      return (
                        <CastCard
                          key={c.id}
                          card={c}
                          state={st}
                          isNew={addedIds.has(c.id)}
                          selected={openId === c.id}
                          pages={pages}
                          chip={
                            <Chip
                              card={c}
                              state={st}
                              voices={voiceById}
                              slotOf={slotOf}
                              landing={
                                st.pick && model
                                  ? (model.landing.get(st.pick.index) ?? null)
                                  : null
                              }
                              outIds={outIds}
                            />
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
                    {g.key === "silent" && (
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
                    )}
                  </div>
                </section>
              );
            })}
          </main>

          {openCard && (
            <CharacterPanel
              key={openCard.id}
              card={openCard}
              state={stateOf(openCard)}
              pages={pages}
              cards={cards}
              known={data.known}
              busy={busy}
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
                run(`Moving the page ${face.page} face to ${name}`, () =>
                  moveFace({
                    scope,
                    detectionId: face.id,
                    target,
                    franchiseId: data.franchiseId,
                  }),
                )
              }
              onMoveMany={(faces, target, name) =>
                run(`Moving ${faces.length} faces to ${name}`, () =>
                  moveFaces({
                    scope,
                    detectionIds: faces.map((f) => f.id),
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
          {stateOf(menuCard).sitOut ? (
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
