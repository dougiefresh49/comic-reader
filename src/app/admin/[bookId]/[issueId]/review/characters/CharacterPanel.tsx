// The character panel: the open card in a right column, its actions grouped by job (#743).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceRequest } from "~/lib/cast";
import type { NameTarget } from "./actions";
import {
  BUTTON,
  DANGER,
  FaceCrop,
  FaceTiles,
  INPUT,
  PRIMARY,
  PageWithBox,
  QUIET,
  VoiceLine,
  bestFace,
  facesLine,
} from "./shared";
import type {
  ActiveVoice,
  CharacterCard,
  FaceView,
  KnownCharacter,
  PageView,
  VoicePick,
} from "./types";

type VoiceOption = "active" | "clone" | "design";

const VOICE_OPTIONS: { key: VoiceOption | "keep"; label: string }[] = [
  { key: "keep", label: "Keep" },
  { key: "active", label: "Another active voice" },
  { key: "clone", label: "Its voices" },
  { key: "design", label: "A new designed voice" },
];

/** What the primary button under "Its voices" does for the chosen entry. */
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

const PICK_STATUS: Record<string, string> = {
  archived: "archived",
  needs_clip: "needs a clip",
};

/** The opened card's Change control: keep, another active voice (applied at once), one of its own voices or appearances, or a request for a design. */
function VoiceChoices({
  card,
  activeVoices,
  pullNote,
  busy,
  onKeep,
  onSetVoice,
  onRequest,
  onPickAppearance,
  onCastArchived,
}: {
  card: CharacterCard;
  activeVoices: ActiveVoice[];
  pullNote: string;
  busy: boolean;
  onKeep: () => void;
  onSetVoice: (voice: ActiveVoice) => void;
  onRequest: (request: VoiceRequest) => void;
  onPickAppearance: (appearanceId: string) => void;
  onCastArchived: (voiceId: string) => void;
}) {
  const [option, setOption] = useState<VoiceOption | null>(null);
  const others = activeVoices.filter((v) => v.id !== card.voice?.uuid);
  const [voiceId, setVoiceId] = useState("");
  const [pickId, setPickId] = useState(
    card.voicePicks.find((p) => p.kind === "voice" && p.startingPick)?.id ?? "",
  );
  const [pull, setPull] = useState<"copied" | "failed" | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const play = (name: string, clipUrl: string) => {
    audio.current?.pause();
    setPlayError(null);
    const a = new Audio(clipUrl);
    audio.current = a;
    a.play().catch(() => setPlayError(`Could not play ${name}.`));
  };
  const chosen = others.find((v) => v.id === voiceId);
  const picked = card.voicePicks.find((p) => p.id === pickId);
  const pickedAction = picked ? pickAction(picked) : null;
  const usePick = () => {
    if (!picked || !pickedAction) return;
    if (picked.kind === "appearance") return onPickAppearance(picked.id);
    switch (pickedAction.kind) {
      case "use":
        return onSetVoice({ id: picked.id, name: picked.name });
      case "cast":
        return onCastArchived(picked.id);
      case "clone":
        return onRequest({ action: "clone", targetVoiceUuid: picked.id });
      case "clip":
        return picked.appearanceId && onPickAppearance(picked.appearanceId);
      case "design":
        return onRequest({ action: "design" });
    }
  };

  return (
    <div className="mt-3 max-w-2xl rounded-md border border-neutral-700 bg-neutral-950/60 p-3">
      <div
        role="radiogroup"
        aria-label={`Voice for ${card.name}`}
        className="flex flex-wrap gap-2"
      >
        {VOICE_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={option === o.key}
            onClick={() => (o.key === "keep" ? onKeep() : setOption(o.key))}
            className={
              option === o.key
                ? `${BUTTON} border-neutral-300 bg-neutral-800 text-white`
                : BUTTON
            }
          >
            {o.label}
          </button>
        ))}
      </div>

      {option === "active" && (
        <div className="mt-3">
          {others.length === 0 ? (
            <p className="text-neutral-400">No other active voice.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                aria-label="Active voice"
                className={`${INPUT} w-auto max-w-xs`}
              >
                <option value="">Pick a voice…</option>
                {others.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !chosen}
                onClick={() => chosen && onSetVoice(chosen)}
                className={PRIMARY}
              >
                Use this voice
              </button>
            </div>
          )}
          <p className="mt-2 text-neutral-500">
            Applied at once, in every issue of the book.
          </p>
        </div>
      )}

      {option === "clone" && (
        <div className="mt-3">
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
            <>
              <ul className="space-y-1">
                {card.voicePicks.map((p) => {
                  const name = p.kind === "voice" ? p.name : card.name;
                  return (
                    <li key={p.id} className="flex items-center gap-3">
                      <label className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2">
                        <input
                          type="radio"
                          name={`pick-${card.id}`}
                          value={p.id}
                          checked={pickId === p.id}
                          onChange={() => setPickId(p.id)}
                        />
                        <span className="truncate text-neutral-100">
                          {name}
                        </span>
                        {p.work && (
                          <span className="truncate text-neutral-400">
                            {p.work}
                            {p.kind === "appearance" &&
                              p.voiceActor &&
                              `, ${p.voiceActor}`}
                          </span>
                        )}
                        {p.kind === "voice" && p.startingPick && (
                          <span className="text-neutral-500">lab default</span>
                        )}
                        {p.kind === "voice" && PICK_STATUS[p.status] && (
                          <span className="text-neutral-500">
                            {PICK_STATUS[p.status]}
                          </span>
                        )}
                      </label>
                      {p.kind === "voice" &&
                        p.status === "archived" &&
                        (p.clipUrl ? (
                          <button
                            type="button"
                            onClick={() => play(p.name, p.clipUrl!)}
                            className={QUIET}
                            aria-label={`Play ${p.name}`}
                          >
                            Play
                          </button>
                        ) : (
                          <span className="text-neutral-600">No clip link</span>
                        ))}
                    </li>
                  );
                })}
              </ul>
              {playError && <p className="mt-1 text-amber-300">{playError}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy || !pickedAction}
                  onClick={usePick}
                  className={PRIMARY}
                >
                  {pickedAction?.label ?? "Request this clone"}
                </button>
                <span className="text-neutral-500">
                  {pickedAction?.kind === "use"
                    ? "Applied at once, in every issue of the book."
                    : "Made at the voices stop."}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {option === "design" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRequest({ action: "design" })}
            className={PRIMARY}
          >
            Request a new designed voice
          </button>
          <span className="text-neutral-500">Made at the voices stop.</span>
        </div>
      )}
    </div>
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
    <div className="mt-3 flex max-w-2xl flex-wrap items-center gap-3 rounded-md border border-sky-400/40 bg-sky-400/5 px-3 py-2">
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

const GROUP_LABEL: Record<CharacterCard["group"], string> = {
  here: "In this issue",
  before: "Cast before, no sign here",
  role: "Role",
};

/** One job's block: a small title, its block-wide action on the right, then the content. */
function Block({
  title,
  action,
  quiet = false,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  /** The destructive block at the bottom: set apart on a darker surface. */
  quiet?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`border-t border-neutral-800 px-4 py-4 ${quiet ? "bg-neutral-900/50" : ""}`}
    >
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" x2="6" y1="6" y2="18" />
      <line x1="6" x2="18" y1="6" y2="18" />
    </svg>
  );
}

/** Show: the page with the face boxed, large over the screen. Click outside, the X or Escape closes it. */
function PagePreview({
  face,
  pages,
  label,
  onClose,
}: {
  face: FaceView;
  pages: Map<number, PageView>;
  label: string;
  onClose: () => void;
}) {
  const page = pages.get(face.page);
  if (!page) return null;
  return (
    <div
      role="dialog"
      aria-label={`Page ${face.page}, ${label}`}
      onClick={onClose}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-w-full"
        style={{ width: `min(92vw, calc(86vh * ${page.width / page.height}))` }}
      >
        <PageWithBox
          face={face}
          pages={pages}
          label={label}
          frameClass="max-h-[86vh]"
        />
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the page"
        className="absolute top-4 right-4 inline-flex size-9 items-center justify-center rounded-sm bg-neutral-950/80 text-neutral-300 hover:bg-neutral-800 hover:text-white"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export interface CharacterPanelProps {
  card: CharacterCard;
  pages: Map<number, PageView>;
  known: KnownCharacter[];
  activeVoices: ActiveVoice[];
  /** A `characters` row, not removed: the Voice block gets the Change control. */
  canChangeVoice: boolean;
  pullNote: string;
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onAddBack: () => void;
  onConfirm: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
  onSetVoice: (voice: ActiveVoice) => void;
  onRequestVoice: (request: VoiceRequest) => void;
  onPickAppearance: (appearanceId: string) => void;
  onCastArchived: (voiceId: string) => void;
  onUndoVoiceRequest: () => void;
}

/**
 * The open card, in a column to the right of the grid: identity, then Faces,
 * then Voice, then the issue membership set apart at the bottom. Mounted per
 * card (the screen keys it by card id), so a swap starts the state over.
 */
export function CharacterPanel({
  card,
  pages,
  known,
  activeVoices,
  canChangeVoice,
  pullNote,
  busy,
  onClose,
  onRename,
  onRemove,
  onAddBack,
  onConfirm,
  onMove,
  onReject,
  onSetVoice,
  onRequestVoice,
  onPickAppearance,
  onCastArchived,
  onUndoVoiceRequest,
}: CharacterPanelProps) {
  const [renaming, setRenaming] = useState(false);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState(card.name);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = card.faces.find((f) => f.id === shownId) ?? null;
  const portrait = useMemo(
    () => bestFace(card.faces, pages),
    [card.faces, pages],
  );
  const unconfirmed =
    card.faces.filter((f) => f.exemplar && !f.exemplar.confirmed).length +
    card.looseExemplars.filter((e) => !e.confirmed).length;
  const exemplars =
    card.faces.filter((f) => f.exemplar).length + card.looseExemplars.length;

  // The open panel owns Escape, innermost first: the page preview, then an
  // open Rename, then the panel. A focused Rename or Move field stops the
  // key itself before it reaches the window.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (shown) setShownId(null);
      else if (renaming) {
        setRenaming(false);
        setDraft(card.name);
      } else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown, renaming, card.name, onClose]);

  return (
    <>
      <aside
        aria-label={card.name}
        className="fixed top-12 right-0 bottom-0 z-20 flex w-[440px] max-w-full shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 lg:sticky lg:right-auto lg:bottom-auto lg:h-[calc(100vh-3rem)]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4">
          <span className="truncate text-[14px] text-neutral-400">
            {GROUP_LABEL[card.group]}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Identity: who this is. */}
          <div className="flex items-start gap-4 px-4 py-4">
            <FaceCrop
              face={portrait}
              pages={pages}
              alt={card.name}
              className="size-24 shrink-0 rounded-md"
            />
            <div className="min-w-0 flex-1 text-[14px]">
              {renaming ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setRenaming(false);
                    if (draft.trim() && draft.trim() !== card.name)
                      onRename(draft);
                  }}
                >
                  <input
                    value={draft}
                    autoFocus
                    aria-label="Display name"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(false);
                        setDraft(card.name);
                      }
                    }}
                    className={`${INPUT} min-w-[160px] flex-1 text-[16px]`}
                  />
                  <button type="submit" className={PRIMARY} disabled={busy}>
                    Save
                  </button>
                  <button
                    type="button"
                    className={QUIET}
                    onClick={() => {
                      setRenaming(false);
                      setDraft(card.name);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-[18px] font-semibold text-neutral-50">
                    {card.name}
                  </h2>
                  <span className="text-neutral-500">{card.id}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(card.name);
                      setRenaming(true);
                    }}
                    className={`${QUIET} h-7`}
                  >
                    Rename
                  </button>
                </div>
              )}
              {card.wikiNames.length > 0 && (
                <div className="mt-1 text-neutral-500">
                  Wiki: {card.wikiNames.join(", ")}
                </div>
              )}
              <div className="mt-1 text-neutral-400">
                {card.group === "role"
                  ? "Role, no faces"
                  : facesLine(card.faces)}
                {exemplars > 0 && (
                  <>
                    {" · "}
                    {exemplars} {exemplars === 1 ? "exemplar" : "exemplars"}
                    {unconfirmed > 0
                      ? `, ${unconfirmed} unconfirmed`
                      : ", all confirmed"}
                  </>
                )}
              </div>
            </div>
          </div>

          {card.group !== "role" && (
            <Block
              title="Faces"
              action={
                card.faces.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onConfirm}
                    className={PRIMARY}
                    title="Confirm this character's exemplars from this issue, so the matcher uses them on later issues"
                  >
                    Faces are right
                  </button>
                )
              }
            >
              <FaceTiles
                faces={card.faces}
                loose={card.looseExemplars}
                pages={pages}
                label={card.name}
                known={known}
                busy={busy}
                shownId={shownId}
                onShow={(id) => setShownId((cur) => (cur === id ? null : id))}
                onMove={onMove}
                onReject={onReject}
              />
            </Block>
          )}

          <Block title="Voice">
            <div className="flex min-h-7 items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <VoiceLine card={card} />
              </span>
              {canChangeVoice && !card.voiceRequest && !changing && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setChanging(true)}
                  className={`${QUIET} h-7`}
                >
                  Change
                </button>
              )}
            </div>
            {card.voiceRequest ? (
              <VoiceRequestNote
                card={card}
                busy={busy}
                onUndo={() => {
                  setChanging(canChangeVoice);
                  onUndoVoiceRequest();
                }}
              />
            ) : (
              canChangeVoice &&
              changing && (
                <VoiceChoices
                  card={card}
                  activeVoices={activeVoices}
                  pullNote={pullNote}
                  busy={busy}
                  onKeep={() => setChanging(false)}
                  onSetVoice={(v) => {
                    setChanging(false);
                    onSetVoice(v);
                  }}
                  onRequest={(request) => {
                    setChanging(false);
                    onRequestVoice(request);
                  }}
                  onPickAppearance={(appearanceId) => {
                    setChanging(false);
                    onPickAppearance(appearanceId);
                  }}
                  onCastArchived={(voiceId) => {
                    setChanging(false);
                    onCastArchived(voiceId);
                  }}
                />
              )
            )}
          </Block>

          <Block title="Membership" quiet>
            <div className="flex items-center justify-between gap-3">
              {card.removed ? (
                <span className="text-amber-300">Out of this issue</span>
              ) : (
                <span className="text-neutral-400">
                  Counted in this issue&apos;s cast
                </span>
              )}
              {card.removed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onAddBack}
                  className={BUTTON}
                >
                  Add back to this issue
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRemove}
                  className={DANGER}
                >
                  Remove from this issue
                </button>
              )}
            </div>
          </Block>
        </div>
      </aside>

      {shown && (
        <PagePreview
          face={shown}
          pages={pages}
          label={card.name}
          onClose={() => setShownId(null)}
        />
      )}
    </>
  );
}
