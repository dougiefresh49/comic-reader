// The character panel: the open card in a right column, its actions grouped by job (#743).
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { VoiceRequest } from "~/lib/cast";
import type { NameTarget } from "./actions";
import { FacesTab } from "./FacesTab";
import { MoveDialog } from "./MoveDialog";
import {
  ConfirmDialog,
  FaceCrop,
  ICON_BUTTON,
  INPUT,
  PRIMARY,
  PageWithBox,
  QUIET,
  QUIET_DANGER,
  bestFace,
  facesLine,
} from "./shared";
import type {
  ActiveVoice,
  CharacterCard,
  FaceView,
  KnownCharacter,
  PageView,
} from "./types";
import { VoiceTab } from "./VoiceTab";

const GROUP_LABEL: Record<CharacterCard["group"], string> = {
  here: "In this issue",
  before: "Cast before, no sign here",
  role: "Role",
};

export type PanelTab = "faces" | "voice";

const TABS: { key: PanelTab; label: string }[] = [
  { key: "faces", label: "Faces" },
  { key: "voice", label: "Voice" },
];

/**
 * The two jobs as text tabs under the identity header: the open one white
 * with a 2px underline, the other grey, a hairline under the row. Left and
 * Right move between them when a tab has focus.
 */
function TabRow({
  tab,
  faces,
  idBase,
  onChange,
}: {
  tab: PanelTab;
  /** Shown after the Faces label: "Faces 6". */
  faces: number;
  idBase: string;
  onChange: (tab: PanelTab) => void;
}) {
  const refs = useRef<Record<PanelTab, HTMLButtonElement | null>>({
    faces: null,
    voice: null,
  });
  const step = (from: PanelTab, dir: 1 | -1) => {
    const i = TABS.findIndex((t) => t.key === from);
    const next = TABS[(i + dir + TABS.length) % TABS.length]!.key;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Jobs"
      className="flex gap-5 border-b border-neutral-800 px-4"
    >
      {TABS.map((t) => {
        const selected = t.key === tab;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                step(t.key, 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                step(t.key, -1);
              }
            }}
            className={`-mb-px flex h-10 items-center gap-1.5 border-b-2 text-[14px] ${
              selected
                ? "border-white font-medium text-white"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t.label}
            {t.key === "faces" && (
              <span
                className={selected ? "text-neutral-400" : "text-neutral-500"}
              >
                {faces}
              </span>
            )}
          </button>
        );
      })}
    </div>
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

function PencilIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
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
      className="fixed inset-0 z-[35] flex items-center justify-center bg-black/70 p-6"
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
        className="absolute top-16 right-4 inline-flex size-9 items-center justify-center rounded-sm bg-neutral-950/80 text-neutral-300 hover:bg-neutral-800 hover:text-white"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export interface CharacterPanelProps {
  card: CharacterCard;
  pages: Map<number, PageView>;
  /** Every card of the issue: the move dialog's grid. */
  cards: CharacterCard[];
  known: KnownCharacter[];
  activeVoices: ActiveVoice[];
  /** A `characters` row, not removed: the Voice tab gets the Change control. */
  canChangeVoice: boolean;
  pullNote: string;
  busy: boolean;
  /** The open tab, held by the screen so it survives a swap to another card. A role card shows Voice whatever it says. */
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onAddBack: () => void;
  onConfirm: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  /** A selection from select mode, moved in one action. */
  onMoveMany: (faces: FaceView[], target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
  onSetVoice: (voice: ActiveVoice) => void;
  onRequestVoice: (request: VoiceRequest) => void;
  onPickAppearance: (appearanceId: string) => void;
  onCastArchived: (voiceId: string) => void;
  onUndoVoiceRequest: () => void;
}

/**
 * The open card, in a column to the right of the grid: the identity header
 * (with Rename and Remove from this issue), then Faces and Voice as tabs
 * (FacesTab, VoiceTab). Mounted per card (the screen keys it by card id), so
 * a swap starts the local state over, select mode included; the chosen tab
 * lives in the screen and survives.
 */
export function CharacterPanel({
  card,
  pages,
  cards,
  known,
  activeVoices,
  canChangeVoice,
  pullNote,
  busy,
  tab,
  onTabChange,
  onClose,
  onRename,
  onRemove,
  onAddBack,
  onConfirm,
  onMove,
  onMoveMany,
  onReject,
  onSetVoice,
  onRequestVoice,
  onPickAppearance,
  onCastArchived,
  onUndoVoiceRequest,
}: CharacterPanelProps) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(card.name);
  const [shownId, setShownId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  /** The faces the move dialog is open for; null when it is closed. */
  const [moving, setMoving] = useState<FaceView[] | null>(null);
  /** The control that opened the move dialog, for focus when it closes. */
  const moveOpener = useRef<HTMLElement | null>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const idBase = useId();
  const shown = card.faces.find((f) => f.id === shownId) ?? null;
  const portrait = useMemo(
    () => bestFace(card.faces, pages),
    [card.faces, pages],
  );
  // A role has no faces, so it shows Voice whatever the screen's tab says, and leaves it alone.
  const isRole = card.group === "role";
  const shownTab: PanelTab = isRole ? "voice" : tab;

  const closeMove = useCallback(() => {
    setMoving(null);
    moveOpener.current?.focus();
  }, []);

  // The open panel owns Escape, innermost first: the move dialog, select
  // mode, the Remove confirm, the page preview, an open Rename, then the
  // panel. A focused Rename field stops the key itself before it reaches
  // the window.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (moving) closeMove();
      else if (selecting) setSelecting(false);
      else if (confirming) {
        setConfirming(false);
        removeRef.current?.focus();
      } else if (shown) setShownId(null);
      else if (renaming) {
        setRenaming(false);
        setDraft(card.name);
      } else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    moving,
    selecting,
    confirming,
    shown,
    renaming,
    card.name,
    onClose,
    closeMove,
  ]);

  const voiceContent = (
    <VoiceTab
      card={card}
      activeVoices={activeVoices}
      canChangeVoice={canChangeVoice}
      pullNote={pullNote}
      busy={busy}
      onSetVoice={onSetVoice}
      onRequestVoice={onRequestVoice}
      onPickAppearance={onPickAppearance}
      onCastArchived={onCastArchived}
      onUndoVoiceRequest={onUndoVoiceRequest}
    />
  );

  return (
    <>
      <aside
        aria-label={card.name}
        className="fixed top-12 right-0 bottom-0 z-20 flex w-[440px] max-w-full shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 lg:sticky lg:right-auto lg:bottom-auto lg:h-[calc(100vh-3rem)]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4">
          {/* The name stays in view however far the body scrolls. */}
          <div className="flex min-w-0 items-baseline gap-2 text-[14px]">
            <span className="truncate font-medium text-neutral-100">
              {card.name}
            </span>
            <span className="shrink-0 text-neutral-500">
              {GROUP_LABEL[card.group]}
            </span>
          </div>
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
          {/* Identity: who this is, and whether it is in this issue. */}
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-[18px] font-semibold text-neutral-50">
                    {card.name}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(card.name);
                      setRenaming(true);
                    }}
                    aria-label="Rename"
                    title="Rename"
                    className={ICON_BUTTON}
                  >
                    <PencilIcon />
                  </button>
                  <span className="ml-1 text-neutral-500">{card.id}</span>
                </div>
              )}
              {card.wikiNames.length > 0 && (
                <div className="mt-1 text-neutral-500">
                  Wiki: {card.wikiNames.join(", ")}
                </div>
              )}
              <div className="mt-1 text-neutral-400">
                {isRole ? "Role, no faces" : facesLine(card.faces)}
              </div>
              {card.removed && (
                <div className="mt-1 text-amber-300">Out of this issue</div>
              )}
              {/* The header's last line: membership, a text button (owner call, decision 430 and PR #744). */}
              <div className="mt-2 -ml-2">
                {card.removed ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onAddBack}
                    className={`${QUIET} h-7`}
                  >
                    Add back to this issue
                  </button>
                ) : (
                  <button
                    ref={removeRef}
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(true)}
                    className={`${QUIET_DANGER} h-7`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {!isRole && (
            <TabRow
              tab={tab}
              faces={card.faces.length}
              idBase={idBase}
              onChange={onTabChange}
            />
          )}

          {shownTab === "faces" ? (
            <div
              role="tabpanel"
              id={`${idBase}-panel-faces`}
              aria-labelledby={`${idBase}-tab-faces`}
              className="px-4 py-4"
            >
              <FacesTab
                card={card}
                pages={pages}
                busy={busy}
                selecting={selecting}
                onSelectingChange={setSelecting}
                shownId={shownId}
                onShow={(id) => setShownId((cur) => (cur === id ? null : id))}
                onConfirm={onConfirm}
                onMoveRequest={(faces, opener) => {
                  moveOpener.current = opener;
                  setMoving(faces);
                }}
                onReject={onReject}
              />
            </div>
          ) : isRole ? (
            <section
              aria-label="Voice"
              className="border-t border-neutral-800 px-4 py-4"
            >
              {voiceContent}
            </section>
          ) : (
            <div
              role="tabpanel"
              id={`${idBase}-panel-voice`}
              aria-labelledby={`${idBase}-tab-voice`}
              className="px-4 py-4"
            >
              {voiceContent}
            </div>
          )}
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

      {confirming && (
        <ConfirmDialog
          title={`Remove ${card.name} from this issue?`}
          body={`${card.name} leaves this issue's cast and keeps its voice, so Add back restores it. Its bubbles and faces here are not changed.`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={() => {
            setConfirming(false);
            onRemove();
          }}
          onCancel={() => {
            setConfirming(false);
            removeRef.current?.focus();
          }}
        />
      )}

      {moving && (
        <MoveDialog
          card={card}
          faces={moving}
          cards={cards}
          known={known}
          pages={pages}
          busy={busy}
          onConfirm={(target, name) => {
            const faces = moving;
            closeMove();
            if (faces.length === 1) onMove(faces[0]!, target, name);
            else onMoveMany(faces, target, name);
          }}
          onCancel={closeMove}
        />
      )}
    </>
  );
}
