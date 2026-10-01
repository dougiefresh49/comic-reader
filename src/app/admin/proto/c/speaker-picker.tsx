// THROWAWAY prototype for issue #325.
"use client";
import { useState } from "react";

export function SpeakerPicker({
  value,
  cast,
  onPick,
  onAdd,
  label,
}: {
  value: string;
  cast: string[];
  onPick: (value: string) => void;
  onAdd: (name: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [index, setIndex] = useState(0);
  const matches = cast.filter((name) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );
  const canAdd =
    !!search.trim() &&
    !cast.some((name) => name.toLowerCase() === search.trim().toLowerCase());
  const choices = [
    ...matches,
    ...(canAdd ? [`Add character "${search.trim()}"`] : []),
  ];
  function choose(i: number) {
    if (i >= matches.length && canAdd) onAdd(search.trim());
    else if (matches[i]) onPick(matches[i]);
    setOpen(false);
  }
  return (
    <div className="relative w-60 max-w-full">
      <input
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${label.replaceAll(" ", "-")}-choices`}
        className={`w-full border-b bg-transparent px-1 py-1 font-mono text-sm uppercase outline-none focus:border-sky-400 ${value && cast.includes(value) ? "border-transparent text-neutral-100" : "border-amber-600 text-amber-300"}`}
        value={open ? search : value}
        placeholder="Assign speaker"
        onFocus={() => {
          setSearch("");
          setIndex(0);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setSearch(e.target.value);
          setIndex(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setIndex((i) =>
              Math.max(
                0,
                Math.min(
                  choices.length - 1,
                  i + (e.key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            choose(index);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            e.currentTarget.blur();
          }
          if (e.key === "Tab") setOpen(false);
        }}
      />
      {open && (
        <div
          id={`${label.replaceAll(" ", "-")}-choices`}
          role="listbox"
          className="absolute top-full left-0 z-40 max-h-64 min-w-full overflow-auto border border-neutral-600 bg-neutral-900 shadow-xl"
        >
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick("");
              setOpen(false);
            }}
            className="block w-full px-3 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Clear speaker
          </button>
          {choices.map((choice, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === index}
              key={choice}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              className={`block w-full px-3 py-2 text-left text-xs ${i === index ? "bg-neutral-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
            >
              {choice}
            </button>
          ))}
          {!choices.length && (
            <p className="px-3 py-2 text-xs text-neutral-400">
              Type a name to add a character.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
