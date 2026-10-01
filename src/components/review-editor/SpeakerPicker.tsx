// The closed speaker list: faces found in this panel first, then the cast, then the three roles.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { matchKnown, slug, tintFor, titleCase } from "./lib";
import type { VoiceChoice } from "./model";
import { PageCrop } from "./PageCrop";
import type { CastMember, KnownCharacter, SrcPage, VoiceOption } from "./types";

/** `knownId` is the `characters` row the typed name matched, when it matched one. */
export type AddCharacter = (
  name: string,
  voice: VoiceChoice,
  knownId: string | null,
) => void;

interface SpeakerPickerProps {
  cast: CastMember[];
  /** Every `characters` row, for matching a typed name to its voice. */
  known: KnownCharacter[];
  /** Cast ids of the faces detected in the bubble's panel, nearest first. */
  nearby: string[];
  current: string | null;
  pages: Map<number, SrcPage>;
  voices: VoiceOption[];
  slotsUsed: number;
  slotsTotal: number;
  /** New voices already promised by the pending edits. */
  newVoices: number;
  /** Open straight on the add form with this name. */
  addName: string | null;
  onPick: (castId: string) => void;
  onAdd: AddCharacter;
  onClose: () => void;
}

interface Item {
  member: CastMember;
  group: string;
}

export function Portrait({
  member,
  pages,
  className,
}: {
  member: CastMember;
  pages: Map<number, SrcPage>;
  className: string;
}) {
  const page = member.portrait ? pages.get(member.portrait.page) : undefined;
  if (!member.portrait || !page) {
    return (
      <span
        className={`flex items-center justify-center bg-neutral-800 text-[10px] text-neutral-400 ${className}`}
      >
        {member.name.charAt(0)}
      </span>
    );
  }
  return (
    <PageCrop
      url={page.imageUrl}
      rect={member.portrait.rect}
      pageAspect={page.width / page.height}
      boxAspect={1}
      mode="cover"
      pad={0}
      alt=""
      className={`bg-neutral-800 ${className}`}
    />
  );
}

type VoiceMode = "own" | "other" | "new";

function AddCharacterForm({
  initialName,
  voices,
  known,
  slotsUsed,
  slotsTotal,
  newVoices,
  onAdd,
  onCancel,
}: {
  initialName: string;
  voices: VoiceOption[];
  known: KnownCharacter[];
  slotsUsed: number;
  slotsTotal: number;
  newVoices: number;
  onAdd: AddCharacter;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [picked, setPicked] = useState<VoiceMode | null>(null);
  const [voice, setVoice] = useState(voices[0]?.name ?? "");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // A typed name that is a known character with an active voice takes that
  // voice. It is the character's own, so nothing here calls it borrowing.
  const match = matchKnown(name, known);
  const own =
    match?.voice ??
    voices.find((v) => slug(v.name) === slug(name))?.name ??
    null;
  const slotsLeft = slotsTotal - slotsUsed - newVoices;
  const fallback: VoiceMode = slotsLeft <= 0 ? "other" : "new";
  const mode: VoiceMode = own
    ? (picked ?? "own")
    : picked === null || picked === "own"
      ? fallback
      : picked;

  // The second choice is every voice but the character's own.
  const others = voices.filter((v) => v.name !== own);
  const other = others.some((v) => v.name === voice)
    ? voice
    : (others[0]?.name ?? "");

  const valid =
    name.trim().length > 0 &&
    (mode === "new" ? slotsLeft > 0 : mode === "own" || other.length > 0);
  const submit = () => {
    if (!valid) return;
    onAdd(
      name.trim(),
      mode === "own" && own
        ? { kind: "own", voice: own }
        : mode === "new"
          ? { kind: "new" }
          : { kind: "borrow", voice: other },
      match?.id ?? null,
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="space-y-2 rounded border border-neutral-700 bg-neutral-900 p-2"
    >
      <div className="text-[11px] font-medium text-neutral-300">
        Add a character to the cast
      </div>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Character name"
        className="h-7 w-full rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-[12px] text-neutral-100 outline-none focus:border-neutral-400"
      />
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[11px] text-neutral-500">Voice</legend>
        {own && (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="voice-mode"
              checked={mode === "own"}
              onChange={() => setPicked("own")}
              className="accent-neutral-200"
            />
            <span className="min-w-0 truncate">
              {own}
              <span className="text-neutral-500">
                , {match?.name ?? name.trim()}&apos;s voice
              </span>
            </span>
          </label>
        )}
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="voice-mode"
            checked={mode === "other"}
            onChange={() => setPicked("other")}
            className="accent-neutral-200"
          />
          <span className="shrink-0">{own ? "Another voice" : "Borrow"}</span>
          <select
            value={other}
            onChange={(e) => {
              setVoice(e.target.value);
              setPicked("other");
            }}
            aria-label={own ? "Another voice" : "Voice to borrow"}
            className="h-6 min-w-0 flex-1 rounded-sm border border-neutral-700 bg-neutral-950 px-1 text-[12px] text-neutral-100"
          >
            {others.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label
          className={`flex items-center gap-2 ${
            slotsLeft <= 0 ? "text-neutral-600" : ""
          }`}
        >
          <input
            type="radio"
            name="voice-mode"
            checked={mode === "new"}
            disabled={slotsLeft <= 0}
            onChange={() => setPicked("new")}
            className="accent-neutral-200"
          />
          <span>New voice, made in a later step</span>
        </label>
        <p
          className={`pl-5 text-[11px] ${
            slotsLeft <= 1 ? "text-amber-300" : "text-neutral-500"
          }`}
        >
          {slotsUsed + newVoices} of {slotsTotal} voice slots used.{" "}
          {slotsLeft <= 0
            ? own
              ? "None left for a new voice."
              : "None left: borrow a voice."
            : slotsLeft === 1
              ? "A new voice takes the last one."
              : `${slotsLeft} left.`}
        </p>
      </fieldset>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="h-6 rounded-sm bg-neutral-100 px-2 text-[12px] font-medium text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          Add to cast
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 rounded-sm px-2 text-[12px] text-neutral-400 hover:text-neutral-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SpeakerPicker({
  cast,
  known,
  nearby,
  current,
  pages,
  voices,
  slotsUsed,
  slotsTotal,
  newVoices,
  addName,
  onPick,
  onAdd,
  onClose,
}: SpeakerPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(addName);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (adding === null) inputRef.current?.focus();
  }, [adding]);

  const items = useMemo<Item[]>(() => {
    const q = slug(query);
    const match = (c: CastMember) =>
      !q ||
      slug(c.name).includes(q) ||
      c.aliases.some((a) => slug(a).includes(q));
    const byId = new Map(cast.map((c) => [c.id, c]));
    const near = nearby.flatMap((id) => byId.get(id) ?? []).filter(match);
    const nearIds = new Set(near.map((c) => c.id));
    return [
      ...near.map((member) => ({ member, group: "In this panel" })),
      ...cast
        .filter((c) => c.kind === "character" && !nearIds.has(c.id) && match(c))
        .map((member) => ({ member, group: "Cast" })),
      ...cast
        .filter((c) => c.kind === "role" && match(c))
        .map((member) => ({ member, group: "Roles" })),
    ];
  }, [cast, nearby, query]);

  const exact = cast.some((c) => slug(c.name) === slug(query));
  const canAdd = query.trim().length > 0 && !exact;
  const count = items.length + 1; // the last row is always "add a character"
  const index = Math.min(active, count - 1);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (adding !== null) {
    return (
      <AddCharacterForm
        initialName={adding}
        voices={voices}
        known={known}
        slotsUsed={slotsUsed}
        slotsTotal={slotsTotal}
        newVoices={newVoices}
        onAdd={onAdd}
        onCancel={() => (addName !== null ? onClose() : setAdding(null))}
      />
    );
  }

  const choose = (i: number) => {
    const item = items[i];
    if (item) onPick(item.member.id);
    else setAdding(canAdd ? titleCase(query.trim()) : "");
  };

  return (
    <div className="rounded border border-neutral-700 bg-neutral-900">
      <input
        ref={inputRef}
        value={query}
        placeholder="Type a name"
        aria-label="Search the cast"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((index + 1) % count);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((index - 1 + count) % count);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(index);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className="h-7 w-full border-b border-neutral-800 bg-transparent px-2 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600"
      />
      <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto">
        {items.map((item, i) => {
          const first = i === 0 || items[i - 1]?.group !== item.group;
          const tint = tintFor(item.member);
          return (
            <div key={`${item.group}-${item.member.id}`}>
              {first && (
                <div className="px-2 pt-1.5 pb-0.5 text-[10px] tracking-wide text-neutral-500 uppercase">
                  {item.group}
                </div>
              )}
              <div
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={`flex h-7 cursor-default items-center gap-2 px-2 ${
                  i === index ? "bg-neutral-700/70 text-white" : ""
                }`}
              >
                <Portrait
                  member={item.member}
                  pages={pages}
                  className="size-5 shrink-0 rounded-sm"
                />
                <span className={`min-w-0 flex-1 truncate ${tint.text}`}>
                  {item.member.name}
                </span>
                {item.member.id === current && (
                  <span className="text-[10px] text-neutral-500">current</span>
                )}
                <span className="max-w-[84px] truncate text-[11px] text-neutral-500">
                  {item.member.voice ?? "no voice yet"}
                </span>
              </div>
            </div>
          );
        })}
        <div
          role="option"
          aria-selected={index === items.length}
          data-index={items.length}
          onMouseEnter={() => setActive(items.length)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(items.length)}
          className={`flex h-7 cursor-default items-center gap-2 border-t border-neutral-800 px-2 text-neutral-300 ${
            index === items.length ? "bg-neutral-700/70 text-white" : ""
          }`}
        >
          {canAdd
            ? `Add "${titleCase(query.trim())}" as a new character`
            : "Add a character"}
        </div>
      </div>
    </div>
  );
}
