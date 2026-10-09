// The header's slot strip (#787): the account's voice slots from
// `loadRoster()`, with the staged moves drawn in. A click on a segment opens
// Free this slot or Keep it; a card dropped on a segment gives it that slot;
// a segment dragged onto "free the slot" frees it. Each drag stages exactly
// what its click path stages.
"use client";

import { useState } from "react";
import type { Roster } from "~/lib/casting-moves";
import {
  backupWord,
  holderName,
  lockReason,
  type SlotModel,
  type SlotView,
  type Staged,
} from "./staging";
import type { VoiceOption } from "./types";
import { FOCUS, Icon, MENU_ITEM, Popover } from "./ui";

/** What is being dragged: a character card, or a slot segment. */
export type Carry =
  | { type: "char"; id: string }
  | { type: "slot"; index: number };

const SEG: Record<SlotView["state"], string> = {
  ours: "bg-emerald-700/80",
  lock: "bg-neutral-600 bg-[repeating-linear-gradient(45deg,transparent_0_2px,rgb(115_115_115)_2px_3px)]",
  other: "bg-sky-800",
  pin: "bg-sky-800 bg-[repeating-linear-gradient(45deg,transparent_0_2px,rgb(56_120_170)_2px_3px)]",
  in: "bg-amber-400",
  out: "border border-dashed border-red-400 bg-transparent",
  free: "border border-dashed border-neutral-600 bg-transparent",
};

const kindOf = (v: SlotView, voices: Map<string, VoiceOption>) =>
  v.slot.holder.kind === "repo"
    ? voices.get(v.slot.holder.voiceUuid)?.kind
    : undefined;

function segmentTitle(v: SlotView, voices: Map<string, VoiceOption>): string {
  const s = v.slot;
  if (s.holder.kind === "free")
    return v.state === "in"
      ? `${s.index} · new at confirm`
      : `${s.index} · free`;
  return [
    `${s.index} · ${s.holder.name}`,
    s.holder.kind === "outside" ? s.holder.owner : null,
    kindOf(v, voices),
    backupWord(s.backup) || null,
    lockReason(s),
    v.state === "out" ? "freed at confirm" : null,
    v.state === "in" ? "swapped at confirm" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SlotStrip({
  roster,
  error,
  model,
  staged,
  voices,
  speakers,
  nameOf,
  onBoard,
  carry,
  onCarry,
  onFree,
  onKeep,
  onOpen,
  onDropCard,
}: {
  roster: Roster | null;
  error: string | null;
  model: SlotModel | null;
  staged: Staged[];
  voices: Map<string, VoiceOption>;
  /** Voice id to the names of the board's characters that speak in it now. */
  speakers: Map<string, string[]>;
  /** A character's name on the board, staged renames included. */
  nameOf: (characterId: string) => string;
  onBoard: (characterId: string) => boolean;
  carry: Carry | null;
  onCarry: (carry: Carry | null) => void;
  onFree: (v: SlotView) => void;
  onKeep: (stagedIndex: number) => void;
  onOpen: (characterId: string) => void;
  onDropCard: (characterId: string, v: SlotView) => void;
}) {
  const [menu, setMenu] = useState<{
    index: number;
    anchor: HTMLElement;
  } | null>(null);
  const [over, setOver] = useState<number | "release" | null>(null);

  if (!roster || !model)
    return (
      <div className="ml-auto truncate text-[12px] text-neutral-500">
        {error ? `Slots: ${error}` : "Slots…"}
      </div>
    );

  const owners = new Map<string, { n: number; pinned: boolean }>();
  for (const s of roster.slots)
    if (s.holder.kind === "outside") {
      const o = owners.get(s.holder.owner) ?? { n: 0, pinned: false };
      o.n++;
      if (s.lock === "pinned") o.pinned = true;
      owners.set(s.holder.owner, o);
    }
  const delta = model.after - roster.used;
  const open = menu
    ? model.slots.find((v) => v.slot.index === menu.index)
    : null;
  const draggable = (v: SlotView) =>
    v.slot.lock === "movable" && (v.state === "ours" || v.state === "other");
  const droppable = (v: SlotView) =>
    carry?.type === "char" &&
    v.state !== "in" &&
    v.state !== "out" &&
    v.slot.lock !== "protected" &&
    v.slot.lock !== "pinned" &&
    v.slot.lock !== "room" &&
    v.slot.lock !== "keep_active";

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2.5">
      <div
        role="group"
        aria-label="Voice slots"
        className={`flex gap-[2px] rounded-md border p-1 ${
          carry?.type === "char"
            ? "border-amber-400 bg-amber-400/10"
            : "border-transparent"
        }`}
      >
        {model.slots.map((v) => {
          const title = segmentTitle(v, voices);
          return (
            <button
              key={v.slot.index}
              type="button"
              title={title}
              aria-label={title}
              draggable={draggable(v)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", `slot:${v.slot.index}`);
                onCarry({ type: "slot", index: v.slot.index });
              }}
              onDragEnd={() => {
                onCarry(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!droppable(v)) return;
                e.preventDefault();
                setOver(v.slot.index);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (carry?.type === "char") onDropCard(carry.id, v);
                onCarry(null);
              }}
              onClick={(e) =>
                setMenu({ index: v.slot.index, anchor: e.currentTarget })
              }
              className={`h-[18px] w-2.5 shrink-0 rounded-[2.5px] transition-transform hover:-translate-y-0.5 ${SEG[v.state]} ${
                over === v.slot.index
                  ? "outline-2 outline-offset-1 outline-amber-400"
                  : ""
              } ${carry?.type === "char" && !droppable(v) ? "opacity-35" : ""} ${FOCUS}`}
            />
          );
        })}
      </div>
      <div className="text-[13px] whitespace-nowrap text-neutral-400 tabular-nums">
        <b className="font-semibold text-neutral-100">{model.after}</b>/
        {roster.limit}
        {delta !== 0 && (
          <span
            className={`ml-1 ${delta > 0 ? "text-amber-400" : "text-red-400"}`}
          >
            {delta > 0 ? `+${delta}` : `−${-delta}`}
          </span>
        )}
      </div>
      {carry?.type === "slot" ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver("release");
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const v = model.slots.find((s) => s.slot.index === carry.index);
            if (v) onFree(v);
            onCarry(null);
          }}
          className={`rounded-md border border-dashed border-red-400 px-2 py-0.5 text-[11px] whitespace-nowrap text-red-400 ${
            over === "release" ? "bg-red-500/15" : ""
          }`}
        >
          free the slot
        </div>
      ) : (
        <div
          aria-label="Slots held by other projects"
          className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-neutral-500"
        >
          {[...owners].map(([name, o], i) => (
            <span key={name} className="inline-flex items-center gap-1">
              {i > 0 && <span>·</span>}
              {name} {o.n}
              {o.pinned && (
                <span className="text-neutral-400" title="pinned">
                  {Icon.lock}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {menu && open && (
        <Popover
          anchor={menu.anchor}
          label={`Slot ${open.slot.index}`}
          onClose={() => setMenu(null)}
        >
          <SlotMenu
            v={open}
            staged={staged}
            voices={voices}
            speakers={speakers}
            nameOf={nameOf}
            onBoard={onBoard}
            onFree={() => {
              onFree(open);
              setMenu(null);
            }}
            onKeep={(i) => {
              onKeep(i);
              setMenu(null);
            }}
            onOpen={(id) => {
              setMenu(null);
              onOpen(id);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function SlotMenu({
  v,
  staged,
  voices,
  speakers,
  nameOf,
  onBoard,
  onFree,
  onKeep,
  onOpen,
}: {
  v: SlotView;
  staged: Staged[];
  voices: Map<string, VoiceOption>;
  speakers: Map<string, string[]>;
  nameOf: (characterId: string) => string;
  onBoard: (characterId: string) => boolean;
  onFree: () => void;
  onKeep: (stagedIndex: number) => void;
  onOpen: (characterId: string) => void;
}) {
  const s = v.slot;
  const title = (
    <div className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wider text-neutral-500 uppercase">
      Slot {s.index}{" "}
      <b className="text-[12px] font-semibold tracking-normal text-neutral-100 normal-case">
        {holderName(s)}
      </b>
    </div>
  );
  if (s.holder.kind === "free")
    return (
      <>
        {title}
        <div className="px-2.5 pb-1.5 text-[12px] text-neutral-400">
          {v.state === "in" ? "new at confirm" : "drop a card here"}
        </div>
      </>
    );
  const h = s.holder;
  const characterId = h.kind === "repo" ? h.characterId : null;
  const says = h.voiceUuid ? (speakers.get(h.voiceUuid) ?? []) : [];
  const why = lockReason(s);
  const outBy = v.outBy !== null ? staged[v.outBy] : undefined;
  const row = (k: string, val: React.ReactNode) => (
    <div className="flex gap-2 px-2.5 py-0.5 text-[12px] text-neutral-400">
      <span className="min-w-[52px] text-neutral-500">{k}</span>
      {val}
    </div>
  );
  return (
    <>
      {title}
      {row("owner", h.kind === "outside" ? h.owner : "comic-reader")}
      {h.kind === "repo" &&
        row("kind", voices.get(h.voiceUuid)?.kind ?? "voice")}
      {s.backup && row("backup", backupWord(s.backup))}
      {says.length > 0 && row("speaks", says.join(", "))}
      <div className="mx-0.5 my-1 h-px bg-neutral-800" />
      {characterId && onBoard(characterId) && (
        <button
          type="button"
          className={MENU_ITEM}
          onClick={() => onOpen(characterId)}
        >
          Open {nameOf(characterId)}
        </button>
      )}
      {why ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-neutral-500">
          {Icon.lock} {why}
        </div>
      ) : v.state === "in" ? (
        <div className="px-2.5 py-1 text-[12px] text-neutral-500">
          swapped at confirm
        </div>
      ) : v.outBy !== null ? (
        <>
          {outBy?.pickFor && (
            <div className="px-2.5 py-1 text-[12px] text-neutral-500">
              freed for {nameOf(outBy.pickFor)}
            </div>
          )}
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() => onKeep(v.outBy!)}
          >
            Keep it
          </button>
        </>
      ) : (
        <button
          type="button"
          className={`${MENU_ITEM} text-red-400`}
          onClick={onFree}
        >
          {Icon.out} Free this slot{s.backup === "lossy" ? " · lost" : ""}
        </button>
      )}
    </>
  );
}
