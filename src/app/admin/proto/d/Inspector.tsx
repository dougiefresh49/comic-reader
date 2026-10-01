// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useState } from "react";
import { BUBBLE_TYPES, GENERIC_ROLES } from "./data";
import type { ClipData, PanelData, Problem } from "./data";

/**
 * The inspector under the lane: the current clip's text, speaker, emotion and
 * type, plus the two marks (silent, ignored) and the dismiss that clears a
 * flagged duplicate in one action.
 */
export function Inspector({
  clip,
  panels,
  panelLabel,
  cast,
  problem,
  analyzing,
  analyzed,
  onChange,
  onRetryAnalyze,
  onDismissDuplicate,
  onAddCharacter,
  onDelete,
}: {
  clip: ClipData | null;
  panels: PanelData[];
  panelLabel: string;
  cast: string[];
  problem: Problem | null;
  analyzing: string | null;
  analyzed: boolean;
  onChange: (patch: Partial<ClipData>) => void;
  onRetryAnalyze: () => void;
  onDismissDuplicate: () => void;
  onAddCharacter: (name: string) => void;
  onDelete: () => void;
}) {
  const [newCharacter, setNewCharacter] = useState("");

  if (!clip) {
    return (
      <div className="px-3 py-3 text-[11px] text-neutral-600">
        No clip under the playhead. Arrow keys walk the lane.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5">
      <label className="flex min-w-[280px] flex-1 flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Text
          {clip.isNew ? " · simulated" : ""}
          {analyzed ? " · accept or edit" : ""}
        </span>
        <textarea
          value={clip.text}
          rows={2}
          onChange={(e) => onChange({ text: e.target.value })}
          className="resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-neutral-400 focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Speaker
        </span>
        <select
          value={cast.includes(clip.speaker ?? "") ? (clip.speaker ?? "") : ""}
          onChange={(e) =>
            onChange({ speaker: e.target.value === "" ? null : e.target.value })
          }
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-neutral-400 focus:outline-none"
        >
          <option value="">— none —</option>
          {clip.speaker &&
            !cast.includes(clip.speaker) &&
            !GENERIC_ROLES.includes(clip.speaker) && (
              <option value="">{clip.speaker} (off the list)</option>
            )}
          <optgroup label="Detected characters">
            {cast
              .filter((c) => !GENERIC_ROLES.includes(c))
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </optgroup>
          <optgroup label="Generic roles">
            {GENERIC_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="flex w-36 flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Emotion
        </span>
        <input
          value={clip.emotion}
          onChange={(e) => onChange({ emotion: e.target.value })}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-neutral-400 focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Type
        </span>
        <select
          value={clip.type}
          onChange={(e) => onChange({ type: e.target.value })}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-neutral-400 focus:outline-none"
        >
          {BUBBLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Marks
        </span>
        <div className="flex items-center gap-1.5">
          <Toggle
            label="silent"
            on={clip.silent}
            onClick={() => onChange({ silent: !clip.silent })}
          />
          <Toggle
            label="ignored"
            on={clip.ignored}
            onClick={() => onChange({ ignored: !clip.ignored })}
          />
          <span className="text-[10px] text-neutral-600">
            panel {panelLabel}
          </span>
          <select
            value={clip.panelId ?? ""}
            onChange={(e) => onChange({ panelId: e.target.value || null })}
            aria-label="Move to panel"
            className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-300 focus:border-neutral-400 focus:outline-none"
          >
            <option value="">—</option>
            {panels.map((p, i) => (
              <option key={p.id} value={p.id}>
                {i + 1}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onDelete}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-500 hover:border-red-800 hover:text-red-400"
          >
            delete
          </button>
        </div>
      </div>

      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          {analyzing
            ? "Analyze — simulated, running"
            : problem
              ? `Needs you — ${problem.label}`
              : "Needs you — nothing"}
        </span>
        {analyzing ? (
          <span className="text-[11px] text-sky-400">
            filling plausible values…
          </span>
        ) : problem?.kind === "duplicate" ? (
          <button
            type="button"
            onClick={onDismissDuplicate}
            className="self-start rounded border border-amber-600 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-950"
          >
            Dismiss duplicate
          </button>
        ) : clip.isNew && (analyzing || analyzed) ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-neutral-500">
              {analyzed ? "accepted as-is" : "fill ready"}
            </span>
            <button
              type="button"
              onClick={onRetryAnalyze}
              className="self-start rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
            >
              Retry
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-neutral-700">—</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] tracking-wider text-neutral-500 uppercase">
          Add character
        </span>
        <div className="flex items-center gap-1">
          <input
            value={newCharacter}
            placeholder="new name"
            onChange={(e) => setNewCharacter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newCharacter.trim()) {
                onAddCharacter(newCharacter.trim());
                onChange({ speaker: newCharacter.trim() });
                setNewCharacter("");
              }
            }}
            className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-neutral-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={!newCharacter.trim()}
            onClick={() => {
              onAddCharacter(newCharacter.trim());
              onChange({ speaker: newCharacter.trim() });
              setNewCharacter("");
            }}
            className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] ${
        on
          ? "border-neutral-500 bg-neutral-800 text-neutral-100"
          : "border-neutral-700 text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}
