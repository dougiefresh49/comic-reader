"use client";

import { Chip, FIELD, btn } from "../ui";
import {
  setFranchiseEntry,
  type FlowFranchise,
  type FranchiseEntry,
} from "../model";

const characters = (n: number) =>
  `${n} ${n === 1 ? "character" : "characters"}`;

/** `Name · N characters`, the way every franchise option reads. */
const optionLabel = (r: FlowFranchise) =>
  `${r.name} · ${characters(r.characters)}`;

const entryKey = (e: FranchiseEntry) =>
  "id" in e
    ? `id:${e.id}`
    : "newName" in e
      ? `new:${e.newName}`
      : `suggested:${e.suggested}`;

/**
 * The new book's franchises (#858), in order; the first pick is the default
 * for characters made in this book. A search name that matched no saved
 * franchise waits as a suggestion until it is pointed at one, made new on
 * purpose, or dropped.
 */
export function FranchisePicker({
  rows,
  entries,
  update,
}: {
  rows: FlowFranchise[];
  entries: FranchiseEntry[];
  update: (change: (entries: FranchiseEntry[]) => FranchiseEntry[]) => void;
}) {
  const set = (index: number, entry: FranchiseEntry | null) =>
    update((list) => setFranchiseEntry(list, index, entry));
  const picked = new Set(entries.flatMap((e) => ("id" in e ? [e.id] : [])));
  const unpicked = rows.filter((r) => !picked.has(r.id));
  const firstPick = entries.findIndex((e) => !("suggested" in e));

  return (
    <div className="flex flex-col gap-1.5">
      {entries.length === 0 && <span className="text-neutral-500">None</span>}
      {entries.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e, i) => {
            if ("suggested" in e) {
              return (
                <li
                  key={entryKey(e)}
                  className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#4a3f14] bg-[#2e2108] px-2.5 py-1.5"
                >
                  <span className="text-amber-400">“{e.suggested}”</span>
                  <span className="text-xs text-neutral-400">
                    is not a saved franchise
                  </span>
                  <span className="basis-full" />
                  <select
                    value=""
                    onChange={(ev) => set(i, { id: ev.target.value })}
                    aria-label={`Saved franchise for ${e.suggested}`}
                    className={`${FIELD} max-w-full`}
                  >
                    <option value="" disabled>
                      Same as…
                    </option>
                    {rows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {optionLabel(r)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => set(i, { newName: e.suggested })}
                    className={btn("default", "sm")}
                  >
                    Create new “{e.suggested}”
                  </button>
                  <button
                    type="button"
                    onClick={() => set(i, null)}
                    className={btn("ghost", "sm")}
                  >
                    Drop
                  </button>
                </li>
              );
            }
            const row = "id" in e ? rows.find((r) => r.id === e.id) : null;
            const name = "id" in e ? (row?.name ?? e.id) : e.newName;
            return (
              <li key={entryKey(e)} className="flex items-center gap-1.5">
                <span>{name}</span>
                {row && (
                  <span className="text-xs text-neutral-500">
                    · {characters(row.characters)}
                  </span>
                )}
                {"newName" in e && <Chip tone="ok">new</Chip>}
                {i === firstPick && <Chip tone="none">default</Chip>}
                <button
                  type="button"
                  onClick={() => set(i, null)}
                  aria-label={`Remove ${name}`}
                  className={btn("ghost", "sm")}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {unpicked.length > 0 && (
        <select
          value=""
          onChange={(ev) => {
            const id = ev.target.value;
            update((list) => [...list, { id }]);
          }}
          aria-label="Add franchise"
          className={`${FIELD} max-w-full self-start`}
        >
          <option value="" disabled>
            Add franchise…
          </option>
          {unpicked.map((r) => (
            <option key={r.id} value={r.id}>
              {optionLabel(r)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
