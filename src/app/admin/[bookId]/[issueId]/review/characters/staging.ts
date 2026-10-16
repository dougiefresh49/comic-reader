// The casting page's staged moves (#787): an ordered list of `Move`s held in
// the browser, and what the board, the panel and the slot strip read from it.
// Nothing here writes; Review sends the moves to `reviewMoves`, Confirm to
// `confirmMoves`.

import type {
  ArchiveMove,
  Move,
  Roster,
  RosterSlot,
} from "~/lib/casting-moves";
import { slugify } from "~/lib/character-id";
import type { CharacterCard, VoiceOption } from "./types";

/**
 * One staged move. `pickFor` ties a move to a character's voice pick (the
 * archive that frees its slot, the `back_in` that lets it speak), so undoing
 * the pick undoes them too.
 */
export interface Staged {
  move: Move;
  pickFor?: string;
  /** The free slot a card was dropped on: where the strip draws its add. Never sent; a move names no slot. */
  slotHint?: number;
}

/** A move that sets a character's voice. */
export type PickMove = Extract<
  Move,
  { kind: "restore" | "create_design" | "cast" | "stand_in" }
>;

/** The character a move is about; an `add_character` by name means the id its name makes. */
export function characterOf(m: Move): string | null {
  if (m.kind === "add_character") return m.character_id ?? slugify(m.name);
  return "character_id" in m ? m.character_id : null;
}

/** Points every move staged for character `from`, and every move tied to its pick, at `to`. */
export function rekey(staged: Staged[], from: string, to: string): Staged[] {
  // `to` keeps its own pick: merging two would leave both picks' archives
  // staged for the one restore that survives (#866).
  const keep = staged.some((s) => isPick(s.move) && characterOf(s.move) === to)
    ? withoutPick(staged, from)
    : staged;
  return keep.map((s) => ({
    ...s,
    move:
      characterOf(s.move) === from
        ? ({ ...s.move, character_id: to } as Move)
        : s.move,
    pickFor: s.pickFor === from ? to : s.pickFor,
  }));
}

export function isPick(m: Move): m is PickMove {
  return (
    (m.kind === "restore" && m.character_id !== null) ||
    m.kind === "create_design" ||
    m.kind === "cast" ||
    m.kind === "stand_in"
  );
}

/** The voice a pick casts; null for a design, which has no `voices` row yet. */
export const pickVoiceId = (m: PickMove): string | null =>
  m.kind === "create_design" ? null : m.voice_uuid;

/** True for a move that takes a slot at Confirm. */
export const takesSlot = (m: Move) =>
  m.kind === "restore" || m.kind === "create_design";

/** What the board shows for one character once the staged moves run. */
export interface CardState {
  name: string;
  removed: boolean;
  sitOut: boolean;
  /** An `add_character` for it is staged. */
  added: boolean;
  /** Its staged pick, with the move's index. */
  pick: { index: number; move: PickMove } | null;
  /** The voice its radio rests on: the pick's, else the voice it has now. */
  voiceId: string | null;
  /** Any move about it is staged. */
  pending: boolean;
  /** A form's base (#891) once the staged moves run; null when the card is not a form. */
  base: {
    id: string;
    name: string;
    /**
     * Why the base gives its forms no voice that plays after the staged
     * moves (render chain step 5, `voiceFor`, then a slot); null when it does.
     */
    why: "none" | "removed" | "sitting out" | "no slot" | null;
    /** The card's voice is the base's, playable or not: it has no pick or voice of its own. `voiceId` is then the base's. */
    via: boolean;
    /** The base's staged pick, when `via` and the base's voice comes from one. */
    pick: { index: number; move: PickMove } | null;
  } | null;
}

/** The staged pick the card's voice comes from: its own, else its base's (#903). */
export const voicePick = (state: CardState) =>
  state.pick ?? state.base?.pick ?? null;

/**
 * True when the card will speak: it has a voice id, or a staged design that
 * makes one at Confirm. A null `voiceId` alone is not "no voice".
 */
export const isVoiced = (state: CardState): boolean =>
  state.voiceId !== null || voicePick(state)?.move.kind === "create_design";

/**
 * The slot the card's voice is in once the staged moves run: where a staged
 * pick that takes a slot lands (`landing`, null when none is left), else the
 * account slot of the voice it rests on. A form speaking with its base's
 * staged pick lands where that pick does (`landing` is the base pick's).
 * Null with no voice, and for a voice a staged archive takes out (`outIds`)
 * with no pick of its own.
 */
export function slotAfter(
  state: CardState,
  slotOf: Map<string, number>,
  landing: number | null,
  outIds: Set<string>,
): number | null {
  const pick = voicePick(state);
  if (pick && takesSlot(pick.move)) return landing;
  if (!state.voiceId) return null;
  if (!pick && outIds.has(state.voiceId)) return null;
  return slotOf.get(state.voiceId) ?? null;
}

/** The account's slots as the board reads them once the staged moves run. */
export interface SlotsAfter {
  slotOf: Map<string, number>;
  outIds: Set<string>;
  landing: SlotModel["landing"];
}

/**
 * True when the card's voice plays once the staged moves run: it is in a
 * slot after them. With no slots yet (`slots` null while the roster loads),
 * by the voice's status: an active voice, or a staged design. The board's
 * Ready / Needs a voice split (#854).
 */
export function plays(
  state: CardState,
  slots: SlotsAfter | null,
  statusOf: (voiceId: string) => VoiceOption["status"] | undefined,
): boolean {
  if (!isVoiced(state)) return false;
  const pick = voicePick(state);
  if (!slots)
    return (
      pick?.move.kind === "create_design" ||
      (state.voiceId !== null && statusOf(state.voiceId) === "active")
    );
  const landing = pick ? (slots.landing.get(pick.index) ?? null) : null;
  return slotAfter(state, slots.slotOf, landing, slots.outIds) !== null;
}

/** A form's base (#891), from the form's known row, with the base's card when it is on the board. */
export interface FormBase {
  id: string;
  name: string;
  card: CharacterCard | undefined;
  /** `plays` with the board's slots. */
  plays: (state: CardState) => boolean;
}

/**
 * What the board shows for one card once the staged moves run. A form
 * (`formOf`) with no pick or voice of its own takes its base's voice after
 * the base's staged moves, or none when the base has none to give (#903).
 */
export function cardState(
  card: CharacterCard,
  staged: Staged[],
  formOf: FormBase | null = null,
): CardState {
  const state: CardState = {
    name: card.name,
    removed: card.removed,
    sitOut: card.noAudio,
    added: false,
    pick: null,
    voiceId: card.voice?.uuid ?? null,
    pending: false,
    base: null,
  };
  staged.forEach(({ move: m }, index) => {
    if (characterOf(m) !== card.id) return;
    state.pending = true;
    if (m.kind === "add_character") {
      state.added = true;
      state.removed = false;
    } else if (m.kind === "remove_character") state.removed = true;
    else if (m.kind === "sit_out") state.sitOut = true;
    else if (m.kind === "back_in") state.sitOut = false;
    else if (m.kind === "rename") state.name = m.name;
    else if (isPick(m)) state.pick = { index, move: m };
  });
  if (state.pick) state.voiceId = pickVoiceId(state.pick.move);
  if (formOf) state.base = baseOf(card, state, formOf, staged);
  return state;
}

/**
 * A form's base once the staged moves run, and the form's voice through it.
 * Mirrors `voiceFor`'s step 5: the base gives its own voice in this issue,
 * none when it is out of the issue or sitting out, and never one it borrows
 * in turn. A base with no card here has no staged moves: the form's loaded
 * voice says what it gives.
 */
function baseOf(
  card: CharacterCard,
  state: CardState,
  formOf: FormBase,
  staged: Staged[],
): NonNullable<CardState["base"]> {
  const b = formOf.card ? cardState(formOf.card, staged) : null;
  const given: CardState = b ?? {
    ...state,
    removed: false,
    sitOut: false,
    pick: null,
    voiceId: card.voice?.borrowedFromId === formOf.id ? card.voice.uuid : null,
  };
  const borrowsInTurn =
    b !== null && b.pick === null && !!formOf.card?.voice?.borrowedFromId;
  const why = given.removed
    ? "removed"
    : given.sitOut
      ? "sitting out"
      : !isVoiced(given) || borrowsInTurn
        ? "none"
        : formOf.plays(given)
          ? null
          : "no slot";
  const ownVoice = !!card.voice && card.voice.borrowedFromId !== formOf.id;
  const borrows = !state.pick && !ownVoice;
  const via = borrows && (why === null || why === "no slot");
  if (borrows) state.voiceId = via ? given.voiceId : null;
  return {
    id: formOf.id,
    name: b?.name ?? formOf.name,
    why,
    via,
    pick: via ? given.pick : null,
  };
}

/**
 * The staged list with no move doubled: one archive per voice, one pick per
 * character, and one each of `sit_out`, `back_in`, `add_character`,
 * `remove_character` and `rename` per character (the last rename, else the
 * first; a `back_in` the owner pressed wins over one a pick tied on). Every
 * change to the list goes through it.
 */
export function oneEach(staged: Staged[]): Staged[] {
  const keep = staged.map(() => true);
  const seen = new Map<string, number>();
  staged.forEach(({ move: m, pickFor }, i) => {
    const who = characterOf(m);
    const key =
      m.kind === "archive"
        ? `archive:${m.voice_uuid ?? m.elevenlabs_id ?? ""}`
        : isPick(m)
          ? `pick:${who}`
          : `${m.kind}:${who}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      return;
    }
    const lastWins =
      m.kind === "rename" ||
      isPick(m) ||
      (m.kind === "back_in" &&
        pickFor === undefined &&
        staged[first]!.pickFor !== undefined);
    if (lastWins) {
      keep[first] = false;
      seen.set(key, i);
    } else keep[i] = false;
  });
  return staged.filter((_, i) => keep[i]);
}

/** Drops a character's pick and every move tied to it. */
export function withoutPick(staged: Staged[], characterId: string): Staged[] {
  return staged.filter(
    (s) =>
      s.pickFor !== characterId &&
      !(isPick(s.move) && characterOf(s.move) === characterId),
  );
}

/** The move a click on a voice row stages for a character. */
export function pickMove(card: CharacterCard, voice: VoiceOption): PickMove {
  const replaces_voice_uuid = card.voice?.uuid ?? null;
  if (voice.status === "archived")
    return {
      kind: "restore",
      voice_uuid: voice.id,
      character_id: card.id,
      replaces_voice_uuid,
    };
  // Its own voice, or a library voice it keeps: cast for this issue and the
  // book's later ones. Another character's voice is a stand-in, this issue only.
  if (voice.characterId === card.id || voice.status === "library")
    return {
      kind: "cast",
      character_id: card.id,
      voice_uuid: voice.id,
      replaces_voice_uuid,
    };
  return {
    kind: "stand_in",
    character_id: card.id,
    voice_uuid: voice.id,
    replaces_voice_uuid,
  };
}

/** The holder of a slot, as an archive move names it. */
export function archiveOf(
  slot: RosterSlot,
  backup = true,
  lossyOk = false,
): ArchiveMove | null {
  const h = slot.holder;
  if (h.kind === "free") return null;
  return h.voiceUuid
    ? { kind: "archive", voice_uuid: h.voiceUuid, backup, lossy_ok: lossyOk }
    : {
        kind: "archive",
        voice_uuid: null,
        elevenlabs_id: h.elevenLabsId,
        backup,
        lossy_ok: lossyOk,
      };
}

/** True when the archive move names the slot's holder. */
export function archives(m: Move, slot: RosterSlot): boolean {
  const h = slot.holder;
  if (m.kind !== "archive" || h.kind === "free") return false;
  return (
    (m.voice_uuid !== null && m.voice_uuid === h.voiceUuid) ||
    (!!m.elevenlabs_id && m.elevenlabs_id === h.elevenLabsId)
  );
}

export type SegmentState =
  | "ours"
  | "lock"
  | "other"
  | "pin"
  | "free"
  /** A voice the staged moves bring in. */
  | "in"
  /** A voice the staged moves archive. */
  | "out";

export interface SlotView {
  slot: RosterSlot;
  state: SegmentState;
  /** The staged archive that frees it. */
  outBy: number | null;
  /** The staged add that lands in it. */
  inBy: number | null;
}

export interface SlotModel {
  slots: SlotView[];
  /** Slots used once the staged moves run. */
  after: number;
  /** Staged add index to the slot it lands in, or null when none is left. */
  landing: Map<number, number | null>;
}

/**
 * Where the staged moves land on the account's slots. A guess the plan may
 * not follow (a move names no slot number), close enough for the strip:
 * an add tied to an archive lands in that archive's slot, else in the first
 * free one, else in any slot an archive frees.
 */
export function slotModel(roster: Roster, staged: Staged[]): SlotModel {
  const slots: SlotView[] = roster.slots.map((slot) => ({
    slot,
    state:
      slot.holder.kind === "free"
        ? "free"
        : slot.lock === "protected"
          ? "lock"
          : slot.holder.kind === "outside"
            ? slot.lock === "pinned"
              ? "pin"
              : "other"
            : "ours",
    outBy: null,
    inBy: null,
  }));
  let archived = 0;
  staged.forEach(({ move }, i) => {
    const s = slots.find((v) => v.outBy === null && archives(move, v.slot));
    if (s) {
      s.outBy = i;
      s.state = "out";
      archived++;
    }
  });
  const landing = new Map<number, number | null>();
  let adds = 0;
  staged.forEach(({ move, slotHint }, i) => {
    if (!takesSlot(move)) return;
    adds++;
    const who = characterOf(move);
    const tied = slots.find(
      (v) =>
        v.inBy === null && v.outBy !== null && staged[v.outBy]?.pickFor === who,
    );
    const target =
      tied ??
      slots.find(
        (v) =>
          v.inBy === null &&
          v.slot.holder.kind === "free" &&
          v.slot.index === slotHint,
      ) ??
      slots.find((v) => v.inBy === null && v.slot.holder.kind === "free") ??
      slots.find(
        (v) =>
          v.inBy === null &&
          v.outBy !== null &&
          staged[v.outBy]?.pickFor === undefined,
      );
    if (target) {
      target.inBy = i;
      target.state = "in";
    }
    landing.set(i, target ? target.slot.index : null);
  });
  return { slots, after: roster.used + adds - archived, landing };
}

/** Free slots a pick could take: free ones no other staged add lands in. */
export function freeFor(model: SlotModel, addIndex: number | null): number {
  return model.slots.filter(
    (v) =>
      v.slot.holder.kind === "free" && (v.inBy === null || v.inBy === addIndex),
  ).length;
}

/** "v2 voice, locked", "pinned by Bedtime Tales": why a slot cannot be freed. */
export function lockReason(slot: RosterSlot): string | null {
  switch (slot.lock) {
    case "protected":
      return "v2 voice, locked";
    case "pinned":
      return `pinned by ${slot.holder.kind === "outside" ? slot.holder.owner : "its project"}`;
    case "room":
      return "used by the room app";
    case "keep_active":
      return "marked keep active";
    default:
      return null;
  }
}

export const holderName = (slot: RosterSlot) =>
  slot.holder.kind === "free" ? "free" : slot.holder.name;

/** The voice a slot holds, by its `voices` row when it has one. */
export const holderVoiceId = (slot: RosterSlot) =>
  slot.holder.kind === "free" ? null : slot.holder.voiceUuid;

export const backupWord = (b: RosterSlot["backup"]) =>
  b === "ready"
    ? "backed up"
    : b === "at confirm"
      ? "backed up at confirm"
      : b === "lossy"
        ? "no backup"
        : "";
