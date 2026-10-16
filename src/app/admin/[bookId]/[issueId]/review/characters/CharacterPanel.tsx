// The character panel (#787): the open card in a right column. The header
// names it (Rename is staged) and can say "this is character X" (#846, saves
// at once), lists its aliases, with add, remove and scope (#879, #891, saves
// at once), and sets Form of (#891, saves at once). Voice and Faces are
// tabs, and the footer has the card's quick actions.
// Voice changes are staged; the Faces work saves as it is done, as it always
// has. In faces mode (#854) it is Faces only.
"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { isRoleId } from "~/lib/cast";
import type { AliasEntry } from "~/lib/character-aliases";
import { slugify } from "~/lib/character-id";
import { useTabTrap } from "~/hooks/useTabTrap";
import {
  addCharacterAlias,
  removeCharacterAlias,
  setCharacterAliasScope,
  setFormOf,
  type ActionResult,
  type AliasScope,
  type NameTarget,
} from "./actions";
import { WandIcon } from "./design-sheet/DesignSheet";
import { FacesTab } from "./FacesTab";
import { MoveDialog } from "./MoveDialog";
import { Revoice } from "./Revoice";
import { matchesName, PageWithBox } from "./shared";
import type { CardState } from "./staging";
import type {
  CharacterCard,
  FaceView,
  KnownCharacter,
  PageView,
  RevoicePlan,
} from "./types";
import {
  BTN,
  BTN_GHOST,
  BTN_SMALL,
  FOCUS,
  Icon,
  MENU_ITEM,
  Popover,
  Portrait,
} from "./ui";
import { speaksAsBase, VoiceTab, type VoiceTabProps } from "./VoiceTab";

export type PanelTab = "voice" | "faces";

const TABS: { key: PanelTab; label: string }[] = [
  { key: "voice", label: "Voice" },
  { key: "faces", label: "Faces" },
];

/**
 * The two jobs as text tabs under the identity header: the open one white
 * with a 2px underline, the other grey, a hairline under the row. Left and
 * Right move between them when a tab has focus.
 */
function TabRow({
  tabs,
  tab,
  faces,
  idBase,
  onChange,
}: {
  tabs: typeof TABS;
  tab: PanelTab;
  /** Shown after the Faces label: "Faces 6". */
  faces: number;
  idBase: string;
  onChange: (tab: PanelTab) => void;
}) {
  const refs = useRef<Record<PanelTab, HTMLButtonElement | null>>({
    voice: null,
    faces: null,
  });
  const step = (from: PanelTab, dir: 1 | -1) => {
    const i = tabs.findIndex((t) => t.key === from);
    const next = tabs[(i + dir + tabs.length) % tabs.length]!.key;
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Jobs"
      className="flex gap-5 border-b border-neutral-800 px-4"
    >
      {tabs.map((t) => {
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
            className={`-mb-px flex h-9 ${FOCUS} items-center gap-1.5 border-b-2 text-[14px] ${
              selected
                ? "border-amber-400 font-medium text-white"
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

/**
 * A header write's state: `act` runs one server action, shows its answer
 * in the status line, and refreshes the page so the board, + Add and Move
 * read the change.
 */
function useSave() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const act = (
    work: () => Promise<ActionResult>,
    onOk?: () => void,
    onFail?: () => void,
  ) => {
    setNote(null);
    startTransition(async () => {
      try {
        const r = await work();
        if (r.ok) onOk?.();
        else onFail?.();
        setNote(
          r.ok
            ? { text: r.message, error: false }
            : { text: r.error, error: true },
        );
      } catch (err) {
        setNote({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
        onFail?.();
      }
      router.refresh();
    });
  };
  return { pending, note, setNote, act };
}

/** A header write's status line. Always mounted, so a screen reader hears what lands in it. */
function SaveNote({
  pending,
  note,
}: {
  pending: boolean;
  note: { text: string; error: boolean } | null;
}) {
  return (
    <p
      role="status"
      className={`mt-1 text-[12px] empty:hidden ${
        !pending && note?.error ? "text-red-400" : "text-neutral-400"
      }`}
    >
      {pending ? "Saving…" : note?.text}
    </p>
  );
}

const SCOPE_WORDS: Record<AliasScope, string> = {
  book: "this book",
  global: "every book",
};

/**
 * The header's aliases (#879): each one a chip with a remove button and its
 * scope, "this book" or "every book", which is a button that switches it
 * (#891). Then + Alias, whose draft picks This book (the default) or Every
 * book. Every write saves at once and refreshes the page, so the board,
 * + Add and Move read the new names. With no aliases only + Alias shows.
 */
function AliasList({
  characterId,
  rows,
  bookId,
  issueId,
}: {
  characterId: string;
  rows: AliasEntry[];
  bookId: string;
  issueId: string;
}) {
  const { pending, note, setNote, act } = useSave();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [addScope, setAddScope] = useState<AliasScope>("book");
  const addRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Focus goes back to + Alias once the running write ends. */
  const refocus = useRef(false);
  const scope = { bookId, issueId };

  useEffect(() => {
    if (pending || !refocus.current) return;
    refocus.current = false;
    addRef.current?.focus();
  }, [pending, adding]);

  const closeAdd = () => {
    setAdding(false);
    setDraft("");
    setAddScope("book");
    refocus.current = true;
  };

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {rows.length > 0 && (
          <>
            <span aria-hidden className="mr-0.5 text-[12px] text-neutral-500">
              Aliases
            </span>
            <ul aria-label="Aliases" className="contents">
              {rows.map((row) => {
                const other: AliasScope =
                  row.scope === "book" ? "global" : "book";
                // The name holds the visible scope, then what a click does.
                const move = `${row.alias}: ${SCOPE_WORDS[row.scope]}. Make it ${SCOPE_WORDS[other]}`;
                return (
                  <li
                    key={row.id}
                    className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800 py-0.5 pr-0.5 pl-2 text-[12px] leading-4 text-neutral-200"
                  >
                    {/* Wraps rather than cutting off, so the whole alias reads. */}
                    <span className="min-w-0 break-words">{row.alias}</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        act(() =>
                          setCharacterAliasScope({
                            scope,
                            characterId,
                            aliasId: row.id,
                            aliasScope: other,
                          }),
                        )
                      }
                      aria-label={move}
                      title={move}
                      className={`shrink-0 rounded px-0.5 text-[11px] whitespace-nowrap text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`}
                    >
                      · {SCOPE_WORDS[row.scope]}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        // The chip goes, so focus lands on + Alias either way.
                        refocus.current = true;
                        act(() =>
                          removeCharacterAlias({
                            scope,
                            characterId,
                            aliasId: row.id,
                          }),
                        );
                      }}
                      aria-label={`Remove the alias ${row.alias}`}
                      title={`Remove the alias ${row.alias}`}
                      className={`inline-flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`}
                    >
                      {Icon.out}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {adding ? (
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                () =>
                  addCharacterAlias({
                    scope,
                    characterId,
                    alias: draft,
                    aliasScope: addScope,
                  }),
                closeAdd,
                // A click on Add (disabled while saving) drops focus: put it
                // back in the field so the name can be fixed.
                () => inputRef.current?.focus(),
              );
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setNote(null);
                closeAdd();
              }
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              autoFocus
              // Read-only rather than disabled while saving, so a refused
              // name leaves focus in the field to fix it.
              readOnly={pending}
              aria-label="New alias"
              placeholder="Another name"
              onChange={(e) => setDraft(e.target.value)}
              className={`h-6 w-40 min-w-0 rounded-md border border-neutral-700 bg-neutral-800 px-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-500 ${FOCUS}`}
            />
            <div
              role="group"
              aria-label="Alias scope"
              className="inline-flex h-6 overflow-hidden rounded-md border border-neutral-700"
            >
              {(["book", "global"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={addScope === s}
                  onClick={() => setAddScope(s)}
                  title={
                    s === "book"
                      ? "The name means this character in this book only"
                      : "The name means this character in every book"
                  }
                  className={`px-1.5 text-[12px] ${FOCUS} ${
                    addScope === s
                      ? "bg-amber-400/15 text-neutral-100"
                      : "bg-neutral-900 text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {s === "book" ? "This book" : "Every book"}
                </button>
              ))}
            </div>
            <button type="submit" disabled={pending} className={BTN_SMALL}>
              Add
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setNote(null);
                closeAdd();
              }}
              className={`${BTN_GHOST} h-6 px-2 text-[12px]`}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            ref={addRef}
            type="button"
            disabled={pending}
            onClick={() => {
              setNote(null);
              setAdding(true);
            }}
            title="Add another name this character goes by"
            className={`${BTN_GHOST} h-6 px-1.5 text-[12px]`}
          >
            + Alias
          </button>
        )}
      </div>
      <SaveNote pending={pending} note={note} />
    </div>
  );
}

/**
 * The header's Form of (#891): "form of <base>" with Clear when the
 * character is a form, else Form of…, which opens a search over this book's
 * characters; a pick saves at once. A form speaks with its base's voice.
 */
function FormOfControl({
  row,
  known,
  bookId,
  issueId,
}: {
  /** The character's known row: `formOf` is read from it. */
  row: KnownCharacter;
  known: KnownCharacter[];
  bookId: string;
  issueId: string;
}) {
  const { pending, note, setNote, act } = useSave();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const scope = { bookId, issueId };
  const base = row.formOf ?? null;
  // The render chain follows `form_of` once, so a character with forms of
  // its own can't be a form, and a form can't be a base; `setFormOf`
  // refuses both, and the list shows them disabled.
  const forms = known.filter((k) => k.formOf?.id === row.id);

  const q = slugify(query);
  const choices = useMemo(
    () =>
      known
        .filter((k) => k.inBook && k.id !== row.id && !isRoleId(k.id))
        .filter((k) => !q || matchesName(k, q))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((k) => ({
          k,
          refused: k.formOf
            ? `a form of ${k.formOf.id === row.id ? row.name : k.formOf.name}`
            : null,
        })),
    [known, row.id, row.name, q],
  );
  const index = Math.min(active, Math.max(0, choices.length - 1));
  const close = useCallback(() => {
    setAnchor(null);
    setQuery("");
    setActive(0);
  }, []);
  const pick = (choice: (typeof choices)[number]) => {
    if (choice.refused || forms.length > 0) return;
    close();
    act(() => setFormOf({ scope, characterId: row.id, baseId: choice.k.id }));
  };

  return (
    <div className="mt-1">
      {base ? (
        <div className="flex items-center gap-1 text-[12px] text-neutral-400">
          <span className="truncate">
            form of <span className="text-neutral-200">{base.name}</span>
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setNote(null);
              act(() =>
                setFormOf({ scope, characterId: row.id, baseId: null }),
              );
            }}
            aria-label="Clear form of"
            title={`Not a form of ${base.name}: speaks with its own voice`}
            className={`${BTN_GHOST} h-6 px-1.5 text-[12px]`}
          >
            Clear
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          aria-label="Form of"
          aria-expanded={anchor !== null}
          onClick={(e) => {
            setNote(null);
            setAnchor(anchor ? null : e.currentTarget);
          }}
          title="This character is a form of another one, and speaks with its voice"
          className={`${BTN_GHOST} h-6 px-1.5 text-[12px]`}
        >
          Form of…
        </button>
      )}
      <SaveNote pending={pending} note={note} />
      {anchor && (
        <Popover anchor={anchor} label="Form of" width={260} onClose={close}>
          <input
            value={query}
            placeholder="Search this book's characters"
            aria-label="Search this book's characters"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={
              choices[index] ? `${listId}-${choices[index].k.id}` : undefined
            }
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.max(1, choices.length);
                setActive((index + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const choice = choices[index];
                if (choice) pick(choice);
              }
            }}
            className={`mb-1 h-7 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 text-[13px] text-neutral-100 placeholder:text-neutral-500 ${FOCUS}`}
          />
          {forms.length > 0 && (
            <p className="px-2.5 py-1.5 text-[12px] whitespace-normal text-neutral-400">
              {`${forms.map((k) => k.name).join(", ")} ${forms.length === 1 ? "is a form" : "are forms"} of ${row.name}, so ${row.name} can't be a form.`}
            </p>
          )}
          {choices.length === 0 ? (
            <p className="px-2.5 py-1.5 text-neutral-500">
              No character matches.
            </p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label="Characters"
              className="max-h-64 overflow-y-auto"
            >
              {choices.map((choice, i) => {
                const { k, refused } = choice;
                const off = refused !== null || forms.length > 0;
                return (
                  <button
                    key={k.id}
                    id={`${listId}-${k.id}`}
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    aria-disabled={off || undefined}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(choice)}
                    className={`${MENU_ITEM} ${i === index ? "bg-neutral-800" : ""} ${off ? "cursor-not-allowed text-neutral-500" : ""}`}
                  >
                    <span className="truncate">{k.name}</span>
                    {refused && (
                      <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                        {refused}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

/**
 * Show: the page with the face boxed, large over the screen. Click outside,
 * the X or Escape closes it. It opens with focus on the X, keeps Tab inside,
 * and hands focus back to whatever had it before (the Show button or the
 * face crop) when it closes.
 */
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
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useTabTrap(rootRef);
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
  const page = pages.get(face.page);
  if (!page) return null;
  return (
    <div
      ref={rootRef}
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
        ref={closeRef}
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

export interface CharacterPanelProps
  extends Omit<VoiceTabProps, "card" | "state"> {
  card: CharacterCard;
  state: CardState;
  pages: Map<number, PageView>;
  /** Every card of the issue: the move dialog's grid. */
  cards: CharacterCard[];
  known: KnownCharacter[];
  bookId: string;
  /** For the alias writes' page refresh. */
  issueId: string;
  /** The card's old-voice audio (#836), or null when it has none. */
  revoice: RevoicePlan | null;
  /** A Faces save is running. */
  busy: boolean;
  /** Speakers exist (#854): the Voice tab, Design a voice and Sit out show. False is faces mode, Faces only. */
  voiceMode: boolean;
  /** The open tab, held by the screen so it survives a swap to another card. A role shows Voice whatever it says, and faces mode shows Faces. */
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /** Open with the name field: the card menu's Rename. */
  renameOnOpen: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onSitOut: () => void;
  onBackIn: () => void;
  onRemove: () => void;
  onPutBack: () => void;
  onConfirmFaces: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onMoveMany: (faces: FaceView[], target: NameTarget, name: string) => void;
  /** "This is character X" (#846): every face of the card in this issue moves to the target. */
  onRelabel: (target: NameTarget, name: string) => void;
  onReject: (face: FaceView) => void;
  onRejectMany: (faces: FaceView[]) => void;
}

export function CharacterPanel(props: CharacterPanelProps) {
  const {
    card,
    state,
    pages,
    cards,
    known,
    bookId,
    issueId,
    revoice,
    busy,
    voiceMode,
    tab,
    onTabChange,
    renameOnOpen,
    onClose,
    onRename,
    onSitOut,
    onBackIn,
    onRemove,
    onPutBack,
    onConfirmFaces,
    onMove,
    onMoveMany,
    onRelabel,
    onReject,
    onRejectMany,
    ...voiceProps
  } = props;
  const [renaming, setRenaming] = useState(renameOnOpen);
  const [draft, setDraft] = useState(state.name);
  const [shownId, setShownId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  /** The faces the move dialog is open for; null when it is closed. */
  const [moving, setMoving] = useState<FaceView[] | null>(null);
  /** The move dialog is the header's "this is character X": all the faces go. */
  const [movingAll, setMovingAll] = useState(false);
  const moveOpener = useRef<HTMLElement | null>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasRenaming = useRef(renameOnOpen);
  const idBase = useId();
  const shown = card.faces.find((f) => f.id === shownId) ?? null;
  const isRole = card.group === "role";
  const tabs = voiceMode ? TABS : TABS.filter((t) => t.key === "faces");
  const shownTab: PanelTab = !voiceMode ? "faces" : isRole ? "voice" : tab;
  /** The card's `characters` row; none means no aliases to show. */
  const knownRow = known.find((k) => k.id === card.id);

  const closeMove = useCallback(() => {
    setMoving(null);
    setMovingAll(false);
    moveOpener.current?.focus();
  }, []);
  const closeRename = useCallback(() => {
    setRenaming(false);
    setDraft(state.name);
  }, [state.name]);
  // Opening moves focus into the panel: the checked voice, else the name.
  // Rename's field takes it itself. Closing hands it back to the card.
  useEffect(() => {
    if (renameOnOpen) return;
    const checked = asideRef.current?.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    // preventScroll: the Swap out list scrolls itself into view as it mounts (#882).
    (checked ?? headingRef.current)?.focus({ preventScroll: true });
    // Once, when the panel opens for this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (wasRenaming.current && !renaming) pencilRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  // The open panel owns Escape, innermost first: the move dialog, the page
  // preview, select mode, an open Rename, then the panel. A popover or the
  // Review sheet over it stops the key before it gets here.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (moving) closeMove();
      else if (shown) setShownId(null);
      else if (selecting) setSelecting(false);
      else if (renaming) closeRename();
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moving, selecting, shown, renaming, onClose, closeMove, closeRename]);

  const allFaces =
    card.faces.length === 1 ? "its face" : `all ${card.faces.length} faces`;

  const meta = [
    voiceMode ? `${card.lines} ${card.lines === 1 ? "line" : "lines"}` : null,
    card.faces.length > 0
      ? `${card.faces.length} ${card.faces.length === 1 ? "face" : "faces"}`
      : null,
    card.pages ? `p.${card.pages}` : null,
  ].filter(Boolean);

  return (
    <>
      <aside
        ref={asideRef}
        aria-label={state.name}
        className="flex w-[440px] max-w-full shrink-0 flex-col overflow-hidden border-l border-neutral-800 bg-neutral-900"
      >
        <div className="flex items-start gap-3 border-b border-neutral-800 px-4 pt-3.5 pb-2.5">
          <Portrait
            card={card}
            pages={pages}
            className="size-16 shrink-0 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  setRenaming(false);
                  onRename(draft.trim());
                }}
              >
                <input
                  value={draft}
                  autoFocus
                  aria-label="Name"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      closeRename();
                    }
                  }}
                  className={`h-7 min-w-0 flex-1 rounded-md border border-amber-400 bg-neutral-800 px-1.5 text-[15px] font-semibold text-neutral-100 ${FOCUS}`}
                />
                <button type="submit" className={BTN_SMALL}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={closeRename}
                  className={`${BTN_GHOST} h-6 px-2 text-[12px]`}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <h3
                ref={headingRef}
                tabIndex={-1}
                className={`flex min-w-0 items-center gap-1.5 text-[16px] leading-tight font-semibold text-neutral-100 ${FOCUS}`}
              >
                <span className="truncate">{state.name}</span>
                <button
                  ref={pencilRef}
                  type="button"
                  onClick={() => {
                    setDraft(state.name);
                    setRenaming(true);
                  }}
                  aria-label="Rename"
                  title="Rename"
                  className={`${BTN_GHOST} h-6 px-1.5`}
                >
                  {Icon.pencil}
                </button>
              </h3>
            )}
            <div className="mt-1 text-[12px] text-neutral-400 tabular-nums">
              {meta.join(" · ")}
              <span className="ml-1 font-mono text-[11px] text-neutral-500">
                · {card.id}
              </span>
            </div>
            {/* Only a `characters` row has aliases; roles included. */}
            {knownRow && (
              <AliasList
                characterId={card.id}
                rows={knownRow.aliasRows ?? []}
                bookId={bookId}
                issueId={issueId}
              />
            )}
            {/* `form_of` is a `characters` column; a role is never a form. */}
            {knownRow && !isRole && (
              <FormOfControl
                row={knownRow}
                known={known}
                bookId={bookId}
                issueId={issueId}
              />
            )}
          </div>
          {/* A role has no faces, and a card with none has nothing to move. */}
          {!isRole && card.faces.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                moveOpener.current = e.currentTarget;
                setMovingAll(true);
                setMoving(card.faces);
              }}
              aria-label={`This is another character: move ${allFaces} in this issue to it`}
              title={`This is another character: move ${allFaces} in this issue to it`}
              className={`${BTN_SMALL} mt-0.5`}
            >
              Move {allFaces}…
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${BTN_GHOST} size-7 justify-center px-0`}
          >
            <CloseIcon />
          </button>
        </div>

        {!isRole && (
          <TabRow
            tabs={tabs}
            tab={shownTab}
            faces={card.faces.length}
            idBase={idBase}
            onChange={onTabChange}
          />
        )}

        <div
          role={isRole ? undefined : "tabpanel"}
          id={`${idBase}-panel-${shownTab}`}
          aria-labelledby={isRole ? undefined : `${idBase}-tab-${shownTab}`}
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5"
        >
          {shownTab === "voice" ? (
            <>
              <Revoice
                bookId={bookId}
                plan={revoice}
                voiceName={card.voice?.name ?? null}
              />
              <VoiceTab card={card} state={state} {...voiceProps} />
            </>
          ) : (
            <FacesTab
              card={card}
              pages={pages}
              busy={busy}
              selecting={selecting}
              onSelectingChange={setSelecting}
              shownId={shownId}
              onShow={(id) => setShownId((cur) => (cur === id ? null : id))}
              onConfirm={onConfirmFaces}
              onMoveRequest={(faces, opener) => {
                moveOpener.current = opener;
                setMoving(faces);
              }}
              onReject={onReject}
              onRejectMany={onRejectMany}
            />
          )}
        </div>

        {/* The card's quick actions. */}
        <div className="flex items-center gap-1 border-t border-neutral-800 px-3 py-2.5">
          {voiceMode && (
            <>
              {/* A form speaking with its base's voice designs none (#891). */}
              {!speaksAsBase(state) && (
                <button
                  type="button"
                  onClick={voiceProps.onDesign}
                  className={BTN}
                >
                  {WandIcon} Design a voice
                </button>
              )}
              {state.sitOut ? (
                <button type="button" onClick={onBackIn} className={BTN}>
                  Back in
                </button>
              ) : (
                <button type="button" onClick={onSitOut} className={BTN_GHOST}>
                  {Icon.sit} Sit out this run
                </button>
              )}
            </>
          )}
          <span className="flex-1" />
          {state.removed ? (
            <button type="button" onClick={onPutBack} className={BTN}>
              Put back
            </button>
          ) : (
            <button
              type="button"
              onClick={onRemove}
              className={`${BTN_GHOST} text-red-400 hover:text-red-300`}
            >
              Not in this issue
            </button>
          )}
        </div>
      </aside>

      {shown && (
        <PagePreview
          face={shown}
          pages={pages}
          label={state.name}
          onClose={() => setShownId(null)}
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
          all={movingAll}
          onConfirm={(target, name) => {
            const faces = moving;
            const all = movingAll;
            closeMove();
            if (all) onRelabel(target, name);
            else if (faces.length === 1) onMove(faces[0]!, target, name);
            else onMoveMany(faces, target, name);
          }}
          onCancel={closeMove}
        />
      )}
    </>
  );
}
