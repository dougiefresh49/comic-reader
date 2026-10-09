// Review (#787): the one list of the staged moves. It asks `reviewMoves` for
// the plan (again after every change while open) and shows the totals, the
// steps in run order with ✕ on each, and the blockers with their fixes.
// Confirm runs `confirmMoves`, and is disabled while there is any blocker.
"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  ArchiveMove,
  Blocker,
  MovesPlan,
  RunResult,
} from "~/lib/casting-moves";
import { confirmMoves, reviewMoves } from "./casting-actions";
import { useTabTrap } from "./shared";
import { characterOf, type Staged } from "./staging";
import { BTN, BTN_GHOST, BTN_PRIMARY, BTN_SMALL, FOCUS, LABEL } from "./ui";

interface Scope {
  bookId: string;
  issueId: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "plan"; plan: MovesPlan }
  | { kind: "error"; error: string }
  | { kind: "running"; plan: MovesPlan }
  | { kind: "ran"; result: RunResult };

/** The character a blocker is about, for its Sit out fix: the move's, else the name its reason starts with. */
function blockerCharacter(
  b: Blocker,
  staged: Staged[],
  names: { id: string; name: string }[],
): string | null {
  const m = b.moveIndex !== null ? staged[b.moveIndex]?.move : undefined;
  const id = m ? characterOf(m) : null;
  if (id) return id;
  const hit = names
    .filter((n) => b.reason.startsWith(`${n.name} has `))
    .sort((a, z) => z.name.length - a.name.length)[0];
  return hit?.id ?? null;
}

export function ReviewSheet({
  scope,
  staged,
  names,
  onUndo,
  onArchiveFlags,
  onSitOut,
  onRan,
  onClose,
}: {
  scope: Scope;
  staged: Staged[];
  /** The board's characters, for a blocker's Sit out fix. */
  names: { id: string; name: string }[];
  onUndo: (index: number) => void;
  onArchiveFlags: (
    index: number,
    patch: Partial<Pick<ArchiveMove, "backup" | "lossy_ok">>,
  ) => void;
  onSitOut: (characterId: string) => void;
  /** Confirm finished (done or stopped): the moves it carried out. */
  onRan: (result: RunResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  useTabTrap(box);

  // Plan again whenever the staged list changes, unless a run is out or done.
  const ran = phase.kind === "running" || phase.kind === "ran";
  useEffect(() => {
    if (ran) return;
    if (staged.length === 0) return;
    let live = true;
    setPhase({ kind: "loading" });
    reviewMoves({ scope, moves: staged.map((s) => s.move) })
      .then((r) => {
        if (!live) return;
        setPhase(
          r.ok
            ? { kind: "plan", plan: r.data }
            : { kind: "error", error: r.error },
        );
      })
      .catch((err: unknown) => {
        if (live)
          setPhase({
            kind: "error",
            error: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      live = false;
    };
    // `ran` is read, not watched: a finished run keeps its result on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, staged]);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Escape closes Review and stops there, so the panel behind stays open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      closeRef2.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const outcome =
    phase.kind === "ran" && phase.result.status !== "refused"
      ? phase.result
      : null;
  /** Every way out: a finished run hands its result over first. */
  const close = () => {
    if (phase.kind === "running") return;
    if (outcome) onRan(outcome);
    onClose();
  };
  const closeRef2 = useRef(close);
  closeRef2.current = close;

  const confirm = (plan: MovesPlan) => {
    setPhase({ kind: "running", plan });
    confirmMoves({ scope, moves: staged.map((s) => s.move) })
      .then((r) => {
        if (!r.ok) {
          setPhase({ kind: "error", error: r.error });
          return;
        }
        if (r.data.status === "refused")
          setPhase({
            kind: "plan",
            plan: { ...plan, blockers: r.data.blockers },
          });
        else setPhase({ kind: "ran", result: r.data });
      })
      .catch((err: unknown) =>
        setPhase({
          kind: "error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  };

  const plan =
    phase.kind === "plan" || phase.kind === "running" ? phase.plan : null;
  const steps = plan?.steps ?? [];
  const archivesIn = steps.filter((s) => s.kind === "archive");
  const lost = archivesIn.filter((s) => s.backup?.lossy).length;
  const empty = staged.length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onClick={close}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-8"
    >
      <div
        ref={box}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[720px] max-w-full flex-col rounded-2xl border border-neutral-700 bg-neutral-900 text-[13px] text-neutral-200 shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3.5">
          <h3
            id={headingId}
            className="text-[15px] font-semibold text-neutral-100"
          >
            Review
          </h3>
          <span className="text-neutral-400">
            {scope.bookId} / {scope.issueId}
          </span>
          <button
            ref={closeRef}
            type="button"
            disabled={phase.kind === "running"}
            onClick={close}
            aria-label="Close"
            className={`${BTN_GHOST} ml-auto size-7 justify-center px-0`}
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5">
          {empty && !outcome ? (
            <p className="py-8 text-center text-neutral-500">
              Nothing to confirm
            </p>
          ) : phase.kind === "loading" ? (
            <p className="py-8 text-center text-neutral-500">Planning…</p>
          ) : phase.kind === "error" ? (
            <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-red-300">
              {phase.error}
            </p>
          ) : outcome ? (
            <ol className="overflow-hidden rounded-lg border border-neutral-800">
              {outcome.moves.map((m) => (
                <li
                  key={m.moveIndex}
                  className={`grid grid-cols-[24px_1fr_auto] items-center gap-2.5 border-b border-neutral-800 px-2.5 py-2 last:border-b-0 ${
                    m.status === "done"
                      ? "bg-emerald-950/40"
                      : m.status === "pending"
                        ? ""
                        : "bg-red-950/40"
                  }`}
                >
                  <span className="text-right font-mono text-[11px] text-neutral-500">
                    {m.seq + 1}
                  </span>
                  <span>
                    {outcome.plan.steps.find(
                      (s) => s.moveIndex === m.moveIndex && s.kind !== "backup",
                    )?.label ?? m.kind}
                    {m.reasons.length > 0 && (
                      <span className="block text-[12px] text-neutral-400">
                        {m.reasons.join(" · ")}
                      </span>
                    )}
                  </span>
                  <span
                    className={`font-mono text-[12px] ${m.status === "done" ? "text-emerald-400" : m.status === "pending" ? "text-neutral-500" : "text-red-400"}`}
                  >
                    {m.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ol>
          ) : plan ? (
            <>
              <div className="mb-3.5 grid grid-cols-4 gap-2">
                <Total
                  k="Slots after"
                  v={plan.slots.after}
                  small={`of ${plan.slots.limit}`}
                />
                <Total k="Created" v={plan.headroom.adds} />
                <Total
                  k="Archived"
                  v={archivesIn.length}
                  small={
                    archivesIn.length
                      ? lost
                        ? `${lost} lost`
                        : "backed up"
                      : undefined
                  }
                  red={lost > 0}
                />
                <Total
                  k="Credits"
                  v={`~${plan.credits.previews + plan.credits.run}`}
                  small="previews"
                />
              </div>
              <ol className="overflow-hidden rounded-lg border border-neutral-800">
                {steps.map((s, n) => {
                  const st = staged[s.moveIndex];
                  const move = st?.move;
                  const isArchive =
                    s.kind === "archive" && move?.kind === "archive";
                  return (
                    <li
                      key={s.seq}
                      className={`grid grid-cols-[24px_1fr_28px] items-center gap-2.5 border-b border-neutral-800 px-2.5 py-2 last:border-b-0 ${
                        s.backup?.lossy && s.kind === "archive"
                          ? "bg-red-950/30"
                          : phase.kind === "running"
                            ? "bg-amber-950/30"
                            : ""
                      }`}
                    >
                      <span className="text-right font-mono text-[11px] text-neutral-500">
                        {n + 1}
                      </span>
                      <span className="min-w-0">
                        {s.label}
                        <span className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-400">
                          {s.slot === "free" && <span>free slot</span>}
                          {s.slot === "freed" && (
                            <span>
                              slot from move {(s.slotFromMove ?? 0) + 1}
                            </span>
                          )}
                          {s.slot === "frees" && <span>frees a slot</span>}
                          {isArchive && move.kind === "archive" && (
                            <label className="inline-flex cursor-pointer items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={move.backup}
                                disabled={phase.kind === "running"}
                                onChange={(e) =>
                                  onArchiveFlags(s.moveIndex, {
                                    backup: e.target.checked,
                                  })
                                }
                                className={`size-3.5 accent-amber-400 ${FOCUS}`}
                              />
                              back up first
                            </label>
                          )}
                          {isArchive &&
                            move.kind === "archive" &&
                            (s.backup?.lossy === true || move.lossy_ok) && (
                              <label className="inline-flex cursor-pointer items-center gap-1.5 text-red-400">
                                <input
                                  type="checkbox"
                                  checked={move.lossy_ok}
                                  disabled={phase.kind === "running"}
                                  onChange={(e) =>
                                    onArchiveFlags(s.moveIndex, {
                                      lossy_ok: e.target.checked,
                                    })
                                  }
                                  className={`size-3.5 accent-amber-400 ${FOCUS}`}
                                />
                                archive anyway · lost
                              </label>
                            )}
                          {s.warnings.map((w) => (
                            <span key={w} className="text-neutral-500">
                              {w}
                            </span>
                          ))}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={phase.kind === "running"}
                        onClick={() => onUndo(s.moveIndex)}
                        aria-label={`Undo: ${s.label}`}
                        title="Undo"
                        className={`grid size-6 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-red-400 ${FOCUS}`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-1.5 text-[12px] text-neutral-400">
                {plan.headroom.adds} of {plan.headroom.left} changes left this
                month · lines render at the audio step
              </p>
              {plan.blockers.map((b, i) => {
                const who =
                  b.code === "unvoiced_speaker"
                    ? blockerCharacter(b, staged, names)
                    : null;
                const m =
                  b.moveIndex !== null ? staged[b.moveIndex]?.move : undefined;
                return (
                  <div
                    key={i}
                    role="alert"
                    className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-300"
                  >
                    <span className="min-w-0 flex-1">{b.reason}</span>
                    {b.code === "lossy" && m?.kind === "archive" && (
                      <>
                        {!m.backup && (
                          <button
                            type="button"
                            onClick={() =>
                              onArchiveFlags(b.moveIndex!, { backup: true })
                            }
                            className={BTN_SMALL}
                          >
                            Back up first
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            onArchiveFlags(b.moveIndex!, { lossy_ok: true })
                          }
                          className={BTN_SMALL}
                        >
                          Archive anyway
                        </button>
                      </>
                    )}
                    {who && (
                      <button
                        type="button"
                        onClick={() => onSitOut(who)}
                        className={BTN_SMALL}
                      >
                        Sit out {names.find((n) => n.id === who)?.name ?? who}
                      </button>
                    )}
                    {b.moveIndex !== null && b.code !== "unvoiced_speaker" && (
                      <button
                        type="button"
                        onClick={() => onUndo(b.moveIndex!)}
                        className={BTN_SMALL}
                      >
                        Undo
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5 border-t border-neutral-800 px-5 py-3">
          {outcome ? (
            <>
              <span
                className={`font-semibold ${outcome.status === "done" ? "text-emerald-400" : "text-red-400"}`}
              >
                {outcome.status === "done" ? "Done" : "Stopped"}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={close} className={BTN}>
                Close
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={
                  !plan ||
                  phase.kind !== "plan" ||
                  plan.blockers.length > 0 ||
                  empty
                }
                title={
                  plan && plan.blockers.length > 0
                    ? `${plan.blockers.length} ${plan.blockers.length === 1 ? "blocker" : "blockers"}`
                    : undefined
                }
                onClick={() => plan && confirm(plan)}
                className={BTN_PRIMARY}
              >
                {phase.kind === "running"
                  ? "Running…"
                  : `Confirm${steps.length ? ` ${steps.length}` : ""}`}
              </button>
              <span className="text-[12px] text-neutral-400">
                {lost > 0 ? (
                  <span className="text-red-400">{lost} cannot come back</span>
                ) : archivesIn.length > 0 ? (
                  "Everything archived can come back"
                ) : null}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                disabled={phase.kind === "running"}
                onClick={onClose}
                className={BTN_GHOST}
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Total({
  k,
  v,
  small,
  red,
}: {
  k: string;
  v: number | string;
  small?: string;
  red?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2">
      <div className={LABEL}>{k}</div>
      <div
        className={`text-[20px] leading-tight font-semibold tabular-nums ${red ? "text-red-400" : "text-neutral-100"}`}
      >
        {v}
        {small && (
          <small className="ml-1.5 text-[11px] font-normal text-neutral-400">
            · {small}
          </small>
        )}
      </div>
    </div>
  );
}
