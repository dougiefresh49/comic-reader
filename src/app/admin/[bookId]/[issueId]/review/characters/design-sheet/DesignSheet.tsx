// Design a voice (#788): a sheet over the casting page. Draft a prompt (the
// one on file, free, or a Gemini draft, from a picked face when there is one:
// #850), edit it and the preview text,
// generate three takes (paid), play them, pick one, and Accept: that stages
// a `create_design` move like any other pick. Nothing is saved to
// ElevenLabs until Confirm.
"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CreateDesignMove } from "~/lib/casting-moves";
import { PlayButton, usePlayer } from "../player";
import { useTabTrap } from "~/hooks/useTabTrap";
import type { CharacterCard } from "../types";
import { BTN_GHOST, BTN_PRIMARY, BTN_SMALL, FOCUS, LABEL } from "../ui";
import {
  draftVoicePrompt,
  generateVoicePreviews,
  startDesign,
  voiceOnFile,
  type Take,
} from "./actions";
import { acceptedFor, rememberAccepted } from "./accepted";
import { PREVIEW_MAX, PREVIEW_MIN, previewTextOk } from "./preview-text";

/** The mockup's wand: Draft, and the "Design a voice" entries. */
export const WandIcon = (
  <svg
    width={14}
    height={14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    aria-hidden
  >
    <path d="M2 14l8-8" />
    <path d="M11 2v2M11 7v2M9 4.5h2M12.5 4.5h2" />
  </svg>
);

const ROW = `grid cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 ${FOCUS}`;
const ROW_ON = "border-amber-400 bg-amber-400/10";
const ROW_OFF = "border-neutral-700 bg-neutral-900 hover:border-neutral-500";
const TEXTAREA = `w-full resize-y rounded-lg border bg-neutral-950/60 px-2.5 py-2 text-[13px] leading-[1.45] text-neutral-100 placeholder:text-neutral-500 ${FOCUS}`;
const NOTE = "mt-1.5 text-[12px] text-neutral-400";

function Spinner() {
  return (
    <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
  );
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

interface Face {
  /** The `character_face_exemplars.id`. */
  id: string;
  page: number;
  confirmed: boolean;
  confidence: number;
  cropUrl: string;
}

/** The faces Draft can use: the card's exemplar crops, confirmed first, then the most confident. */
function pickableFaces(card: CharacterCard): Face[] {
  const faces = new Map<string, Face>();
  for (const f of card.faces)
    if (f.exemplar)
      faces.set(f.exemplar.id, {
        id: f.exemplar.id,
        page: f.page,
        confirmed: f.exemplar.confirmed,
        confidence: f.exemplar.confidence,
        cropUrl: f.exemplar.cropUrl,
      });
  for (const e of card.looseExemplars)
    if (!faces.has(e.id))
      faces.set(e.id, {
        id: e.id,
        page: e.page,
        confirmed: e.confirmed,
        confidence: e.confidence,
        cropUrl: e.cropUrl,
      });
  return [...faces.values()].sort(
    (a, b) =>
      Number(b.confirmed) - Number(a.confirmed) ||
      b.confidence - a.confidence ||
      a.page - b.page,
  );
}

export function DesignSheet({
  scope,
  card,
  name,
  staged,
  onAccept,
  onClose,
}: {
  scope: { bookId: string; issueId: string };
  card: CharacterCard;
  /** The character's name as staged. */
  name: string;
  /** Its staged design, when it has one: the sheet opens on it. */
  staged: CreateDesignMove | null;
  onAccept: (move: CreateDesignMove) => void;
  onClose: () => void;
}) {
  const who = { ...scope, characterId: card.id };
  const kept = staged ? acceptedFor(staged) : undefined;
  const headingId = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const player = usePlayer();
  useTabTrap(box);

  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState(staged?.design_prompt ?? "");
  /** The `description` on file (else `design_prompt`), quoted by the "From:" line. */
  const [onFile, setOnFile] = useState<string | null>(null);
  /** What Gemini drafted the prompt from: the voice snippets or lines, and whether a face; null for no Gemini draft. */
  const [drafted, setDrafted] = useState<{
    snippets: string[];
    face: boolean;
  } | null>(null);
  const [faces] = useState(() => pickableFaces(card));
  /** The face Draft sends, an exemplar id: the best one to start, null once unpicked. */
  const [face, setFace] = useState<string | null>(faces[0]?.id ?? null);
  const [previewText, setPreviewText] = useState(staged?.preview_text ?? "");
  /** Why the face draft's preview text needs an edit (empty, or the wrong length); cleared by an edit. */
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [ownLines, setOwnLines] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  /** The takes on screen, with the prompt and text they were made from. */
  const [made, setMade] = useState<{
    takes: Take[];
    prompt: string;
    text: string;
  } | null>(
    kept && staged
      ? {
          takes: kept.takes,
          prompt: staged.design_prompt,
          text: staged.preview_text,
        }
      : null,
  );
  const [take, setTake] = useState(kept?.take ?? 0);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [mode, setMode] = useState<"keep" | "run">(
    staged?.run_only ? "run" : "keep",
  );

  // Opening reads the prompt on file and the default preview text, free.
  useEffect(() => {
    let live = true;
    startDesign(who)
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setDraftError(r.error);
          return;
        }
        setOwnLines(r.data.previewText);
        setOnFile(r.data.onFile);
        if (!staged) {
          setPreviewText(r.data.previewText);
          if (r.data.prompt) setPrompt(r.data.prompt);
        }
      })
      .catch((err: unknown) => live && setDraftError(message(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // Once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus starts on the close button and goes back to the opener; a take
  // still playing stops when the sheet closes.
  const stopRef = useRef(player.stop);
  stopRef.current = player.stop;
  const playingRef = useRef(player.playing);
  playingRef.current = player.playing;
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => {
      if (playingRef.current?.startsWith("take:")) stopRef.current();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Escape closes the sheet and stops there, so the panel behind stays open.
  const closeLatest = useRef(onClose);
  closeLatest.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      closeLatest.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  /** A take only says the text it was made from: an edit clears them. */
  const clearTakes = useCallback(() => {
    if (playingRef.current?.startsWith("take:")) stopRef.current();
    setMade(null);
    setTake(0);
  }, []);

  const previewRef = useRef(previewText);
  previewRef.current = previewText;

  const draft = () => {
    setDrafting(true);
    setDraftError(null);
    setPreviewNote(null);
    draftVoicePrompt({
      ...who,
      again: prompt.trim() !== "",
      exemplarId: face,
      wantPreviewText: previewText.trim() === "",
    })
      .then((r) => {
        if (!r.ok) {
          setDraftError(r.error);
          return;
        }
        const { snippets, previewText: drafted, previewNote } = r.data;
        setPrompt(r.data.prompt);
        setDrafted(snippets && { snippets, face: face !== null });
        // The drafted preview text, and its note, fill the field only while it is empty.
        if (previewRef.current.trim() === "") {
          if (drafted) setPreviewText(drafted);
          setPreviewNote(previewNote ?? null);
        }
        clearTakes();
      })
      .catch((err: unknown) => setDraftError(message(err)))
      .finally(() => setDrafting(false));
  };

  const generate = () => {
    const sent = prompt.trim();
    setGenerating(true);
    setGenError(null);
    clearTakes();
    generateVoicePreviews({ ...who, prompt: sent, previewText })
      .then((r) => {
        if (!r.ok) {
          setGenError(r.error);
          return;
        }
        setMade({ takes: r.data.takes, prompt: sent, text: r.data.text });
      })
      .catch((err: unknown) => setGenError(message(err)))
      .finally(() => setGenerating(false));
  };

  const accept = () => {
    const picked = made?.takes[take - 1];
    if (!made || !picked) return;
    const move: CreateDesignMove = {
      kind: "create_design",
      character_id: card.id,
      generated_voice_id: picked.generated_voice_id,
      design_prompt: made.prompt,
      preview_text: made.text,
      run_only: mode === "run",
      replaces_voice_uuid: card.voice?.uuid ?? null,
    };
    rememberAccepted({ move, take, takes: made.takes });
    onAccept(move);
  };

  const pn = previewText.length;
  const canGenerate =
    prompt.trim() !== "" &&
    previewTextOk(previewText) &&
    !generating &&
    !drafting &&
    !loading;
  const lines = card.lines;
  const oneOff = card.group !== "role" && lines >= 1 && lines <= 2;

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/55"
      />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-full flex-col border-l border-neutral-800 bg-neutral-900 text-[13px] text-neutral-200 shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-[18px] py-3.5">
          <div className="min-w-0">
            <h3
              id={headingId}
              className="truncate text-[15px] font-semibold text-neutral-100"
            >
              Design a voice · {name}
            </h3>
            <div className="text-neutral-400 tabular-nums">
              {lines} {lines === 1 ? "line" : "lines"}
              {oneOff ? " · one-off" : ""}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${BTN_GHOST} ml-auto size-7 justify-center px-0`}
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-3.5">
          <section className="mb-4">
            <div className="mb-1.5 flex items-baseline gap-2">
              <label
                htmlFor={`${headingId}-prompt`}
                className="font-semibold text-neutral-100"
              >
                Prompt
              </label>
              <div className="ml-auto flex items-center gap-2 text-[12px] text-neutral-400 tabular-nums">
                <span>{prompt.length}</span>
                <button
                  type="button"
                  disabled={drafting || loading || generating}
                  onClick={draft}
                  className={BTN_SMALL}
                >
                  {drafting ? <Spinner /> : WandIcon}{" "}
                  {prompt.trim() ? "Draft again" : "Draft"}
                </button>
              </div>
            </div>
            {faces.length > 0 && (
              <div
                role="group"
                aria-label="Face to draft from"
                className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5"
              >
                <span className="mr-0.5 shrink-0 text-[12px] text-neutral-400">
                  From face
                </span>
                {faces.map((f) => {
                  const on = face === f.id;
                  const label = `Page ${f.page} face${f.confirmed ? ", confirmed" : ""}`;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={on}
                      aria-label={label}
                      title={`${label} · ${Math.round(f.confidence * 100)}%`}
                      disabled={drafting}
                      onClick={() => setFace(on ? null : f.id)}
                      className={`size-10 shrink-0 overflow-hidden rounded-md border-2 disabled:cursor-not-allowed ${on ? "border-amber-400" : "border-transparent opacity-60 hover:opacity-100"} ${FOCUS}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={f.cropUrl}
                        alt=""
                        className="size-full bg-neutral-800 object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              id={`${headingId}-prompt`}
              rows={5}
              value={prompt}
              readOnly={drafting || generating}
              placeholder="Age, pitch, accent, energy"
              onChange={(e) => {
                setPrompt(e.target.value);
                if (made) clearTakes();
              }}
              className={`${TEXTAREA} border-amber-700/60`}
            />
            {draftError ? (
              <div className={`${NOTE} text-red-400`}>{draftError}</div>
            ) : drafted ? (
              <div
                className={NOTE}
                title={
                  !drafted.face
                    ? "voice notes from its lines"
                    : drafted.snippets.length > 0
                      ? "drafted from the picked face and its lines"
                      : "drafted from the picked face"
                }
              >
                From: {drafted.face ? "its face" : ""}
                {drafted.face && drafted.snippets.length > 0 ? " · " : ""}
                {drafted.snippets.length > 0
                  ? `“${drafted.snippets.join(" · ")}”`
                  : ""}
              </div>
            ) : onFile ? (
              <div className={NOTE} title="voices.description on file">
                From: “{onFile}”
              </div>
            ) : !loading && !prompt.trim() ? (
              <div className={NOTE}>Nothing on file</div>
            ) : null}
          </section>

          <section className="mb-4">
            <div className="mb-1.5 flex items-baseline gap-2">
              <label
                htmlFor={`${headingId}-text`}
                className="font-semibold text-neutral-100"
              >
                Preview text
              </label>
              <span
                className={`ml-auto text-[12px] tabular-nums ${
                  previewTextOk(previewText)
                    ? "text-neutral-400"
                    : "text-red-400"
                }`}
              >
                {pn} · {PREVIEW_MIN}–{PREVIEW_MAX}
              </span>
            </div>
            <textarea
              id={`${headingId}-text`}
              rows={3}
              value={previewText}
              readOnly={generating}
              onChange={(e) => {
                setPreviewText(e.target.value);
                setPreviewNote(null);
                if (made) clearTakes();
              }}
              className={`${TEXTAREA} border-neutral-700`}
            />
            {previewNote && (
              <div className={`${NOTE} text-amber-300`}>{previewNote}</div>
            )}
            <div className={NOTE}>
              {ownLines !== null && previewText === ownLines
                ? "Its own lines · "
                : ""}
              ~{pn} credits for three takes
            </div>
          </section>

          <section className="mb-4">
            <button
              type="button"
              disabled={!canGenerate}
              title={`~${pn} credits`}
              onClick={generate}
              className={BTN_PRIMARY}
            >
              {generating ? (
                <>
                  <Spinner /> Generating
                </>
              ) : made ? (
                "Three more takes"
              ) : (
                "Generate three takes"
              )}
            </button>
            {genError && (
              <div className={`${NOTE} text-red-400`}>{genError}</div>
            )}
            {made && (
              <div
                role="radiogroup"
                aria-label="Takes"
                className="mt-2.5 flex flex-col gap-1.5"
              >
                {made.takes.map((t, i) => (
                  <label
                    key={t.generated_voice_id}
                    className={`${ROW} grid-cols-[18px_1fr_auto] ${take === i + 1 ? ROW_ON : ROW_OFF}`}
                  >
                    <input
                      type="radio"
                      name={`${headingId}-take`}
                      value={i + 1}
                      checked={take === i + 1}
                      onChange={() => setTake(i + 1)}
                      className="m-0 accent-amber-400"
                    />
                    <span className="font-semibold text-neutral-100">
                      Take {i + 1}
                    </span>
                    <PlayButton
                      url={t.url}
                      playKey={`take:${t.generated_voice_id}`}
                      name={`take ${i + 1}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section role="radiogroup" aria-labelledby={`${headingId}-confirm`}>
            <h4 id={`${headingId}-confirm`} className={`mb-1.5 ${LABEL}`}>
              At confirm
            </h4>
            {(
              [
                {
                  key: "keep",
                  title: `Keep as ${name}'s voice`,
                  sub: "One slot · prompt kept",
                },
                {
                  key: "run",
                  title: "This run only",
                  sub: `One slot until its ${lines === 1 ? "line renders" : `${lines} lines render`} · then freed`,
                },
              ] as const
            ).map((o) => (
              <label
                key={o.key}
                className={`${ROW} mb-1.5 grid-cols-[18px_1fr] ${mode === o.key ? ROW_ON : ROW_OFF}`}
              >
                <input
                  type="radio"
                  name={`${headingId}-mode`}
                  value={o.key}
                  checked={mode === o.key}
                  onChange={() => setMode(o.key)}
                  className="m-0 accent-amber-400"
                />
                <span>
                  <span className="block font-semibold text-neutral-100">
                    {o.title}
                  </span>
                  <span className="block text-[12px] text-neutral-400">
                    {o.sub}
                  </span>
                </span>
              </label>
            ))}
            <div
              className={`${NOTE} text-red-400`}
              title="ElevenLabs: an unsaved design can only say its preview text"
            >
              Unsaved takes only say the preview text
            </div>
          </section>
        </div>

        <div className="flex items-center gap-2.5 border-t border-neutral-800 px-[18px] py-3">
          <button
            type="button"
            disabled={!made || take === 0}
            onClick={accept}
            className={BTN_PRIMARY}
          >
            Accept take {take || "…"}
          </button>
          <span className="text-[12px] text-neutral-400">Saved at confirm</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The Voice tab's "Design a voice" row: a dashed row that opens the sheet.
 * Its sub-line says whether a description is on file (a free read).
 */
export function DesignVoiceRow({
  characterId,
  onOpen,
}: {
  characterId: string;
  onOpen: () => void;
}) {
  const [described, setDescribed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setDescribed(null);
    voiceOnFile({ characterId })
      .then((r) => live && setDescribed(r.ok ? r.data !== null : false))
      .catch(() => live && setDescribed(false));
    return () => {
      live = false;
    };
  }, [characterId]);
  const sub =
    described === null
      ? "\u00a0"
      : `${described ? "draft from its description" : "from scratch"} · three takes`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
      className={`mb-1.5 grid cursor-pointer grid-cols-[18px_1fr] items-center gap-2.5 rounded-lg border border-dashed border-neutral-700 px-2.5 py-2 hover:bg-neutral-800/60 ${FOCUS}`}
    >
      <span className="grid size-4 place-items-center text-neutral-400">
        {WandIcon}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13px] font-semibold text-neutral-100">
          Design a voice
        </span>
        <span className="truncate text-[11.5px] text-neutral-400">{sub}</span>
      </span>
    </div>
  );
}
