// The panel's Voice tab (#787): every voice is a radio row and one click is
// the pick. A pick that needs a slot shows the Slot box (Free or Swap out).
// Then the character's first lines. Every change here is staged. A form
// that speaks with its base's voice (#891) shows that instead of the voices.
"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveMove, Roster, RosterSlot } from "~/lib/casting-moves";
import { acceptedFor } from "./design-sheet/accepted";
import { DesignVoiceRow } from "./design-sheet/DesignSheet";
import { MakeSample, PlayButton, PreviewSource } from "./player";
import {
  backupWord,
  freeFor,
  holderName,
  lockReason,
  takesSlot,
  type CardState,
  type SlotModel,
  type Staged,
} from "./staging";
import type {
  CharacterCard,
  KnownCharacter,
  SampleLine,
  VoiceOption,
} from "./types";
import { FOCUS, Icon, LABEL } from "./ui";

const TAG = "rounded px-1.5 text-[10px] font-semibold tracking-wide uppercase";
const TAG_NOW = `${TAG} bg-emerald-400/15 text-emerald-300`;
const TAG_NEW = `${TAG} bg-amber-400/15 text-amber-300`;
const TAG_LAB = `${TAG} bg-sky-400/15 text-sky-300`;
/** The line that says a form speaks with its base's voice (#891). */
const FORM_NOTE =
  "rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-[12.5px] text-neutral-300";

const ARROWS: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/**
 * A radio group's arrow keys (#754's behavior): from a row, Up/Left and
 * Down/Right move focus to the previous or next row that is not locked,
 * wrapping, and select it. A key pressed on a row's Play never gets here.
 */
function onRadioArrows(e: React.KeyboardEvent<HTMLElement>) {
  const step = ARROWS[e.key];
  const from = e.target as HTMLElement;
  if (!step || from.getAttribute("role") !== "radio") return;
  const rows = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      '[role="radio"]:not([aria-disabled="true"])',
    ),
  ];
  const i = rows.indexOf(from);
  if (i < 0) return;
  e.preventDefault();
  const to = rows[(i + step + rows.length) % rows.length]!;
  to.focus();
  if (to.getAttribute("aria-checked") !== "true") to.click();
}

/**
 * One radio row: the dot, the name, a grey line of facts, an optional note
 * that wraps rather than cuts off, and Play. Once
 * played, a line under it says where the audio came from, or, for a voice
 * with no audio anywhere, offers Make a sample. Only the group's tab stop is in the Tab order.
 */
function VoiceRow({
  name,
  sub,
  note,
  on,
  tabStop,
  locked,
  lockTitle,
  compact,
  playVoiceId,
  play,
  onPick,
}: {
  name: string;
  sub: React.ReactNode;
  /** A line under the facts that wraps, for text that must read in full. */
  note?: React.ReactNode;
  on: boolean;
  /** The group's one Tab stop: the checked row, else the first. */
  tabStop: boolean;
  locked?: boolean;
  lockTitle?: string;
  compact?: boolean;
  playVoiceId: string | null;
  /** A signed-URL take (staged design). Wins over `playVoiceId` when set. */
  play?: { url: string; playKey: string } | null;
  onPick: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={on}
      aria-disabled={locked ? true : undefined}
      tabIndex={tabStop && !locked ? 0 : -1}
      title={locked ? lockTitle : undefined}
      onClick={() => {
        if (!locked) onPick();
      }}
      onKeyDown={(e) => {
        if (locked || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onPick();
      }}
      className={`grid w-full grid-cols-[18px_1fr_auto] items-center gap-2.5 rounded-lg border text-left ${
        compact ? "mb-1 px-2.5 py-1.5" : "mb-1.5 px-2.5 py-2"
      } ${
        on
          ? "border-amber-400 bg-amber-400/10"
          : "border-neutral-700 bg-neutral-900 hover:border-neutral-500"
      } ${locked ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${FOCUS}`}
    >
      <span
        className={`grid size-4 place-items-center rounded-full border-[1.5px] ${
          on ? "border-amber-400" : "border-neutral-500"
        }`}
      >
        {locked ? (
          <span className="text-neutral-400">{Icon.lock}</span>
        ) : (
          on && <span className="size-2 rounded-full bg-amber-400" />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span
          className={`truncate text-[13px] text-neutral-100 ${compact ? "font-medium" : "font-semibold"}`}
        >
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-neutral-400">
          {sub}
        </span>
        {note && <span className="text-[11.5px] text-neutral-400">{note}</span>}
      </span>
      {play ? (
        <PlayButton url={play.url} playKey={play.playKey} name={name} />
      ) : playVoiceId ? (
        <PlayButton voiceId={playVoiceId} name={name} />
      ) : (
        <span />
      )}
      {!play && playVoiceId && (
        <>
          <PreviewSource voiceId={playVoiceId} />
          <MakeSample voiceId={playVoiceId} name={name} />
        </>
      )}
    </div>
  );
}

/**
 * The Swap out list sits low in the tab: scroll it into view as it mounts
 * (#882). Stable, so React calls it once per mount and not on each render.
 */
const intoView = (el: HTMLElement | null) =>
  el?.scrollIntoView({ block: "nearest" });

function SlotNumber({ n }: { n: number | null | undefined }) {
  return n ? (
    <span className="font-mono text-neutral-500">slot {n}</span>
  ) : null;
}

/**
 * The lines section, last in the tab: page, text with its [cues] in amber,
 * Play when the bubble has audio. At most about a quarter of the panel
 * (#882), scrolling inside itself.
 */
function Lines({ card }: { card: CharacterCard }) {
  if (card.samples.length === 0) return null;
  return (
    <section className="mt-4 flex max-h-[20vh] flex-col">
      <h4 className={`mb-1.5 flex shrink-0 items-baseline ${LABEL}`}>
        Lines
        <span className="ml-auto font-normal tracking-normal text-neutral-400 normal-case">
          {card.lines} · first {card.samples.length}
        </span>
      </h4>
      <div className="min-h-0 overflow-y-auto rounded-lg border border-neutral-800">
        {card.samples.map((l: SampleLine) => (
          <div
            key={l.bubbleId}
            className="grid grid-cols-[36px_1fr_28px] items-center gap-2 border-b border-neutral-800 px-2.5 py-1.5 last:border-b-0"
          >
            <span className="font-mono text-[11px] text-neutral-500">
              p.{l.page}
            </span>
            <span className="text-[12.5px] text-neutral-200">
              {l.text.split(/(\[[^\]]*\])/g).map((part, i) =>
                part.startsWith("[") ? (
                  <span key={i} className="text-amber-300">
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </span>
            {l.audioUrl ? (
              <PlayButton
                url={l.audioUrl}
                playKey={`line:${l.bubbleId}`}
                name={`page ${l.page} line`}
              />
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Why a character on the board is silent in this issue, as its chip says it. */
export type SilentWhy = "sitting out" | "not in this issue";

/**
 * One character on the board whose voice a voice is, once the staged moves
 * run (#882). `why` is null when it speaks in it here: it has lines in this
 * issue and is neither sitting out nor out of the issue. Else it says why the
 * character is silent, so a free voice can say who it would have been.
 */
export interface VoiceUser {
  id: string;
  name: string;
  why: SilentWhy | null;
}

/** Voice id to the board's characters whose voice it is (CastingScreen's `speakers`). */
export type VoiceUsers = Map<string, VoiceUser[]>;

/** The characters that speak in a voice here. */
export const speakingIn = (
  speakers: VoiceUsers,
  voiceId: string | null | undefined,
): VoiceUser[] =>
  voiceId ? (speakers.get(voiceId) ?? []).filter((u) => u.why === null) : [];

/**
 * A pick is staged for the card, which Confirm applies as the character's own
 * voice even when it is the voice the card borrows now (a form's base voice).
 */
function hasStagedPick(state: CardState): boolean {
  return state.pick !== null;
}

/**
 * A form (#891) that speaks with its base's voice: it has no voice of its
 * own (none, or the one borrowed from the base) and no pick staged here.
 * The Voice tab then says so instead of offering voices, and the panel hides
 * Design a voice.
 */
export function speaksAsBase(
  card: CharacterCard,
  state: CardState,
  formOf: KnownCharacter["formOf"],
): boolean {
  if (!formOf || hasStagedPick(state)) return false;
  return !card.voice || card.voice.borrowedFromId === formOf.id;
}

export interface VoiceTabProps {
  card: CharacterCard;
  state: CardState;
  /** The character it is a form of (#891), from its known row. */
  formOf: KnownCharacter["formOf"];
  staged: Staged[];
  voices: VoiceOption[];
  roster: Roster | null;
  model: SlotModel | null;
  /** Voice id to the characters on the board whose voice it is. */
  speakers: VoiceUsers;
  onPick: (voice: VoiceOption) => void;
  onSlotFree: () => void;
  onSlotSwap: (slot: RosterSlot) => void;
  onSwapFlags: (
    patch: Partial<Pick<ArchiveMove, "backup" | "lossy_ok">>,
  ) => void;
  /** Opens the design sheet for the character. */
  onDesign: () => void;
}

export function VoiceTab({
  card,
  state,
  formOf,
  staged,
  voices,
  roster,
  model,
  speakers,
  onPick,
  onSlotFree,
  onSlotSwap,
  onSwapFlags,
  onDesign,
}: VoiceTabProps) {
  const [expanded, setExpanded] = useState(false);
  const [swapMode, setSwapMode] = useState(false);
  const [search, setSearch] = useState("");

  const slotOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of roster?.slots ?? [])
      if (s.holder.kind !== "free" && s.holder.voiceUuid)
        m.set(s.holder.voiceUuid, s.index);
    return m;
  }, [roster]);
  const base = card.voice?.uuid ?? null;
  const silenced = state.sitOut || state.removed;
  const pick = state.pick;
  const design = pick?.move.kind === "create_design" ? pick.move : null;
  const accepted = design ? acceptedFor(design) : undefined;
  const acceptedTake =
    design && accepted
      ? accepted.takes.find(
          (t) => t.generated_voice_id === design.generated_voice_id,
        )
      : undefined;
  const landing =
    pick && model ? (model.landing.get(pick.index) ?? null) : null;
  const slotFor = (v: VoiceOption) =>
    pick?.move.kind === "restore" && pick.move.voice_uuid === v.id
      ? landing
      : slotOf.get(v.id);

  const own = voices
    .filter(
      (v) =>
        v.characterId === card.id &&
        (v.status === "active" || v.status === "archived"),
    )
    .sort(
      (a, b) =>
        Number(b.id === base) - Number(a.id === base) ||
        Number(b.status === "active") - Number(a.status === "active") ||
        Number(b.labPick) - Number(a.labPick) ||
        a.name.localeCompare(b.name),
    );
  const others = voices
    .filter(
      (v) => v.status === "active" && v.characterId !== card.id && !v.protected,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const library = voices
    .filter((v) => v.status === "library")
    .sort((a, b) => a.name.localeCompare(b.name));
  const current = voices.find((v) => v.id === state.voiceId);
  const otherOn =
    !silenced && current && !own.some((v) => v.id === current.id)
      ? current
      : null;

  const sub = (v: VoiceOption) => (
    <>
      <span>{v.kind}</span>
      {v.status === "archived" && !slotFor(v) && <span>· archived</span>}
      {slotFor(v) ? <span>·</span> : null}
      <SlotNumber n={slotFor(v)} />
      {pick?.move.kind === "restore" && pick.move.voice_uuid === v.id ? (
        <span className={TAG_NEW}>new</span>
      ) : (
        v.id === base &&
        v.status === "active" && <span className={TAG_NOW}>now</span>
      )}
      {v.labPick && v.status === "archived" && (
        <span className={TAG_LAB}>lab pick</span>
      )}
      {v.protected && (
        <span title="v2 voice, locked" className="text-neutral-500">
          {Icon.lock}
        </span>
      )}
    </>
  );

  // The Slot box: only when the pick takes a slot.
  const needsSlot = pick && takesSlot(pick.move) && model && roster;
  const tied = staged.findIndex(
    (s) => s.pickFor === card.id && s.move.kind === "archive",
  );
  const tiedMove = tied >= 0 ? (staged[tied]!.move as ArchiveMove) : null;
  const tiedSlot =
    tied >= 0 ? model?.slots.find((v) => v.outBy === tied)?.slot : undefined;
  const free = model && pick ? freeFor(model, pick.index) : 0;
  // An undone swap (Review's ✕, the strip's Keep it) puts the box back on Free.
  const hadTied = useRef(false);
  useEffect(() => {
    if (hadTied.current && !tiedMove) setSwapMode(false);
    hadTied.current = tiedMove !== null;
  }, [tiedMove]);
  const mode: "free" | "swap" =
    tiedMove || swapMode || free === 0 ? "swap" : "free";
  // Its own voice, unless a staged archive already frees that slot (as `pick` chooses).
  const ownSlot = model?.slots.find(
    (v) =>
      v.slot.holder.kind === "repo" &&
      v.slot.holder.characterId === card.id &&
      v.slot.lock === "movable" &&
      v.outBy === null,
  )?.slot;

  const q = search.trim().toLowerCase();
  // Who in this issue speaks in a slot's voice, this character included.
  const usedBy = (s: RosterSlot) =>
    s.holder.kind !== "free" ? speakingIn(speakers, s.holder.voiceUuid) : [];
  // A voice no one speaks in here: the board's characters it belongs to, and why each is silent.
  const freeWhy = (s: RosterSlot) =>
    s.holder.kind !== "free" && s.holder.voiceUuid
      ? (speakers.get(s.holder.voiceUuid) ?? [])
          .filter((u) => u.why !== null)
          .map((u) => `${u.name} · ${u.why}`)
      : [];
  // The Swap out list's groups in display order: its own, movable and unused
  // here, movable and used here, then locked.
  const group = (s: RosterSlot) =>
    s.holder.kind === "repo" && s.holder.characterId === card.id
      ? 0
      : s.lock !== "movable"
        ? 3
        : usedBy(s).length > 0
          ? 2
          : 1;
  const HEADING: Record<number, string> = {
    1: "Not used in this issue",
    2: "Used in this issue",
  };
  const candidates = (model?.slots ?? [])
    .filter(
      (v) =>
        v.slot.holder.kind !== "free" &&
        (v.outBy === null ? v.inBy === null : v.outBy === tied),
    )
    .map((v) => v.slot)
    .filter(
      (s) =>
        !q ||
        holderName(s).toLowerCase().includes(q) ||
        (s.holder.kind === "outside" &&
          s.holder.owner.toLowerCase().includes(q)),
    )
    .sort((a, b) => {
      const outside = (s: RosterSlot) => (s.holder.kind === "outside" ? 1 : 0);
      return (
        group(a) - group(b) || outside(a) - outside(b) || a.index - b.index
      );
    });
  // Each radio group's one Tab stop: its checked row, else its first.
  const shownVoices = [...own, ...(expanded ? [...library, ...others] : [])];
  const voiceStop = design
    ? null
    : (shownVoices.find((v) => !silenced && v.id === state.voiceId)?.id ??
      shownVoices[0]?.id);
  const swapStop =
    candidates.find((s) => s.index === tiedSlot?.index)?.index ??
    candidates.find((s) => s.lock === "movable")?.index;
  // This character is leaving the voice, so only the others go silent.
  const silentIfSwapped = tiedSlot
    ? usedBy(tiedSlot)
        .filter((u) => u.id !== card.id)
        .map((u) => u.name)
    : [];

  // A form (#891) speaks with its base's voice: the render chain's step 5.
  // Its own castlist row's voice, or a pick staged here, still wins (step
  // 4), so those cases keep the choices to change or clear it.
  const form = formOf ?? null;
  if (form && speaksAsBase(card, state, form))
    return (
      <div>
        <p className={FORM_NOTE}>
          {`${state.name} is a form of ${form.name}: it speaks with ${form.name}'s voice${
            card.voice ? `, ${card.voice.name}` : ""
          }.`}
        </p>
        <Lines card={card} />
      </div>
    );

  return (
    <div>
      {form && (
        <p className={`mb-3 ${FORM_NOTE}`}>
          {hasStagedPick(state) || !card.voice
            ? `${state.name} has a voice picked here, which plays instead of ${form.name}'s.`
            : `${state.name} still has its own voice ${card.voice.name} in this book, which plays instead of ${form.name}'s.`}
        </p>
      )}
      <section role="radiogroup" aria-label="Voices" onKeyDown={onRadioArrows}>
        <h4 className={`mb-1.5 flex items-baseline ${LABEL}`}>
          Voices
          {silenced && (
            <span className="ml-auto font-normal tracking-normal text-neutral-400 normal-case">
              {state.removed ? "not in this issue" : "sitting out"}
            </span>
          )}
        </h4>
        {own.map((v) => (
          <VoiceRow
            key={v.id}
            name={v.name}
            sub={sub(v)}
            on={!silenced && state.voiceId === v.id}
            tabStop={v.id === voiceStop}
            playVoiceId={v.id}
            onPick={() => onPick(v)}
          />
        ))}
        {design && (
          <VoiceRow
            name={
              accepted ? `${state.name} · take ${accepted.take}` : state.name
            }
            sub={
              <>
                <span>designed</span>
                {landing ? <span>·</span> : null}
                <SlotNumber n={landing} />
                <span className={TAG_NEW}>new</span>
                {design.run_only && (
                  <span className={`${TAG} bg-neutral-800 text-neutral-400`}>
                    this run
                  </span>
                )}
              </>
            }
            on={!silenced}
            tabStop
            playVoiceId={null}
            play={
              acceptedTake
                ? {
                    url: acceptedTake.url,
                    playKey: `take:${design.generated_voice_id}`,
                  }
                : null
            }
            onPick={onDesign}
          />
        )}
        <DesignVoiceRow characterId={card.id} onOpen={onDesign} />
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded((x) => !x)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setExpanded((x) => !x);
          }}
          className={`mb-1.5 grid cursor-pointer grid-cols-[18px_1fr] items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
            otherOn
              ? "border-amber-400 bg-amber-400/10"
              : "border-neutral-700 bg-neutral-900 hover:border-neutral-500"
          } ${FOCUS}`}
        >
          <span
            className={`text-neutral-400 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {Icon.chev}
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-[13px] font-semibold text-neutral-100">
              {otherOn ? `as ${otherOn.name}` : "Another voice"}
            </span>
            <span className="truncate text-[11.5px] text-neutral-400">
              {otherOn
                ? otherOn.status === "library"
                  ? "library · no slot"
                  : "stand-in · no slot"
                : `${others.length} active · ${library.length} library`}
            </span>
          </span>
        </div>
        {expanded && (
          <div className="mb-2.5 pl-0">
            {[...library, ...others].map((v) => {
              const says = speakingIn(speakers, v.id)
                .filter((u) => u.id !== card.id)
                .map((u) => u.name);
              return (
                <VoiceRow
                  key={v.id}
                  compact
                  name={v.name}
                  sub={
                    <>
                      <span>{v.status === "library" ? "library" : v.kind}</span>
                      {slotOf.get(v.id) && <span>·</span>}
                      <SlotNumber n={slotOf.get(v.id)} />
                      {says.length > 0 && (
                        <span className="truncate text-neutral-500">
                          · {says.join(", ")}
                        </span>
                      )}
                    </>
                  }
                  on={!silenced && state.voiceId === v.id}
                  tabStop={v.id === voiceStop}
                  playVoiceId={v.id}
                  onPick={() => onPick(v)}
                />
              );
            })}
          </div>
        )}
      </section>

      {needsSlot && (
        <section
          aria-label="Slot"
          className="mt-1 rounded-xl border border-amber-700/60 bg-amber-950/30 px-3 py-2.5"
        >
          <h4 className={`mb-2 flex items-baseline ${LABEL} text-amber-400`}>
            Slot
            <span className="ml-auto font-normal tracking-normal text-neutral-400 normal-case">
              {free} free
            </span>
          </h4>
          <div className="mb-2 flex gap-1">
            <button
              type="button"
              disabled={free === 0}
              aria-pressed={mode === "free"}
              onClick={() => {
                setSwapMode(false);
                onSlotFree();
              }}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS} ${
                mode === "free"
                  ? "border-amber-400 bg-amber-400/10 text-neutral-100"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400"
              }`}
            >
              Free
              {mode === "free" && landing ? (
                <span className="ml-1.5 font-mono text-neutral-500">
                  · {landing}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-pressed={mode === "swap"}
              onClick={() => {
                setSwapMode(true);
                if (!tiedMove && ownSlot) onSlotSwap(ownSlot);
              }}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[13px] font-medium ${FOCUS} ${
                mode === "swap"
                  ? "border-amber-400 bg-amber-400/10 text-neutral-100"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400"
              }`}
            >
              Swap out
            </button>
          </div>
          {mode === "swap" && (
            <>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search voices"
                aria-label="Search voices"
                className={`mb-1.5 h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-[13px] text-neutral-100 placeholder:text-neutral-500 ${FOCUS}`}
              />
              <div
                role="radiogroup"
                aria-label="Voice to swap out"
                key={card.id}
                ref={intoView}
                onKeyDown={onRadioArrows}
                // Grows into the space Lines' cap frees (#882): half the screen, not a fixed 230px.
                className="max-h-[50vh] overflow-y-auto"
              >
                {candidates.map((s, i) => {
                  const h = s.holder;
                  if (h.kind === "free") return null;
                  const why = lockReason(s);
                  const g = group(s);
                  const isOwn = g === 0;
                  const says = g === 2 ? usedBy(s).map((u) => u.name) : [];
                  const silent = g === 1 ? freeWhy(s) : [];
                  const heading =
                    HEADING[g] && (i === 0 || group(candidates[i - 1]!) !== g)
                      ? HEADING[g]
                      : null;
                  const kind = voices.find((v) => v.id === h.voiceUuid)?.kind;
                  return (
                    <Fragment key={s.index}>
                      {heading && (
                        <div className={`mt-1.5 mb-1 first:mt-0 ${LABEL}`}>
                          {heading}
                        </div>
                      )}
                      <VoiceRow
                        compact
                        name={h.name}
                        on={tiedSlot?.index === s.index}
                        tabStop={s.index === swapStop}
                        locked={why !== null}
                        lockTitle={why ?? undefined}
                        sub={
                          <>
                            {s.backup && (
                              <span
                                title={backupWord(s.backup)}
                                className={`size-1.5 shrink-0 rounded-full ${
                                  s.backup === "ready"
                                    ? "bg-emerald-400"
                                    : s.backup === "at confirm"
                                      ? "bg-sky-400"
                                      : "border border-red-400"
                                }`}
                              />
                            )}
                            {h.kind === "outside" && <span>{h.owner} ·</span>}
                            {kind && <span>{kind} ·</span>}
                            <SlotNumber n={s.index} />
                            {s.backup && <span>· {backupWord(s.backup)}</span>}
                            {isOwn && <span className={TAG_NOW}>its own</span>}
                            {why && <span className="truncate">· {why}</span>}
                            {says.length > 0 && (
                              <span className="truncate">
                                · {says.join(", ")}
                              </span>
                            )}
                          </>
                        }
                        note={silent.length > 0 && silent.join(", ")}
                        playVoiceId={h.voiceUuid}
                        onPick={() => onSlotSwap(s)}
                      />
                    </Fragment>
                  );
                })}
              </div>
              {tiedMove && tiedSlot ? (
                <>
                  {silentIfSwapped.length > 0 && (
                    <p className="pt-1.5 text-[12px] text-red-400">
                      Leaves {silentIfSwapped.join(", ")} silent
                    </p>
                  )}
                  {tiedSlot.backup === "lossy" ? (
                    <label className="flex items-center gap-2 pt-1.5 text-[12px] text-red-400">
                      <input
                        type="checkbox"
                        checked={tiedMove.lossy_ok}
                        onChange={(e) =>
                          onSwapFlags({ lossy_ok: e.target.checked })
                        }
                        className={`size-3.5 accent-amber-400 ${FOCUS}`}
                      />
                      Archive anyway
                      <span className="ml-auto text-neutral-500">
                        no backup · lost
                      </span>
                    </label>
                  ) : (
                    <label className="flex items-center gap-2 pt-1.5 text-[12px] text-neutral-300">
                      <input
                        type="checkbox"
                        checked={tiedMove.backup}
                        onChange={(e) =>
                          onSwapFlags({ backup: e.target.checked })
                        }
                        className={`size-3.5 accent-amber-400 ${FOCUS}`}
                      />
                      Back up first
                      <span className="ml-auto text-neutral-500">
                        {backupWord(tiedSlot.backup)}
                      </span>
                    </label>
                  )}
                </>
              ) : (
                <p className="pt-1.5 text-[12px] text-red-400">
                  Pick a voice to swap out
                </p>
              )}
            </>
          )}
        </section>
      )}

      <Lines card={card} />
    </div>
  );
}
