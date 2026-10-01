// THROWAWAY spike for issue #325 (review editor variant B). The bubble's fields and the closed speaker picker.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { inCast, normName, speakerName, type CastIndex } from "./logic";
import {
  BUBBLE_TYPES,
  type BubbleType,
  type CastMember,
  type Offer,
  type ProtoBubble,
  type ProtoPanel,
} from "./types";

const EMOTIONS = [
  "neutral",
  "excited",
  "angry",
  "afraid",
  "sad",
  "confident",
  "surprised",
  "teasing",
  "worried",
  "determined",
];

export interface AnalyzeState {
  status: "waiting" | "running" | "offered" | "taken";
  attempt: number;
  offer?: Offer;
}

interface FieldsProps {
  bubble: ProtoBubble;
  cast: CastIndex;
  shortlist: CastMember[];
  panels: ProtoPanel[];
  panelId: string | null;
  analyze?: AnalyzeState;
  onPatch: (
    patch: Partial<ProtoBubble>,
    label: string,
    coalesce?: string,
  ) => void;
  onSpeaker: (id: string) => void;
  onAddCharacter: (name: string) => void;
  onMovePanel: (panelId: string) => void;
  onTakeOffer: () => void;
  onRetryOffer: () => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
}

export function Fields({
  bubble,
  cast,
  shortlist,
  panels,
  panelId,
  analyze,
  onPatch,
  onSpeaker,
  onAddCharacter,
  onMovePanel,
  onTakeOffer,
  onRetryOffer,
  pickerOpen,
  setPickerOpen,
}: FieldsProps) {
  const known = inCast(cast, bubble.speaker);
  return (
    <div className="flex flex-col gap-3 text-xs">
      {analyze && analyze.status !== "taken" && (
        <div className="rounded border border-cyan-900 bg-neutral-900 p-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-cyan-300">
            <span>Analyze (simulated, no model was called)</span>
            {analyze.attempt > 0 && (
              <span className="text-neutral-500">
                try {analyze.attempt + 1}
              </span>
            )}
          </div>
          {analyze.status === "waiting" && (
            <p className="text-neutral-400">
              Runs when the box has been still for a second.
            </p>
          )}
          {analyze.status === "running" && (
            <p className="text-neutral-400">Reading the box...</p>
          )}
          {analyze.status === "offered" && analyze.offer && (
            <>
              <dl className="grid grid-cols-[60px_1fr] gap-x-2 gap-y-0.5">
                <dt className="text-neutral-500">Text</dt>
                <dd className="whitespace-pre-wrap text-neutral-100">
                  {analyze.offer.text}
                </dd>
                <dt className="text-neutral-500">Speaker</dt>
                <dd className="text-neutral-100">
                  {speakerName(cast, analyze.offer.speaker)}
                </dd>
                <dt className="text-neutral-500">Emotion</dt>
                <dd className="text-neutral-100">{analyze.offer.emotion}</dd>
              </dl>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={onTakeOffer}
                  className="rounded bg-cyan-800 px-2 py-1 text-white hover:bg-cyan-700"
                >
                  Accept values (Y)
                </button>
                <button
                  type="button"
                  onClick={onRetryOffer}
                  className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                >
                  Try again (R)
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <section>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-neutral-500">Speaker</span>
          <span
            className={
              bubble.speaker
                ? known
                  ? "text-neutral-100"
                  : "text-amber-300"
                : "text-red-300"
            }
          >
            {bubble.silent
              ? "silent"
              : bubble.speaker
                ? `${speakerName(cast, bubble.speaker)}${known ? "" : " (not in cast)"}`
                : "none"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-0.5">
          {shortlist.map((c, i) => {
            const active =
              !!bubble.speaker &&
              normName(bubble.speaker) !== "" &&
              cast.byNorm.get(normName(bubble.speaker))?.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSpeaker(c.id)}
                className={`flex items-center gap-2 rounded px-1.5 py-0.5 text-left ${
                  active
                    ? "bg-cyan-900/60 text-white"
                    : "text-neutral-300 hover:bg-neutral-800"
                }`}
              >
                <kbd className="w-4 text-center text-neutral-500">{i + 1}</kbd>
                <span className="flex-1">{c.name}</span>
                {c.kind !== "cast" && (
                  <span className="text-[10px] text-neutral-500">{c.kind}</span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 rounded px-1.5 py-0.5 text-left text-neutral-400 hover:bg-neutral-800"
          >
            <kbd className="w-4 text-center text-neutral-500">/</kbd>
            <span>All characters, or add one</span>
          </button>
        </div>
        {pickerOpen && (
          <SpeakerPicker
            cast={cast}
            onPick={(id) => {
              onSpeaker(id);
              setPickerOpen(false);
            }}
            onAdd={(name) => {
              onAddCharacter(name);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </section>

      <section className="grid grid-cols-[60px_1fr] items-center gap-x-2 gap-y-1.5">
        <label htmlFor="pb-type" className="text-neutral-500">
          Type <kbd className="text-neutral-600">T</kbd>
        </label>
        <select
          id="pb-type"
          value={bubble.type}
          onChange={(e) =>
            onPatch({ type: e.target.value as BubbleType }, "Change type")
          }
          className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
        >
          {BUBBLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.toLowerCase()}
            </option>
          ))}
        </select>

        <label htmlFor="pb-emotion" className="text-neutral-500">
          Emotion <kbd className="text-neutral-600">M</kbd>
        </label>
        <input
          id="pb-emotion"
          list="pb-emotions"
          value={bubble.emotion}
          onChange={(e) =>
            onPatch(
              { emotion: e.target.value },
              "Edit emotion",
              `emotion:${bubble.id}`,
            )
          }
          className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 focus:border-cyan-500 focus:outline-none"
        />
        <datalist id="pb-emotions">
          {EMOTIONS.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>

        <label htmlFor="pb-panel" className="text-neutral-500">
          Panel
        </label>
        <select
          id="pb-panel"
          value={panelId ?? ""}
          onChange={(e) => onMovePanel(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
        >
          {!panelId && <option value="">none</option>}
          {panels.map((p) => (
            <option key={p.id} value={p.id}>
              Panel {p.order + 1}
            </option>
          ))}
        </select>
      </section>

      <section>
        <label htmlFor="pb-text" className="mb-1 block text-neutral-500">
          Text <kbd className="text-neutral-600">E</kbd>
        </label>
        <textarea
          id="pb-text"
          value={bubble.text}
          rows={4}
          onChange={(e) =>
            onPatch({ text: e.target.value }, "Edit text", `text:${bubble.id}`)
          }
          className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 font-mono text-[11px] leading-snug focus:border-cyan-500 focus:outline-none"
        />
      </section>

      <section className="flex gap-4">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={bubble.silent}
            onChange={(e) =>
              onPatch(
                { silent: e.target.checked },
                e.target.checked ? "Mark silent" : "Unmark silent",
              )
            }
          />
          Silent <kbd className="text-neutral-600">S</kbd>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={bubble.ignored}
            onChange={(e) =>
              onPatch(
                { ignored: e.target.checked },
                e.target.checked ? "Ignore" : "Unignore",
              )
            }
          />
          Ignored <kbd className="text-neutral-600">X</kbd>
        </label>
      </section>
    </div>
  );
}

function SpeakerPicker({
  cast,
  onPick,
  onAdd,
  onClose,
}: {
  cast: CastIndex;
  onPick: (id: string) => void;
  onAdd: (name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const matches = useMemo(() => {
    const n = normName(q);
    return cast.all.filter(
      (c) =>
        !n ||
        normName(c.name).includes(n) ||
        normName(c.id).includes(n) ||
        c.aliases.some((a) => normName(a).includes(n)),
    );
  }, [cast, q]);
  const exact = cast.byNorm.has(normName(q));
  const options: { key: string; label: string; run: () => void }[] = [
    ...matches.map((c) => ({
      key: c.id,
      label: `${c.name}${c.kind === "cast" ? "" : ` (${c.kind})`}`,
      run: () => onPick(c.id),
    })),
    ...(q.trim() && !exact
      ? [
          {
            key: "__add",
            label: `Add new character "${q.trim()}"`,
            run: () => onAdd(q.trim()),
          },
        ]
      : []),
  ];

  return (
    <div className="mt-2 rounded border border-neutral-700 bg-neutral-900 p-1.5">
      <input
        ref={input}
        value={q}
        placeholder="Type a name"
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            options[hi]?.run();
          }
        }}
        className="mb-1 w-full rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 focus:border-cyan-500 focus:outline-none"
      />
      <ul className="max-h-48 overflow-y-auto">
        {options.map((o, i) => (
          <li key={o.key}>
            <button
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={o.run}
              className={`w-full rounded px-1.5 py-0.5 text-left ${
                i === hi ? "bg-neutral-700 text-white" : "text-neutral-300"
              } ${o.key === "__add" ? "text-cyan-300" : ""}`}
            >
              {o.label}
            </button>
          </li>
        ))}
        {options.length === 0 && (
          <li className="px-1.5 py-0.5 text-neutral-500">No match</li>
        )}
      </ul>
      <div className="mt-1 text-[10px] text-neutral-500">
        Enter picks, Esc closes
      </div>
    </div>
  );
}
