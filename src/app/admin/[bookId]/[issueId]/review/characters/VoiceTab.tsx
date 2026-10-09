// The panel's Voice tab (#745, #750): the choices listed from the start as radio-style rows (its voices, a new designed voice, then the other active voices), the current voice marked among them, a preview on each row that has one, and a footer once another row is picked; the rows are one Tab stop and the arrow keys move the pick, and Cancel, confirm or Undo request hands focus back to a row (or to Undo, when the undo fails).
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { VoiceRequest } from "~/lib/cast";
import type { PreviewResult } from "./actions";
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

const PILL =
  "shrink-0 rounded-full border border-neutral-700 px-1.5 text-[11px] leading-4 tracking-[0.04em] text-neutral-400 uppercase";
/** The one pill that stays on the current voice's row when the dot moves to a pick. */
const CURRENT_PILL =
  "shrink-0 rounded-full border border-neutral-400 px-1.5 text-[11px] leading-4 tracking-[0.04em] text-neutral-200 uppercase";

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

/** What a row knows about its preview before anyone clicks Play. */
type PreviewSource =
  | { url: string }
  /** A `voices` row to ask `voicePreview` about on the first click. */
  | { voiceId: string };

/** The answers the tab keeps per voice id, once asked: a URL, or null when the voice has no stored audio. */
type PreviewCache = Record<string, string | null>;

/**
 * A row's Play: plays a URL it already has; otherwise the first click asks
 * `voicePreview` (a loading state meanwhile), and a null answer leaves a
 * muted "no stored audio" mark in its place. The parent owns the one audio
 * element and the cache.
 */
function PreviewPlay({
  name,
  source,
  cache,
  loadingIds,
  tabbable = true,
  onPlay,
  onLookup,
}: {
  name: string;
  source: PreviewSource;
  cache: PreviewCache;
  /** The voice ids a lookup is out for; each keeps its own button busy. */
  loadingIds: ReadonlySet<string>;
  /** False: out of the Tab order, for a row in the radio group that is not its Tab stop. */
  tabbable?: boolean;
  onPlay: (name: string, url: string) => void;
  onLookup: (voiceId: string, name: string) => void;
}) {
  const url = "url" in source ? source.url : cache[source.voiceId];
  if (url === null)
    return (
      <span
        role="img"
        aria-label={`No stored audio for ${name}`}
        title="No stored audio for this voice"
        className="inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-sm text-neutral-700"
      >
        <PlayIcon />
      </span>
    );
  const loading = "voiceId" in source && loadingIds.has(source.voiceId);
  return (
    <button
      type="button"
      disabled={loading}
      tabIndex={tabbable ? undefined : -1}
      aria-busy={loading || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (url) onPlay(name, url);
        else if ("voiceId" in source) onLookup(source.voiceId, name);
      }}
      aria-label={loading ? `Finding audio for ${name}` : `Play ${name}`}
      title={loading ? "Finding audio…" : `Play ${name}`}
      className={`${ICON_BUTTON} ${loading ? "animate-pulse" : ""}`}
    >
      <PlayIcon />
    </button>
  );
}

/**
 * One radio-style row of the list: name in bold, the source in grey, the
 * status pills, and Play when the row has a preview. A click anywhere on the
 * row picks it; the radio button inside carries the keyboard, and only the
 * checked one (with its Play) is in the Tab order. The current voice is a row like the
 * others: the dot rests on it, a pick moves the dot, and its "current" pill
 * stays.
 */
function ChoiceRow({
  name,
  source,
  pills,
  preview,
  cache,
  loadingIds,
  checked,
  tabbable,
  group,
  onPick,
  onPlay,
  onLookup,
}: {
  name: string;
  source: string | null;
  pills: string[];
  /** Null: no Play at all (an appearance, the designed-voice row). */
  preview: PreviewSource | null;
  cache: PreviewCache;
  loadingIds: ReadonlySet<string>;
  checked: boolean;
  /** The group's one Tab stop (roving tabindex): the checked row, or the first row when none is checked. */
  tabbable: boolean;
  /** The radio group's `name`. */
  group: string;
  onPick: () => void;
  onPlay: (name: string, url: string) => void;
  onLookup: (voiceId: string, name: string) => void;
}) {
  return (
    <li
      onClick={onPick}
      className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 ${
        checked
          ? "border-neutral-300 bg-neutral-800"
          : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/60"
      }`}
    >
      <button
        type="button"
        role="radio"
        name={group}
        aria-checked={checked}
        tabIndex={tabbable ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          onPick();
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
            checked ? "border-white" : "border-neutral-500"
          }`}
        >
          {checked && <span className="block size-2 rounded-full bg-white" />}
        </span>
        <span className="min-w-0 flex-1 leading-5">
          <span className="block truncate font-medium text-neutral-100">
            {name}
          </span>
          {source && (
            <span className="block truncate text-neutral-500">{source}</span>
          )}
        </span>
        {pills.map((p) => (
          <span key={p} className={p === "current" ? CURRENT_PILL : PILL}>
            {p}
          </span>
        ))}
      </button>
      {preview && (
        <PreviewPlay
          name={name}
          source={preview}
          cache={cache}
          loadingIds={loadingIds}
          tabbable={tabbable}
          onPlay={onPlay}
          onLookup={onLookup}
        />
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
  scope,
  busy,
  onUndo,
  undoRef,
}: {
  card: CharacterCard;
  /** The book and issue, for the link to the voices stop. */
  scope: { bookId: string; issueId: string };
  busy: boolean;
  onUndo: () => void;
  /** Undo, for the tab to focus when a confirm gives the list way to this note, or when an undo fails. */
  undoRef?: React.Ref<HTMLButtonElement>;
}) {
  const request = card.voiceRequest;
  if (!request) return null;
  const voiceLabel =
    card.voice != null &&
    card.name.trim().toLowerCase() === card.voice.name.trim().toLowerCase()
      ? "its current voice"
      : (card.voice?.name ?? "no voice");
  const keeps = (
    <>
      It is made at the{" "}
      <Link
        href={`/admin/${scope.bookId}/${scope.issueId}/review/characters/voices`}
        className="underline hover:text-sky-50"
      >
        voices stop
      </Link>
      ; {card.name} keeps {voiceLabel} until then.
    </>
  );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-sky-400/40 bg-sky-400/5 px-3 py-2 text-[14px]">
      <p className="min-w-0 flex-1 text-sky-100">
        {request.action === "clone" ? (
          <>
            Wants a voice-lab clone: {request.targetName ?? "unknown voice"}.{" "}
            {keeps}
          </>
        ) : (
          <>Wants a new designed voice. {keeps}</>
        )}
      </p>
      <button
        ref={undoRef}
        type="button"
        disabled={busy}
        onClick={onUndo}
        className={BUTTON}
      >
        Undo request
      </button>
    </div>
  );
}

export interface VoiceTabProps {
  card: CharacterCard;
  /** The book and issue: the pending request note links to the voices stop. */
  scope: { bookId: string; issueId: string };
  activeVoices: ActiveVoice[];
  /** A `characters` row, not removed: the tab lists the choices. */
  canChangeVoice: boolean;
  pullNote: string;
  busy: boolean;
  onSetVoice: (voice: ActiveVoice) => void;
  onRequestVoice: (request: VoiceRequest) => void;
  onPickAppearance: (appearanceId: string) => void;
  onCastArchived: (voiceId: string) => void;
  onUndoVoiceRequest: () => void;
  onPreviewVoice: (voiceId: string) => Promise<PreviewResult>;
}

/**
 * The Voice tab: the choices listed from the start, "Its voices", "A new
 * designed voice" and "Other active voices" as radio-style rows (the designed
 * voice sits above the long active list so it is not buried), with the
 * current voice marked among them (the dot rests on it, and it keeps a
 * "current" pill once the dot moves). Picking another row shows a footer:
 * Cancel on the left, one primary button named for the pick on the right,
 * and under them a line on when the pick takes effect. Cancel puts focus on
 * the group's Tab stop, a confirm on the confirmed row (or Undo, when the
 * list gives way to a request), and Undo request on the Tab stop once the
 * list is back (on Undo again when the request stays). A voice with no row
 * of its own (none yet, no audio this run, a borrowed voice that is not
 * active) gets one plain line above the list, and a card that cannot change
 * (removed, or a request pending) gets that line in place of the list; the
 * line has Play when the voice has an id. Play on every `voices` row: a row
 * with a URL of its own (an archived clone's signed clip from the loader, or
 * a `previewUrl` override) plays it at once; otherwise the first click asks
 * `voicePreview` (the source clip signed, else a bubble of this book
 * rendered in that voice), the answer is kept per voice id, and null leaves
 * a "no stored audio" mark. Appearances and the designed-voice row have no
 * Play.
 */
export function VoiceTab({
  card,
  scope,
  activeVoices,
  canChangeVoice,
  pullNote,
  busy,
  onSetVoice,
  onRequestVoice,
  onPickAppearance,
  onCastArchived,
  onUndoVoiceRequest,
  onPreviewVoice,
}: VoiceTabProps) {
  const currentId = card.voice?.uuid ?? null;
  /** The current voice's own entry: marked under "Its voices"; picking it clears the pick. */
  const isCurrent = (p: VoicePick) => p.kind === "voice" && p.id === currentId;
  /** The row picked instead of the current voice; null keeps the dot on the current voice and hides the footer. Nothing is picked on open: the "lab default" pill marks the suggestion. */
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [pull, setPull] = useState<"copied" | "failed" | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [cache, setCache] = useState<PreviewCache>({});
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The voice of the most recent Play click: a lookup that lands for any other voice is kept, not played. */
  const latest = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // On unmount, stop what plays and forget the latest click, so a lookup
  // that lands after the tab closed is cached and never started.
  useEffect(
    () => () => {
      audio.current?.pause();
      latest.current = null;
    },
    [],
  );

  const play = (name: string, url: string) => {
    audio.current?.pause();
    setPlayError(null);
    const a = new Audio(url);
    audio.current = a;
    a.play().catch((err: unknown) => {
      // A play cut short by the next Play rejects with AbortError: not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPlayError(`Could not play ${name}.`);
    });
  };
  /** A row's own URL, played at once; a lookup still out for another voice then keeps its answer quiet. */
  const playRow = (name: string, url: string) => {
    latest.current = null;
    play(name, url);
  };
  /**
   * The first Play on a voice with no URL yet: ask once, keep the answer,
   * and play it only when this is still the most recent click. A failed
   * ask (a refused answer or a transport error) shows one line and leaves
   * the row playable, so the next click asks again.
   */
  const lookup = async (voiceId: string, name: string) => {
    setPlayError(null);
    latest.current = voiceId;
    setLoadingIds((cur) => new Set(cur).add(voiceId));
    let result: PreviewResult;
    try {
      result = await onPreviewVoice(voiceId);
    } catch {
      result = { ok: false, error: `Could not find audio for ${name}.` };
    }
    setLoadingIds((cur) => {
      const next = new Set(cur);
      next.delete(voiceId);
      return next;
    });
    if (!result.ok) {
      // A failure for a voice the user has moved past says nothing.
      if (latest.current === voiceId) setPlayError(result.error);
      return;
    }
    setCache((cur) => ({ ...cur, [voiceId]: result.url }));
    if (result.url && latest.current === voiceId) play(name, result.url);
  };
  /** A row's preview source: its own URL when it has one, else its voice id for the lookup. */
  const sourceOf = (
    voiceId: string,
    previewUrl: string | null | undefined,
  ): PreviewSource =>
    typeof previewUrl === "string" ? { url: previewUrl } : { voiceId };

  const current = card.voice;
  const currentPick = currentId
    ? card.voicePicks.find(
        (p): p is Extract<VoicePick, { kind: "voice" }> =>
          p.kind === "voice" && p.id === currentId,
      )
    : undefined;
  // The current voice is marked where it lives: under "Its voices" when it is
  // one of them, else among the active voices (a borrowed one).
  const others = currentPick
    ? activeVoices.filter((v) => v.id !== currentId)
    : activeVoices;
  const currentInList = !!currentPick || others.some((v) => v.id === currentId);
  /** The list shows for a card that can change and has no request pending. */
  const listed = canChangeVoice && !card.voiceRequest;
  const choices: Choice[] = [
    ...card.voicePicks
      .filter((p) => !isCurrent(p))
      .map((pick): Choice => ({ section: "pick", pick })),
    ...others
      .filter((v) => v.id !== currentId)
      .map((voice): Choice => ({ section: "active", voice })),
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
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the pick clears and the footer unmounts: the confirmed row's radio, or "stop" for the group's Tab stop. */
  const refocus = useRef<HTMLElement | "stop" | null>(null);
  /** The confirmed row's radio, watched until a refresh drops it (a pick or Cancel since does not matter: the fallback only acts on focus left on the body). */
  const confirmed = useRef<HTMLElement | null>(null);
  /** The card Undo request was clicked on, watched until the refresh brings a new one. */
  const undoneFrom = useRef<CharacterCard | null>(null);
  const tabStop = () =>
    listRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]');
  const cancel = () => {
    refocus.current = "stop";
    setPickedKey(null);
  };
  // After the render that clears the pick, since the Tab stop moves in it.
  useEffect(() => {
    const target = refocus.current;
    if (pickedKey || !target) return;
    refocus.current = null;
    (target !== "stop" && target.isConnected ? target : tabStop())?.focus();
  }, [pickedKey]);
  // The refresh lands as a new card: if it dropped the confirmed row and
  // focus fell to the body of a focused page, the list's Tab stop takes it,
  // or Undo on the request the list gave way to. Focus anywhere else is left alone.
  useEffect(() => {
    const row = confirmed.current;
    if (!row || busy || row.isConnected) return;
    confirmed.current = null;
    const active = document.activeElement;
    if (!document.hasFocus() || (active && active !== document.body)) return;
    (tabStop() ?? undoRef.current)?.focus();
  }, [card, busy]);
  // Undo is disabled while it runs, which drops its focus to the body. Busy
  // may clear a render before the refresh lands, so wait for the new card:
  // then focus on the body of a focused page goes to the list's Tab stop, or
  // back to Undo when the request stayed. Focus anywhere else is left alone.
  useEffect(() => {
    const from = undoneFrom.current;
    if (!from || busy || from === card) return;
    undoneFrom.current = null;
    const active = document.activeElement;
    if (!document.hasFocus() || (active && active !== document.body)) return;
    (tabStop() ?? undoRef.current)?.focus();
  }, [card, busy]);
  // The footer is sticky at the panel's bottom, so a pick near the end of the
  // list would sit under it: scroll the panel by the overlap, and only then.
  useEffect(() => {
    if (!pickedKey) return;
    const row = listRef.current
      ?.querySelector('[role="radio"][aria-checked="true"]')
      ?.closest("li");
    const footer = footerRef.current;
    if (!row || !footer) return;
    const overlap =
      row.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
    if (overlap <= 0) return;
    let scroller: HTMLElement | null = row.parentElement;
    while (
      scroller &&
      !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    scroller?.scrollBy({ top: overlap + 8, behavior: "smooth" });
  }, [pickedKey]);
  /** With nothing checked (the current voice has no row, nothing picked), the first row is the Tab stop. */
  const noneChecked = !picked && !currentInList;
  const firstKey = card.voicePicks[0]
    ? `pick:${card.voicePicks[0].id}`
    : "design";
  /**
   * The arrow keys move the pick like a native radio group: Down/Right to the
   * next row, Up/Left to the previous, wrapping. The target is focused and
   * clicked, so an arrow pick runs the row's own `onPick`. Keys on anything
   * but a radio (a row's Play) are left alone.
   */
  const onArrow = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step) return;
    const radios = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [],
    );
    const from = radios.indexOf(e.target as HTMLElement);
    if (from < 0) return;
    e.preventDefault();
    const to = radios[(from + step + radios.length) % radios.length];
    to?.focus();
    to?.click();
  };
  const apply = () => {
    if (!picked || !action) return;
    // The dot goes back to the current voice, which the callback is about to
    // change or keep; focus stays on the confirmed row, where the dot lands.
    const row = listRef.current?.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    refocus.current = row ?? "stop";
    confirmed.current = row ?? null;
    setPickedKey(null);
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

  // The plain line: VoiceLine names whose the voice is when borrowed;
  // otherwise its own entry says the work it was cloned from, or that it is designed.
  const currentSource =
    current && !current.borrowedFrom && currentPick
      ? (currentPick.work ?? "Designed voice")
      : null;
  const currentPreview = current?.uuid
    ? sourceOf(current.uuid, current.previewUrl)
    : null;
  const line = !listed || !currentInList;

  return (
    <div className="text-[14px]">
      {line && (
        <div className="flex min-h-8 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            <VoiceLine card={card} />
            {currentSource && (
              <span className="text-neutral-500">, {currentSource}</span>
            )}
          </span>
          {current && currentPreview && (
            <PreviewPlay
              name={current.name}
              source={currentPreview}
              cache={cache}
              loadingIds={loadingIds}
              onPlay={playRow}
              onLookup={lookup}
            />
          )}
        </div>
      )}

      {card.voiceRequest && (
        <VoiceRequestNote
          card={card}
          scope={scope}
          busy={busy}
          onUndo={() => {
            undoneFrom.current = card;
            onUndoVoiceRequest();
          }}
          undoRef={undoRef}
        />
      )}

      {listed && (
        <div
          ref={listRef}
          role="radiogroup"
          aria-label={`Voice for ${card.name}`}
          onKeyDown={onArrow}
          className={`space-y-4 ${line ? "mt-4" : ""}`}
        >
          <section>
            <SectionHeading>Its voices</SectionHeading>
            {card.voicePicks.length === 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-neutral-300">No voice-lab clone on file.</p>
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
                  const isThis = isCurrent(p);
                  const checked = isThis ? !picked : pickedKey === key;
                  const pills =
                    p.kind === "voice"
                      ? isThis
                        ? // The one pill that says it all: a current voice is active and in this book.
                          ["current"]
                        : [
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
                      preview={
                        p.kind !== "voice"
                          ? null
                          : p.status === "archived" && !isThis
                            ? // An archived clone plays its signed clip or nothing: the "no clip link" pill says which.
                              p.clipUrl
                              ? { url: p.clipUrl }
                              : null
                            : // The current voice, whatever its status, asks `voicePreview` when it has no clip: a bubble of this book is rendered in it.
                              sourceOf(p.id, p.clipUrl)
                      }
                      cache={cache}
                      loadingIds={loadingIds}
                      checked={checked}
                      tabbable={checked || (noneChecked && key === firstKey)}
                      group={group}
                      onPick={() => setPickedKey(isThis ? null : key)}
                      onPlay={playRow}
                      onLookup={lookup}
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
                preview={null}
                cache={cache}
                loadingIds={loadingIds}
                checked={pickedKey === "design"}
                tabbable={
                  pickedKey === "design" ||
                  (noneChecked && firstKey === "design")
                }
                group={group}
                onPick={() => setPickedKey("design")}
                onPlay={playRow}
                onLookup={lookup}
              />
            </ul>
          </section>

          <section>
            <SectionHeading>Other active voices</SectionHeading>
            {others.length === 0 ? (
              <p className="text-neutral-400">No other active voice.</p>
            ) : (
              <ul className="space-y-1">
                {others.map((v) => {
                  const key = `active:${v.id}`;
                  const isThis = v.id === currentId;
                  const checked = isThis ? !picked : pickedKey === key;
                  return (
                    <ChoiceRow
                      key={key}
                      name={v.name}
                      source={
                        isThis && current?.borrowedFrom
                          ? `${current.borrowedFrom}'s voice`
                          : null
                      }
                      pills={isThis ? ["current"] : ["active"]}
                      preview={sourceOf(v.id, v.previewUrl)}
                      cache={cache}
                      loadingIds={loadingIds}
                      checked={checked}
                      tabbable={checked}
                      group={group}
                      onPick={() => setPickedKey(isThis ? null : key)}
                      onPlay={playRow}
                      onLookup={lookup}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {playError && <p className="mt-3 text-amber-300">{playError}</p>}

      {listed && picked && action && (
        <div
          ref={footerRef}
          className="sticky bottom-0 -mx-4 mt-3 -mb-4 border-t border-neutral-800 bg-neutral-950 px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={cancel} className={QUIET}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={apply}
              className={PRIMARY}
            >
              {action.label}
            </button>
          </div>
          <p className="mt-1.5 text-neutral-500">
            {action.kind === "use"
              ? "Applied at once, in every issue of the book."
              : "Made at the voices stop."}
          </p>
        </div>
      )}
    </div>
  );
}
