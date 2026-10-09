// The panel's Voice tab (#745): the current voice as a field-like row, and under it a browser of the choices with a preview on each row that has one.
"use client";

import { useEffect, useRef, useState } from "react";
import type { VoiceRequest } from "~/lib/cast";
import {
  BUTTON,
  ICON_BUTTON,
  PRIMARY,
  QUIET,
  SVG_ICON,
  VoiceLine,
} from "./shared";
import type { ActiveVoice, CharacterCard, VoicePick } from "./types";

function PlayIcon() {
  return (
    <svg {...SVG_ICON} fill="currentColor" stroke="none">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...SVG_ICON} className={open ? "rotate-180" : ""}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const PILL =
  "shrink-0 rounded-full border border-neutral-700 px-1.5 text-[11px] leading-4 tracking-[0.04em] text-neutral-400 uppercase";

/** What the primary button does for the chosen entry of "Its voices". */
function pickAction(pick: VoicePick): {
  label: string;
  kind: "use" | "cast" | "clone" | "clip" | "design";
} {
  if (pick.kind === "appearance")
    return { label: "Ask voice-lab for a clip", kind: "clip" };
  if (pick.status === "active") return { label: "Use this voice", kind: "use" };
  // Already a voice of this book: cast here, and the voices stop restores it.
  if (pick.status === "archived" && pick.inBook)
    return { label: "Use in this issue", kind: "cast" };
  if (pick.status === "archived")
    return { label: "Request this clone", kind: "clone" };
  return pick.appearanceId
    ? { label: "Ask voice-lab for a clip", kind: "clip" }
    : { label: "Request this design", kind: "design" };
}

const PICK_STATUS: Record<
  Extract<VoicePick, { kind: "voice" }>["status"],
  string
> = {
  active: "active",
  archived: "archived",
  needs_clip: "needs a clip",
};

/** A row of the browser: which section, which entry. */
type Choice =
  | { section: "pick"; pick: VoicePick }
  | { section: "active"; voice: ActiveVoice }
  | { section: "design" };

const choiceKey = (c: Choice) =>
  c.section === "pick"
    ? `pick:${c.pick.id}`
    : c.section === "active"
      ? `active:${c.voice.id}`
      : "design";

/** A Play button for a preview URL. The parent owns the one audio element. */
function PlayButton({ name, onPlay }: { name: string; onPlay: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPlay();
      }}
      aria-label={`Play ${name}`}
      title={`Play ${name}`}
      className={ICON_BUTTON}
    >
      <PlayIcon />
    </button>
  );
}

/**
 * One radio-style row of the browser: name in bold, the source in grey, the
 * status pills, and Play when the row has a preview. A click anywhere on the
 * row picks it; the radio button inside carries the keyboard.
 */
function ChoiceRow({
  name,
  source,
  pills,
  previewUrl,
  checked,
  disabled = false,
  group,
  onPick,
  onPlay,
}: {
  name: string;
  source: string | null;
  pills: string[];
  previewUrl: string | null;
  checked: boolean;
  /** The current voice: shown for the record, not a choice. */
  disabled?: boolean;
  /** The radio group's `name`. */
  group: string;
  onPick: () => void;
  onPlay: (name: string, url: string) => void;
}) {
  return (
    <li
      onClick={disabled ? undefined : onPick}
      className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 ${
        checked
          ? "border-neutral-300 bg-neutral-800"
          : disabled
            ? "border-neutral-800 bg-neutral-900/40"
            : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/60"
      }`}
    >
      <button
        type="button"
        role="radio"
        name={group}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onPick();
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
      >
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
            checked
              ? "border-white"
              : disabled
                ? "border-neutral-700"
                : "border-neutral-500"
          }`}
        >
          {checked && <span className="block size-2 rounded-full bg-white" />}
        </span>
        <span className="min-w-0 flex-1 leading-5">
          <span
            className={`block truncate font-medium ${
              disabled ? "text-neutral-400" : "text-neutral-100"
            }`}
          >
            {name}
          </span>
          {source && (
            <span className="block truncate text-neutral-500">{source}</span>
          )}
        </span>
        {pills.map((p) => (
          <span key={p} className={PILL}>
            {p}
          </span>
        ))}
      </button>
      {previewUrl !== null && (
        <PlayButton name={name} onPlay={() => onPlay(name, previewUrl)} />
      )}
    </li>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[12px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
      {children}
    </h4>
  );
}

/** A pending voice request on the card, with Undo. */
function VoiceRequestNote({
  card,
  busy,
  onUndo,
}: {
  card: CharacterCard;
  busy: boolean;
  onUndo: () => void;
}) {
  const request = card.voiceRequest;
  if (!request) return null;
  const keeps = `It is made at the voices stop; ${card.name} keeps ${card.voice?.name ?? "no voice"} until then.`;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-sky-400/40 bg-sky-400/5 px-3 py-2 text-[14px]">
      <p className="min-w-0 flex-1 text-sky-100">
        {request.action === "clone"
          ? `Wants a voice-lab clone: ${request.targetName ?? "unknown voice"}. ${keeps}`
          : `Wants a new designed voice. ${keeps}`}
      </p>
      <button type="button" disabled={busy} onClick={onUndo} className={BUTTON}>
        Undo request
      </button>
    </div>
  );
}

export interface VoiceTabProps {
  card: CharacterCard;
  activeVoices: ActiveVoice[];
  /** A `characters` row, not removed: the row gets Change. */
  canChangeVoice: boolean;
  pullNote: string;
  busy: boolean;
  onSetVoice: (voice: ActiveVoice) => void;
  onRequestVoice: (request: VoiceRequest) => void;
  onPickAppearance: (appearanceId: string) => void;
  onCastArchived: (voiceId: string) => void;
  onUndoVoiceRequest: () => void;
}

/**
 * The Voice tab: a "Voice" field whose boxed row names the current voice,
 * its source in grey, Play when a preview exists, and Change on the right.
 * Change opens the browser in place: "Its voices", "Other active voices" and
 * "A new designed voice" as radio-style rows, and a footer whose one primary
 * button is named for the picked row. Every row's Play renders only when its
 * `previewUrl` is a string; today that is the archived clone's clip.
 */
export function VoiceTab({
  card,
  activeVoices,
  canChangeVoice,
  pullNote,
  busy,
  onSetVoice,
  onRequestVoice,
  onPickAppearance,
  onCastArchived,
  onUndoVoiceRequest,
}: VoiceTabProps) {
  const [changing, setChanging] = useState(false);
  const currentId = card.voice?.uuid ?? null;
  /** The current voice's own entry: shown under "Its voices" for the record, never a choice. */
  const isCurrent = (p: VoicePick) => p.kind === "voice" && p.id === currentId;
  const [pickedKey, setPickedKey] = useState<string | null>(() => {
    const start = card.voicePicks.find(
      (p) => p.kind === "voice" && p.startingPick && !isCurrent(p),
    );
    return start ? `pick:${start.id}` : null;
  });
  const [pull, setPull] = useState<"copied" | "failed" | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const play = (name: string, url: string) => {
    audio.current?.pause();
    setPlayError(null);
    const a = new Audio(url);
    audio.current = a;
    a.play().catch(() => setPlayError(`Could not play ${name}.`));
  };

  const others = activeVoices.filter((v) => v.id !== currentId);
  const choices: Choice[] = [
    ...card.voicePicks
      .filter((p) => !isCurrent(p))
      .map((pick): Choice => ({ section: "pick", pick })),
    ...others.map((voice): Choice => ({ section: "active", voice })),
    { section: "design" },
  ];
  const picked = choices.find((c) => choiceKey(c) === pickedKey) ?? null;
  const action = picked
    ? picked.section === "pick"
      ? pickAction(picked.pick)
      : picked.section === "active"
        ? { label: "Use this voice", kind: "use" as const }
        : { label: "Request this design", kind: "design" as const }
    : null;
  const group = `voice-${card.id}`;
  const close = () => setChanging(false);
  const apply = () => {
    if (!picked || !action) return;
    close();
    if (picked.section === "active") return onSetVoice(picked.voice);
    if (picked.section === "design")
      return onRequestVoice({ action: "design" });
    const p = picked.pick;
    if (p.kind === "appearance") return onPickAppearance(p.id);
    switch (action.kind) {
      case "use":
        return onSetVoice({ id: p.id, name: p.name });
      case "cast":
        return onCastArchived(p.id);
      case "clone":
        return onRequestVoice({ action: "clone", targetVoiceUuid: p.id });
      case "clip":
        return p.appearanceId && onPickAppearance(p.appearanceId);
      case "design":
        return onRequestVoice({ action: "design" });
    }
  };

  // The current voice's source: VoiceLine names whose it is when borrowed;
  // otherwise its own entry says the work it was cloned from, or that it is designed.
  const current = card.voice;
  const currentPick = current?.uuid
    ? card.voicePicks.find(
        (p): p is Extract<VoicePick, { kind: "voice" }> =>
          p.kind === "voice" && p.id === current.uuid,
      )
    : undefined;
  const currentSource =
    current && !current.borrowedFrom && currentPick
      ? (currentPick.work ?? "Designed voice")
      : null;
  const currentPreview = current?.previewUrl ?? null;

  return (
    <div className="text-[14px]">
      <div className="mb-1.5 text-[12px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
        Voice
      </div>
      <div className="flex min-h-10 items-center gap-2 rounded-md border border-neutral-700 bg-neutral-950/60 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate">
          <VoiceLine card={card} />
          {currentSource && (
            <span className="text-neutral-500">, {currentSource}</span>
          )}
        </span>
        {current && currentPreview !== null && (
          <PlayButton
            name={current.name}
            onPlay={() => play(current.name, currentPreview)}
          />
        )}
        {canChangeVoice && !card.voiceRequest && (
          <button
            type="button"
            disabled={busy}
            aria-expanded={changing}
            onClick={() => setChanging((c) => !c)}
            className={`${QUIET} h-8 gap-1 pr-1.5`}
          >
            Change
            <ChevronIcon open={changing} />
          </button>
        )}
      </div>
      {playError && !changing && (
        <p className="mt-2 text-amber-300">{playError}</p>
      )}

      {card.voiceRequest && (
        <VoiceRequestNote
          card={card}
          busy={busy}
          onUndo={() => {
            setChanging(canChangeVoice);
            onUndoVoiceRequest();
          }}
        />
      )}

      {canChangeVoice && !card.voiceRequest && changing && (
        <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/40">
          <div
            role="radiogroup"
            aria-label={`Voice for ${card.name}`}
            className="space-y-4 p-3"
          >
            <section>
              <SectionHeading>Its voices</SectionHeading>
              {card.voicePicks.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-neutral-300">
                    No voice-lab clone on file.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard.writeText(pullNote).then(
                        () => setPull("copied"),
                        () => setPull("failed"),
                      )
                    }
                    className={BUTTON}
                  >
                    Request a pull
                  </button>
                  {pull === "copied" && (
                    <span className="text-emerald-300">
                      Copied a note for voice-lab.
                    </span>
                  )}
                  {pull === "failed" && (
                    <p className="w-full text-amber-300">
                      Could not copy. The note: {pullNote}
                    </p>
                  )}
                </div>
              ) : (
                <ul className="space-y-1">
                  {card.voicePicks.map((p) => {
                    const key = `pick:${p.id}`;
                    const name = p.kind === "voice" ? p.name : card.name;
                    const source =
                      p.kind === "appearance"
                        ? [p.work, p.voiceActor].filter(Boolean).join(", ")
                        : (p.work ?? "Designed voice");
                    const current = isCurrent(p);
                    const pills =
                      p.kind === "voice"
                        ? [
                            ...(current ? ["current"] : []),
                            PICK_STATUS[p.status],
                            ...(p.inBook ? ["in this book"] : []),
                            ...(p.startingPick ? ["lab default"] : []),
                            // Signing its source clip failed, or it has none: no Play.
                            ...(p.status === "archived" && !p.clipUrl
                              ? ["no clip link"]
                              : []),
                          ]
                        : ["needs a clip"];
                    return (
                      <ChoiceRow
                        key={key}
                        name={name}
                        source={source || null}
                        pills={pills}
                        previewUrl={p.kind === "voice" ? p.clipUrl : null}
                        checked={pickedKey === key}
                        disabled={current}
                        group={group}
                        onPick={() => setPickedKey(key)}
                        onPlay={play}
                      />
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <SectionHeading>Other active voices</SectionHeading>
              {others.length === 0 ? (
                <p className="text-neutral-400">No other active voice.</p>
              ) : (
                <ul className="space-y-1">
                  {others.map((v) => {
                    const key = `active:${v.id}`;
                    return (
                      <ChoiceRow
                        key={key}
                        name={v.name}
                        source={null}
                        pills={["active"]}
                        previewUrl={v.previewUrl ?? null}
                        checked={pickedKey === key}
                        group={group}
                        onPick={() => setPickedKey(key)}
                        onPlay={play}
                      />
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <SectionHeading>A new designed voice</SectionHeading>
              <ul>
                <ChoiceRow
                  name="New designed voice"
                  source="From the character's description"
                  pills={[]}
                  previewUrl={null}
                  checked={pickedKey === "design"}
                  group={group}
                  onPick={() => setPickedKey("design")}
                  onPlay={play}
                />
              </ul>
            </section>
            {playError && <p className="text-amber-300">{playError}</p>}
          </div>

          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-b-md border-t border-neutral-800 bg-neutral-950 px-3 py-2">
            <button
              type="button"
              disabled={busy || !action}
              onClick={apply}
              className={PRIMARY}
            >
              {action?.label ?? "Pick a voice"}
            </button>
            <span className="min-w-0 flex-1 text-neutral-500">
              {action &&
                (action.kind === "use"
                  ? "Applied at once, in every issue of the book."
                  : "Made at the voices stop.")}
            </span>
            <button type="button" onClick={close} className={QUIET}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
