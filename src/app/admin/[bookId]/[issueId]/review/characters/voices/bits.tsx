// Small pieces the voices stop's cards share: reason lists, what an archive leaves without a voice, and the sample player.
"use client";

import { useState } from "react";
import { playSample } from "./actions";
import { BUTTON, plain, type Note, type Scope } from "./shared";
import type { ItemView, LeftWithout, SampleLine } from "./types";

export function Reasons({
  items,
  tone,
}: {
  items: string[];
  tone: "warn" | "note";
}) {
  if (items.length === 0) return null;
  return (
    <ul
      className={`space-y-0.5 ${tone === "warn" ? "text-amber-200" : "text-neutral-400"}`}
    >
      {items.map((r) => (
        <li key={r}>{plain(r)}</li>
      ))}
    </ul>
  );
}

/** The characters an archive would leave without a voice; amber, since the current pick would do it. */
export function Leaves({ leaves }: { leaves: LeftWithout[] }) {
  if (leaves.length === 0)
    return (
      <p className="text-neutral-400">
        Leaves no other character without a voice.
      </p>
    );
  return (
    <div className="text-amber-200">
      Leaves without a voice:
      <ul className="mt-1 list-disc pl-5 text-neutral-300">
        {leaves.map((l) => (
          <li key={`${l.bookId}/${l.issueId}/${l.character}`}>
            {l.character}, {l.bookId} / {l.issueId}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Play buttons for the character's first lines in its current voice (`playSample`: short test audio, not saved). */
export function Samples({
  scope,
  item,
  busy,
  setNote,
}: {
  scope: Scope;
  item: ItemView;
  busy: boolean;
  setNote: (n: Note) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  if (!item.voice || item.samples.length === 0) return null;
  const play = async (line: SampleLine) => {
    setPlaying(line.bubbleId);
    setNote({
      text: `Playing page ${line.page} in ${item.voice?.name}…`,
      tone: "plain",
    });
    let result;
    try {
      result = await playSample({
        scope,
        characterId: item.characterId,
        bubbleId: line.bubbleId,
      });
    } catch (err) {
      // The call can throw before the action runs (fetch refused, network down).
      setPlaying(null);
      setNote({
        text: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
      return;
    }
    if (!result.ok) {
      setPlaying(null);
      setNote({ text: result.error, tone: "warn" });
      return;
    }
    const audio = new Audio(`data:audio/mpeg;base64,${result.audio}`);
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    setNote(null);
    await audio.play().catch(() => setPlaying(null));
  };
  return (
    <div>
      <div className="mb-1 text-neutral-400">
        Hear {item.voice.name} on its lines here (test audio, not saved):
      </div>
      <ul className="space-y-1">
        {item.samples.map((line) => (
          <li key={line.bubbleId} className="flex items-start gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy || playing !== null}
              onClick={() => void play(line)}
            >
              {playing === line.bubbleId ? "Playing" : "Play"}
            </button>
            <span className="pt-1 text-neutral-300">
              <span className="text-neutral-500">p.{line.page}</span>{" "}
              {line.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
