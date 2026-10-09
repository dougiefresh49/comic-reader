// The closed speaker list: faces found in this panel first, then the cast, then the three roles.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  findCast,
  matchKnown,
  ownVoice,
  slug,
  tintFor,
  titleCase,
  voiceLabel,
} from "./lib";
import { PageCrop } from "./PageCrop";
import type { CastMember, KnownCharacter, SrcPage, VoiceOption } from "./types";

/** `knownId` is the `characters` row the typed name matched, when it matched one. */
export type AddCharacter = (name: string, knownId: string | null) => void;

interface SpeakerPickerProps {
  cast: CastMember[];
  /** Every `characters` row, for matching a typed name to its voice. */
  known: KnownCharacter[];
  /** Cast ids of the faces detected in the bubble's panel, nearest first. */
  nearby: string[];
  current: string | null;
  pages: Map<number, SrcPage>;
  /** Active voices, to name the voice a known character starts with. */
  voices: VoiceOption[];
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

/**
 * Adds a character to the cast, held until Save (#416). The voice is the one
 * the Characters screen would give it: a known character's own, else none.
 */
function AddCharacterForm({
  initialName,
  cast,
  voices,
  known,
  onPick,
  onAdd,
  onCancel,
}: {
  initialName: string;
  cast: CastMember[];
  voices: VoiceOption[];
  known: KnownCharacter[];
  onPick: (castId: string) => void;
  onAdd: AddCharacter;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // A name that is already in the cast is picked, never added a second time.
  const existing = findCast(name, cast);
  const match = matchKnown(name, known);
  const own = ownVoice(name, known, voices);
  const valid = slug(name).length > 0;
  const submit = () => {
    if (!valid) return;
    if (existing) {
      onPick(existing.id);
      return;
    }
    onAdd(name.trim(), match?.id ?? null);
  };

  return (
    <form
      data-popover
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
      {existing ? (
        <p className="text-[11px] text-neutral-400">
          {existing.name} is already in the cast.
        </p>
      ) : (
        valid && (
          <p className="text-[11px] text-neutral-500">
            {match ? match.name : "A new character"}
            {own ? `, with the voice ${own.name}` : ", with no voice yet"}.
            Joins the cast when you save.
          </p>
        )
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!valid}
          className="h-6 rounded-sm bg-neutral-100 px-2 text-[12px] font-medium text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {existing ? `Use ${existing.name}` : "Add to cast"}
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
  addName,
  onPick,
  onAdd,
  onClose,
}: SpeakerPickerProps) {
  const [query, setQuery] = useState("");
  /** The highlighted row, or null for the default the list picks itself. */
  const [active, setActive] = useState<number | null>(null);
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

  const typed = query.trim();
  const canAdd = typed.length > 0 && !findCast(typed, cast);
  // A name the `characters` table knows is added under that name, and is not new.
  const knownName = canAdd ? matchKnown(typed, known)?.name : undefined;
  const count = items.length + 1; // the last row is always "add a character"
  // With nothing typed, only a face in this panel is offered for Enter. No
  // face means no highlight, so Enter cannot take the first name by accident.
  const byDefault =
    typed.length > 0 || items[0]?.group === "In this panel" ? 0 : -1;
  const index = Math.min(active ?? byDefault, count - 1);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (adding !== null) {
    return (
      <AddCharacterForm
        initialName={adding}
        cast={cast}
        voices={voices}
        known={known}
        onPick={onPick}
        onAdd={onAdd}
        onCancel={() => (addName !== null ? onClose() : setAdding(null))}
      />
    );
  }

  const choose = (i: number) => {
    const item = items[i];
    if (item) onPick(item.member.id);
    else setAdding(canAdd ? (knownName ?? titleCase(typed)) : "");
  };

  return (
    <div
      data-popover
      className="rounded border border-neutral-700 bg-neutral-900"
    >
      <input
        ref={inputRef}
        value={query}
        placeholder="Type a name"
        aria-label="Search the cast"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((index + 1) % count);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((index <= 0 ? count : index) - 1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (index >= 0) choose(index);
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
                  {voiceLabel(item.member) ?? "no voice yet"}
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
          {!canAdd
            ? "Add a character"
            : knownName
              ? `Add ${knownName} to the cast`
              : `Add "${titleCase(typed)}" as a new character`}
        </div>
      </div>
    </div>
  );
}
