// The move dialog (#745): one face, or a selection, to another character of this issue, one the book knows, or a new one.
"use client";

import { useId, useMemo, useState } from "react";
import { slugify } from "~/lib/character-id";
import type { NameTarget } from "./actions";
import {
  BUTTON,
  DialogFrame,
  FaceCrop,
  INPUT,
  PRIMARY,
  bestFace,
  isExactName,
  matchesName,
} from "./shared";
import type {
  CharacterCard,
  FaceView,
  KnownCharacter,
  PageView,
} from "./types";

/** One tile of the grid: a character of this issue, one the book knows but this issue does not, or the typed name as a new character. */
interface Choice {
  key: string;
  name: string;
  target: NameTarget;
  /** The portrait, for a character of this issue with faces. */
  face: FaceView | null;
  note: "not in this issue" | "new" | null;
}

/**
 * "Move {the page N face | N faces} of {name} to…": a search box over a grid
 * of portraits, one tile picked at a time, and a primary button naming the
 * pick. The search uses the name picker's matching (id, name, alias, slug)
 * and reaches the characters the book knows but this issue does not; a name
 * that matches nothing is offered as a new character. Escape is the panel's
 * (it closes this first); Enter with a pick is Move.
 */
export function MoveDialog({
  card,
  faces,
  cards,
  known,
  pages,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The open card: the faces come from it, so it is not a target. */
  card: CharacterCard;
  faces: FaceView[];
  cards: CharacterCard[];
  known: KnownCharacter[];
  pages: Map<number, PageView>;
  busy: boolean;
  onConfirm: (target: NameTarget, name: string) => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const q = slugify(query);

  const choices = useMemo<Choice[]>(() => {
    const byId = new Map(known.map((k) => [k.id, k]));
    const here = cards.filter((c) => c.id !== card.id && c.group !== "role");
    const hereIds = new Set(here.map((c) => c.id));
    const asKnown = (c: CharacterCard): KnownCharacter =>
      byId.get(c.id) ?? { id: c.id, name: c.name, aliases: [] };
    const inIssue: Choice[] = here
      .filter((c) => !q || matchesName(asKnown(c), q))
      .map((c) => ({
        key: `existing:${c.id}`,
        name: c.name,
        target: { kind: "existing", id: c.id },
        face: bestFace(c.faces, pages),
        note: null,
      }));
    const elsewhere: Choice[] = q
      ? known
          .filter((k) => !hereIds.has(k.id) && k.id !== card.id)
          .filter((k) => matchesName(k, q))
          .map((k) => ({
            key: `existing:${k.id}`,
            name: k.name,
            target: { kind: "existing", id: k.id },
            face: null,
            note: "not in this issue",
          }))
      : [];
    const exact =
      here.some((c) => isExactName(asKnown(c), q)) ||
      known.some((k) => isExactName(k, q));
    const fresh: Choice[] =
      q && !exact
        ? [
            {
              key: "new",
              name: query.trim(),
              target: { kind: "new", name: query.trim() },
              face: null,
              note: "new",
            },
          ]
        : [];
    return [...inIssue, ...elsewhere, ...fresh];
  }, [cards, known, pages, card.id, q, query]);

  const picked = choices.find((c) => c.key === pickedKey) ?? null;
  const confirm = () => picked && onConfirm(picked.target, picked.name);
  const what =
    faces.length === 1
      ? `the page ${faces[0]!.page} face`
      : `${faces.length} faces`;

  return (
    <DialogFrame
      labelledBy={headingId}
      className="flex max-h-[80vh] w-[640px] flex-col gap-3"
      onCancel={onCancel}
    >
      <h2 id={headingId} className="text-[16px] font-medium text-neutral-100">
        Move {what} of {card.name} to…
      </h2>
      <input
        value={query}
        autoFocus
        placeholder="Search by name, alias or id"
        aria-label="Search characters"
        onChange={(e) => {
          setQuery(e.target.value);
          setPickedKey(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirm();
          }
        }}
        className={INPUT}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {choices.length === 0 ? (
          <p className="py-6 text-center text-neutral-500">
            No character matches.
          </p>
        ) : (
          <div
            role="listbox"
            aria-label="Move to"
            className="grid grid-cols-5 gap-3"
          >
            {choices.map((c) => {
              const selected = c.key === pickedKey;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => setPickedKey(c.key)}
                  className={`flex flex-col gap-1.5 rounded-md border p-1.5 text-left ${
                    selected
                      ? "border-white bg-neutral-800 ring-2 ring-white/80"
                      : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/60"
                  }`}
                >
                  {c.note === "new" ? (
                    <span
                      aria-hidden
                      className="flex aspect-square w-full items-center justify-center rounded-sm bg-emerald-400/10 text-[28px] text-emerald-200"
                    >
                      +
                    </span>
                  ) : (
                    <FaceCrop
                      face={c.face}
                      pages={pages}
                      alt={c.name}
                      className="w-full rounded-sm"
                    />
                  )}
                  <span className="min-w-0 leading-4">
                    <span
                      className={`block truncate ${
                        c.note === "new"
                          ? "text-emerald-200"
                          : "text-neutral-100"
                      }`}
                      title={c.name}
                    >
                      {c.note === "new" ? `New character "${c.name}"` : c.name}
                    </span>
                    {c.note === "not in this issue" && (
                      <span className="block truncate text-[12px] text-neutral-500">
                        not in this issue
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !picked}
          onClick={confirm}
          className={PRIMARY}
        >
          {picked ? `Move to ${picked.name}` : "Move to…"}
        </button>
      </div>
    </DialogFrame>
  );
}
