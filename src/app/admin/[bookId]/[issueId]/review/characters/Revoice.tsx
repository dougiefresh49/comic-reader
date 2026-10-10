// Re-voice (#836): a character whose bubbles still play a voice it no longer
// has gets this box on the Voice tab. It shows the lines per issue and the
// credits before anything runs, and renders only after Confirm, one line (or
// joined group) at a time through the review editor's Regenerate.
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { revoiceUnit } from "./revoice-actions";
import type { RevoicePlan } from "./types";
import { BTN, BTN_GHOST, BTN_PRIMARY, LABEL } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "running"; done: number; lines: number }
  | { kind: "stopped"; finished: boolean; lines: number; error: string | null };

const lines = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
const credits = (n: number) => `≈${n.toLocaleString()} credits`;

export function Revoice({
  bookId,
  plan: current,
  voiceName,
}: {
  bookId: string;
  /** The page's plan; null when the character has no old-voice audio. */
  plan: RevoicePlan | null;
  /** The voice the lines will be rendered in now. */
  voiceName: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Each render revalidates the reader page, and the action's answer brings
  // a fresh casting page, so the page's plan shrinks as the run goes. The
  // box shows the plan it confirmed until the run ends, and stays to say so.
  const [confirmed, setConfirmed] = useState<RevoicePlan | null>(null);
  const stop = useRef(false);
  const plan = confirmed ?? current;
  if (!plan) return null;

  async function run(plan: RevoicePlan) {
    stop.current = false;
    setConfirmed(plan);
    let done = 0;
    let rendered = 0;
    setPhase({ kind: "running", done, lines: rendered });
    for (const u of plan.units) {
      if (stop.current) break;
      const r = await revoiceUnit({
        bookId,
        issueId: u.issueId,
        bubbleId: u.bubbleId,
        characterId: plan.characterId,
      }).catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (!r.ok) {
        setPhase({
          kind: "stopped",
          finished: false,
          lines: rendered,
          error: r.error,
        });
        setConfirmed(null);
        router.refresh();
        return;
      }
      done += 1;
      rendered += u.bubbles;
      setPhase({ kind: "running", done, lines: rendered });
    }
    const finished = done === plan.units.length;
    setPhase({ kind: "stopped", finished, lines: rendered, error: null });
    // A stop part way shows the page's plan again for the next Re-voice. A
    // finished run keeps the one it ran, so its Done line stays in view.
    if (!finished) {
      setConfirmed(null);
      router.refresh();
    }
  }

  const total = plan.units.length;
  return (
    <section className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3">
      <h4 className={`mb-1 ${LABEL}`}>Old-voice audio</h4>
      <p className="text-[12.5px] text-neutral-300">
        {lines(plan.bubbles)} still play a voice this character no longer has.
        Re-voice renders them again
        {voiceName ? ` in ${voiceName}` : " in its current voice"}.
      </p>
      <ul className="mt-2 text-[12.5px] text-neutral-200">
        {plan.issues.map((i) => (
          <li key={i.issueId} className="flex gap-2">
            <span>Issue {i.number || i.issueId}</span>
            <span className="text-neutral-400">
              {lines(i.bubbles)} · {credits(i.credits)}
            </span>
          </li>
        ))}
        <li className="mt-1 flex gap-2 font-semibold">
          <span>Total</span>
          <span>
            {lines(plan.bubbles)} · {credits(plan.credits)}
          </span>
        </li>
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(phase.kind === "idle" ||
          (phase.kind === "stopped" && !phase.finished)) && (
          <button
            type="button"
            className={BTN}
            onClick={() => setPhase({ kind: "confirm" })}
          >
            Re-voice
          </button>
        )}
        {phase.kind === "confirm" && (
          <>
            <span className="text-[12.5px] text-amber-200">
              Spend {credits(plan.credits)} on {lines(plan.bubbles)}?
            </span>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => run(plan)}
            >
              Confirm
            </button>
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => setPhase({ kind: "idle" })}
            >
              Cancel
            </button>
          </>
        )}
        {phase.kind === "running" && (
          <>
            <span role="status" className="text-[12.5px] text-neutral-200">
              Rendering {phase.done + 1} of {total} · {lines(phase.lines)} done
            </span>
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => {
                stop.current = true;
              }}
            >
              Stop after this one
            </button>
          </>
        )}
        {phase.kind === "stopped" && (
          <span
            role="status"
            className={`text-[12.5px] ${phase.error ? "text-red-300" : "text-emerald-300"}`}
          >
            {phase.error
              ? `Stopped after ${lines(phase.lines)}: ${phase.error} Re-voice again to carry on.`
              : phase.finished
                ? `Done: ${lines(phase.lines)} re-voiced.`
                : `Stopped after ${lines(phase.lines)}. Re-voice again to carry on.`}
          </span>
        )}
      </div>
    </section>
  );
}
