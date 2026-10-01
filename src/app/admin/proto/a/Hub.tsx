// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The issue hub: where the run is, what waits for the owner, and one next action.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isDoc, issueFlags } from "./editor/model";
import { protoHref, readSession, storageKey, writeSession } from "./lib";

export type Stage =
  | "new"
  | "detect"
  | "characters"
  | "read"
  | "pages"
  | "audio"
  | "ready"
  | "failed";

export interface HubCounts {
  pages: number;
  panels: number;
  bubbles: number;
  characters: number;
  unknownFaces: number;
  noVoice: number;
  needYou: number;
  slotsUsed: number;
  slotsTotal: number;
}

interface HubProps {
  book: string;
  issue: string;
  counts: HubCounts;
  /** The stage the real `issues` row is at. */
  realStage: Stage;
  realStep: string | null;
}

const STEPS: { id: Stage; label: string; gate: boolean }[] = [
  { id: "detect", label: "Detect", gate: false },
  { id: "characters", label: "Characters", gate: true },
  { id: "read", label: "Read", gate: false },
  { id: "pages", label: "Pages", gate: true },
  { id: "audio", label: "Voices and audio", gate: false },
  { id: "ready", label: "Ready", gate: false },
];

const STAGE_NAMES: [Stage, string][] = [
  ["new", "Not started"],
  ["detect", "Detecting"],
  ["characters", "At characters"],
  ["read", "Reading"],
  ["pages", "At pages"],
  ["audio", "Making audio"],
  ["ready", "Ready"],
  ["failed", "Failed"],
];

const PRIMARY =
  "inline-flex h-8 items-center rounded-sm bg-neutral-100 px-4 text-[13px] font-medium text-neutral-950 hover:bg-white";

export function Hub({ book, issue, counts, realStage, realStep }: HubProps) {
  const [stage, setStage] = useState<Stage>(realStage);
  const [note, setNote] = useState<string | null>(null);
  const [session, setSession] = useState<{
    castConfirmed: boolean;
    approvedPages: number | null;
    needYou: number | null;
    issueApproved: boolean;
  }>({
    castConfirmed: false,
    approvedPages: null,
    needYou: null,
    issueApproved: false,
  });

  // What this browser tab did on the other two screens.
  useEffect(() => {
    const stored = readSession<Stage>(storageKey("stage", book, issue));
    if (stored && STAGE_NAMES.some(([id]) => id === stored)) setStage(stored);
    const chars = readSession<{ confirmed?: boolean }>(
      storageKey("chars", book, issue),
    );
    const saved = readSession<{ doc?: unknown }>(
      storageKey("doc", book, issue),
    )?.doc;
    if (isDoc(saved)) {
      const flags = issueFlags(saved);
      const flagged = new Set(flags.map((f) => f.page));
      setSession({
        castConfirmed: chars?.confirmed ?? false,
        approvedPages: Object.values(saved.pages).filter(
          (p) => p.approved && !flagged.has(p.number),
        ).length,
        needYou: flags.length,
        issueApproved: saved.issueApproved,
      });
    } else {
      setSession((prev) => ({
        ...prev,
        castConfirmed: chars?.confirmed ?? false,
      }));
    }
  }, [book, issue]);

  const view = (next: Stage, message?: string) => {
    setStage(next);
    setNote(message ?? null);
    writeSession(storageKey("stage", book, issue), next);
  };

  const needYou = session.needYou ?? counts.needYou;
  const approved = session.approvedPages ?? 0;
  const order = STEPS.map((s) => s.id);
  const failedAt: Stage = "read";
  const at = stage === "failed" ? failedAt : stage;
  const position = stage === "new" ? -1 : order.indexOf(at);

  const detail: Record<Stage, string> = {
    new: "",
    detect: `${counts.pages} pages, ${counts.panels} panels, ${counts.bubbles} bubbles`,
    characters:
      counts.unknownFaces > 0
        ? `${counts.characters} found, ${counts.unknownFaces} faces unnamed`
        : `${counts.characters} characters in the cast`,
    read: "a speaker for every bubble, from the cast only",
    pages:
      stage === "pages"
        ? `${approved} of ${counts.pages} approved, ${needYou} need you`
        : `${counts.pages} pages approved`,
    audio: "new characters only, then every bubble",
    ready: "plays in the reader",
    failed: "",
  };

  let headline: string;
  let body: string;
  let action: React.ReactNode = null;
  switch (stage) {
    case "new":
      headline = "Not started";
      body = `${counts.pages} pages are uploaded. Starting finds the panels, bubbles and faces. It stops for you twice, and no audio is made before the second stop.`;
      action = (
        <button
          type="button"
          className={PRIMARY}
          onClick={() =>
            view(
              "detect",
              "Prototype: nothing was started. The real button starts the run.",
            )
          }
        >
          Start the run
        </button>
      );
      break;
    case "detect":
      headline = "Running: finding panels, bubbles and faces";
      body =
        "Nothing is waiting for you. The run stops at characters when it is done.";
      break;
    case "characters":
      headline = "Waiting for you: characters";
      body = `${counts.characters} characters were found. Name the faces it could not place and check each voice. The pages are read against this list, and nothing else can be added to it by the model.`;
      action = (
        <Link href={protoHref("/characters", book, issue)} className={PRIMARY}>
          Review characters
        </Link>
      );
      break;
    case "read":
      headline = "Running: reading the pages";
      body = `Each bubble gets its text, a speaker from your cast of ${counts.characters}, and an emotion. Nothing is waiting for you. The run stops at pages when it is done.`;
      break;
    case "pages":
      headline = session.issueApproved
        ? "Pages approved in this tab"
        : "Waiting for you: pages";
      body = session.issueApproved
        ? "You approved the issue in the prototype editor. The real run would now make voices for new characters, then audio."
        : needYou > 0
          ? `${needYou} of ${counts.bubbles} bubbles need a decision before any audio is made. ${approved} of ${counts.pages} pages are approved.`
          : `Every bubble has a speaker. ${approved} of ${counts.pages} pages are approved.`;
      action = (
        <Link href={protoHref("/editor", book, issue)} className={PRIMARY}>
          {approved > 0 || session.issueApproved
            ? "Back to the pages"
            : "Review pages"}
        </Link>
      );
      break;
    case "audio":
      headline = "Running: making voices and audio";
      body = `This is the only stretch that spends ElevenLabs credits, and it started because you approved the pages. Voice slots: ${counts.slotsUsed} of ${counts.slotsTotal} used. Nothing is waiting for you.`;
      break;
    case "ready":
      headline = "Ready to read";
      body = `${counts.pages} pages and ${counts.bubbles} bubbles are in the reader.`;
      action = (
        <Link href={`/admin/preview/${book}/${issue}/1`} className={PRIMARY}>
          Open in the reader
        </Link>
      );
      break;
    case "failed":
      headline = "Stopped: reading the pages failed";
      body =
        "The step failed on page 2 and the run is paused. Earlier steps keep their results, so a retry starts from this step and repeats nothing before it.";
      action = (
        <button
          type="button"
          className={PRIMARY}
          onClick={() =>
            view(
              "read",
              "Prototype: nothing was retried. The real button reruns this one step.",
            )
          }
        >
          Retry this step
        </button>
      );
      break;
  }

  const waiting = stage === "characters" || stage === "pages";

  return (
    <div className="mx-auto w-full max-w-[920px] px-6 py-10">
      <div className="text-[11px] tracking-wide text-neutral-500 uppercase">
        {stage === "pages" && session.issueApproved
          ? "Done in this tab"
          : waiting
            ? "Your turn"
            : stage === "failed"
              ? "Needs a retry"
              : stage === "ready"
                ? "Done"
                : stage === "new"
                  ? "Idle"
                  : "The machine's turn"}
      </div>
      <h1
        className={`mt-1 text-[22px] leading-tight font-medium ${
          stage === "failed" ? "text-amber-200" : "text-neutral-50"
        }`}
      >
        {headline}
      </h1>
      <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-neutral-400">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
      {note && (
        <p role="status" className="mt-3 text-[12px] text-neutral-500">
          {note}
        </p>
      )}

      <div className="relative mt-12">
        <div className="absolute top-[7px] right-[8.33%] left-[8.33%] h-px bg-neutral-800" />
        <div
          className="absolute top-[7px] left-[8.33%] h-px bg-neutral-300"
          style={{ width: `${Math.max(0, position) * 16.667}%` }}
        />
        <ol className="relative grid grid-cols-6">
          {STEPS.map((step, i) => {
            const done = i < position || stage === "ready";
            const current = i === position && stage !== "ready";
            const stuck = current && stage === "failed";
            return (
              <li
                key={step.id}
                className="relative flex flex-col items-center px-2 text-center"
              >
                <span
                  className={`relative z-10 block size-[15px] border-2 ${
                    step.gate ? "rounded-[2px]" : "rounded-full"
                  } ${
                    stuck
                      ? "border-amber-400 bg-amber-400"
                      : current
                        ? step.gate
                          ? "border-amber-300 bg-amber-300"
                          : "border-neutral-100 bg-neutral-950"
                        : done
                          ? "border-neutral-300 bg-neutral-300"
                          : "border-neutral-700 bg-neutral-950"
                  }`}
                />
                <span
                  className={`mt-2 text-[12px] font-medium ${
                    current
                      ? "text-neutral-50"
                      : done
                        ? "text-neutral-300"
                        : "text-neutral-500"
                  }`}
                >
                  {step.label}
                </span>
                <span className="text-[11px] text-neutral-500">
                  {step.gate
                    ? current
                      ? "waiting for you"
                      : "you review"
                    : stuck
                      ? "failed"
                      : current
                        ? "running"
                        : "runs by itself"}
                </span>
                {(done || current) && (
                  <span className="mt-1 text-[11px] leading-snug text-neutral-400">
                    {detail[step.id]}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <dl className="mt-12 divide-y divide-neutral-800 border-y border-neutral-800 text-[12px]">
        <div className="flex items-baseline gap-4 py-2.5">
          <dt className="w-28 shrink-0 text-neutral-500">Characters</dt>
          <dd className="flex-1 text-neutral-300">
            {position < 1
              ? "Not found yet."
              : `${counts.characters} characters in the cast${
                  session.castConfirmed
                    ? ", confirmed in this tab"
                    : stage === "characters"
                      ? ", not confirmed yet"
                      : ""
                }. ${
                  counts.noVoice > 0
                    ? `${counts.noVoice} without a voice.`
                    : "Every one has a voice."
                }`}
          </dd>
          {position >= 1 && (
            <Link
              href={protoHref("/characters", book, issue)}
              className="text-neutral-400 underline-offset-2 hover:text-white hover:underline"
            >
              Open
            </Link>
          )}
        </div>
        <div className="flex items-baseline gap-4 py-2.5">
          <dt className="w-28 shrink-0 text-neutral-500">Pages</dt>
          <dd className="flex-1 text-neutral-300">
            {position < 3
              ? "Not read yet."
              : stage === "pages"
                ? `${approved} of ${counts.pages} approved. ${needYou} bubbles need you.`
                : `${counts.pages} pages, ${counts.bubbles} bubbles, approved.`}
          </dd>
          {position >= 3 && (
            <Link
              href={protoHref("/editor", book, issue)}
              className="text-neutral-400 underline-offset-2 hover:text-white hover:underline"
            >
              Open
            </Link>
          )}
        </div>
        <div className="flex items-baseline gap-4 py-2.5">
          <dt className="w-28 shrink-0 text-neutral-500">Audio</dt>
          <dd className="flex-1 text-neutral-300">
            {stage === "ready"
              ? "Made."
              : stage === "audio"
                ? "Being made now."
                : "Not started. It starts by itself once the pages are approved, and not before."}
          </dd>
        </div>
      </dl>

      <div className="mt-10 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        <span className="mr-1">
          Prototype: see this screen at another point of the run
        </span>
        {STAGE_NAMES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={stage === id}
            onClick={() => view(id)}
            className={`rounded-sm border px-1.5 leading-5 ${
              stage === id
                ? "border-neutral-400 text-neutral-100"
                : "border-neutral-800 hover:border-neutral-600 hover:text-neutral-200"
            }`}
          >
            {label}
            {id === realStage ? " (real)" : ""}
          </button>
        ))}
        <span className="ml-1">
          The issue row says: {realStep ?? "no step"}.
        </span>
      </div>
    </div>
  );
}
