// The characters stop: the cast and its faces on one screen, in four groups. Every action saves when made.
// The open card lives in CharacterPanel, a column to the right of the grid (#743).
// The header always links on to the voices stop; Approve shows only while a run is paused at review-clusters (#757).
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  addCharacter,
  approveCharacters,
  confirmFaces,
  moveFace,
  moveFaces,
  nameGroup,
  nameSuggestion,
  castArchivedVoice,
  pickAppearance,
  rejectFace,
  rejectFaces,
  rejectGroup,
  removeCharacter,
  renameCharacter,
  requestVoice,
  setActiveVoice,
  undoVoiceRequest,
  voicePreview,
  type ActionResult,
  type NameTarget,
} from "./actions";
import { dismissWikiName, restoreWikiName } from "./suggestion-actions";
import type { VoiceRequest } from "~/lib/cast";
import { CharacterPanel, type PanelTab } from "./CharacterPanel";
import {
  BUTTON,
  DANGER,
  FaceCrop,
  FacesPanel,
  NameField,
  PRIMARY,
  QUIET,
  VoiceLine,
  bestFace,
  facesLine,
} from "./shared";
import type {
  ActiveVoice,
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  PageView,
  UnknownGroupView,
  Suggestion,
} from "./types";

type Note = { text: string; tone: "plain" | "warn" } | null;

/** The DOM id of a card's button, so closing the panel can hand focus back to it. */
const cardDomId = (cardId: string) => `character-card-${cardId}`;

/** The collapsed card in the grid. The open one is marked and shown in CharacterPanel. */
function CharacterCardView({
  card,
  pages,
  open,
  onOpen,
  onClose,
}: {
  card: CharacterCard;
  pages: Map<number, PageView>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const portrait = useMemo(
    () => bestFace(card.faces, pages),
    [card.faces, pages],
  );
  const ref = useRef<HTMLButtonElement>(null);
  // Opening the panel narrows the grid and reflows it; keep the clicked card on screen.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <button
      ref={ref}
      id={cardDomId(card.id)}
      type="button"
      onClick={open ? onClose : onOpen}
      aria-expanded={open}
      className={`flex w-full scroll-mt-16 scroll-mb-4 items-start gap-4 rounded-md border p-4 text-left ${
        open
          ? "border-neutral-400 bg-neutral-900 ring-1 ring-neutral-400"
          : "border-neutral-800 bg-neutral-900/60 hover:border-neutral-600"
      } ${card.removed ? "opacity-60" : ""}`}
    >
      <FaceCrop
        face={portrait}
        pages={pages}
        alt={card.name}
        className="size-20 shrink-0 rounded-md"
      />
      <div className="min-w-0 flex-1 text-[14px]">
        <div className="truncate text-[16px] font-medium text-neutral-100">
          {card.name}
        </div>
        <div className="mt-1 text-neutral-400">
          {card.group === "role" ? "Role, no faces" : facesLine(card.faces)}
        </div>
        <div className="mt-1 truncate">
          <VoiceLine card={card} />
        </div>
        {card.voiceRequest && (
          <div className="mt-1 truncate text-amber-300">
            {card.voiceRequest.action === "clone"
              ? "Wants a voice-lab clone"
              : "Wants a new designed voice"}
            , made at the voices stop
          </div>
        )}
        {card.removed && (
          <div className="mt-1 text-amber-300">Out of this issue</div>
        )}
        {!card.removed &&
          card.group === "here" &&
          card.faces.length === 0 &&
          card.sources.includes("wiki") && (
            <div className="mt-1 truncate text-neutral-500">
              From the wiki
              {card.wikiNames.length > 0
                ? `: ${card.wikiNames.join(", ")}`
                : ""}
            </div>
          )}
      </div>
    </button>
  );
}

function UnknownCardView({
  group,
  pages,
  known,
  open,
  busy,
  onOpen,
  onClose,
  onName,
  onReject,
  onMove,
  onRejectFace,
}: {
  group: UnknownGroupView;
  pages: Map<number, PageView>;
  known: KnownCharacter[];
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onName: (target: NameTarget, name: string) => void;
  onReject: () => void;
  onMove: (face: FaceView, target: NameTarget, name: string) => void;
  onRejectFace: (face: FaceView) => void;
}) {
  const hint = group.suggestedNames.join(", ");
  const label = hint ? `Unknown, maybe ${hint}` : "Unknown";
  const strip = group.faces.slice(0, open ? 0 : 3);
  const portrait = useMemo(
    () => bestFace(group.faces, pages),
    [group.faces, pages],
  );
  return (
    <section
      className={`rounded-md border p-4 ${
        open
          ? "col-span-full border-amber-300/60 bg-neutral-900/80 p-5"
          : "border-amber-400/40 bg-amber-400/5"
      }`}
      aria-label={label}
    >
      <div className="flex flex-wrap items-start gap-4">
        {open ? (
          <FaceCrop
            face={portrait}
            pages={pages}
            alt={label}
            className="size-24 shrink-0 rounded-md"
          />
        ) : (
          <button
            type="button"
            onClick={onOpen}
            title="See every face"
            className="flex shrink-0 gap-1"
          >
            {strip.map((f) => (
              <FaceCrop
                key={f.id}
                face={f}
                pages={pages}
                alt={`${label}, page ${f.page}`}
                className="size-20 rounded-md"
              />
            ))}
          </button>
        )}
        <div className="min-w-0 flex-1 text-[14px]">
          <div className="text-[16px] font-medium text-amber-100">
            Who is this?
          </div>
          <div className="mt-1 text-neutral-300">{facesLine(group.faces)}</div>
          {hint && (
            <div className="mt-1 text-neutral-400">
              The lookahead guessed:{" "}
              <span className="text-neutral-200">{hint}</span>
            </div>
          )}
          <div className="mt-3 flex max-w-md items-center gap-2">
            <NameField
              known={known}
              placeholder="Name this group, or type a new name"
              initial={group.suggestedNames[0] ?? ""}
              submitLabel="Name"
              busy={busy}
              onPick={onName}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className={DANGER}
          >
            Not a character
          </button>
          <button
            type="button"
            onClick={open ? onClose : onOpen}
            className={QUIET}
          >
            {open ? "Close" : "Every face"}
          </button>
        </div>
      </div>
      {open && (
        <FacesPanel
          faces={group.faces}
          loose={group.looseExemplars}
          pages={pages}
          label={label}
          known={known}
          busy={busy}
          onMove={onMove}
          onReject={onRejectFace}
        />
      )}
    </section>
  );
}

/** What "Is someone known…" does (`nameSuggestion` in actions.ts), shown beside its field and as its title. */
const KNOWN_HINT =
  "Pick a character: this name becomes one of their aliases in every book, and they join this issue's cast.";

const suggestionLabel = (s: Suggestion) =>
  s.qualifier ? `${s.name} (${s.qualifier})` : s.name;

function SuggestionRow({
  suggestion,
  known,
  busy,
  onName,
  onDismiss,
}: {
  suggestion: Suggestion;
  known: KnownCharacter[];
  busy: boolean;
  onName: (target: NameTarget, name: string) => void;
  /** Wiki names only: hide the name for this issue (#751). */
  onDismiss?: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const label = suggestionLabel(suggestion);
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-1">
        <span className="text-neutral-100">{label}</span>
        <span className="text-neutral-500">
          {" "}
          {suggestion.source === "wiki"
            ? "· named on the wiki, no character yet"
            : "· in this book's cast list, no character yet"}
        </span>
      </span>
      {naming ? (
        <div className="w-full max-w-md">
          <p className="mb-1.5 text-[13px] text-neutral-500">{KNOWN_HINT}</p>
          <div className="flex items-center gap-2">
            <NameField
              known={known}
              placeholder="Who is this?"
              initial={suggestion.name}
              autoFocus
              onPick={(target, name) => {
                setNaming(false);
                onName(target, name);
              }}
              onCancel={() => setNaming(false)}
            />
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onName({ kind: "new", name: suggestion.name }, suggestion.name)
            }
            className={BUTTON}
          >
            New character
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setNaming(true)}
            title={KNOWN_HINT}
            className={BUTTON}
          >
            Is someone known…
          </button>
          {onDismiss && (
            <button
              type="button"
              disabled={busy}
              onClick={onDismiss}
              className={BUTTON}
            >
              Dismiss
            </button>
          )}
        </>
      )}
    </li>
  );
}

function Section({
  title,
  blurb,
  count,
  action,
  children,
}: {
  title: string;
  blurb: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <h2 className="text-[18px] font-semibold text-neutral-50">
          {title} <span className="font-normal text-neutral-500">{count}</span>
        </h2>
        <p className="min-w-0 flex-1 text-[14px] text-neutral-500">{blurb}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3";

export function CharactersScreen({ data }: { data: CharactersData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The panel's open tab, kept here so it survives a swap to another card.
  const [panelTab, setPanelTab] = useState<PanelTab>("faces");
  const [adding, setAdding] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [approved, setApproved] = useState(false);
  const pages = useMemo(
    () => new Map(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );
  const scope = useMemo(
    () => ({ bookId: data.bookId, issueId: data.issueId }),
    [data.bookId, data.issueId],
  );

  /** Per card, the voice this issue's row had before an appearance pick, for Undo (null: none). */
  const beforePick = useRef(new Map<string, string | null>());

  const run = useCallback(
    (label: string, work: () => Promise<ActionResult>) => {
      setNote({ text: `${label}…`, tone: "plain" });
      startTransition(async () => {
        try {
          const result = await work();
          setNote(
            result.ok
              ? { text: result.message, tone: "plain" }
              : { text: result.error, tone: "warn" },
          );
        } catch (err) {
          // The call can throw before the action runs (fetch refused, network down).
          setNote({
            text: err instanceof Error ? err.message : String(err),
            tone: "warn",
          });
        }
        router.refresh();
      });
    },
    [router],
  );

  // Escape closes an open unknown group here. An open card's panel owns Escape itself.
  useEffect(() => {
    if (!openKey?.startsWith("unknown:")) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openKey]);

  // A finished note clears itself after a few seconds; the next action replaces it sooner.
  useEffect(() => {
    if (!note || pending) return;
    const timer = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(timer);
  }, [note, pending]);

  const here = data.cards.filter((c) => c.group === "here");
  const before = data.cards.filter((c) => c.group === "before");
  const roles = data.cards.filter((c) => c.group === "role");
  const castCount = data.cards.filter((c) => !c.removed).length;
  const needs = data.unknown.length;
  const notInCast = useMemo(() => {
    const present = new Set(
      data.cards.filter((c) => !c.removed).map((c) => c.id),
    );
    return data.known.filter((k) => !present.has(k.id));
  }, [data.cards, data.known]);

  const characterIds = useMemo(
    () => new Set(data.known.map((k) => k.id)),
    [data.known],
  );

  const openCard = data.cards.find((c) => c.id === openKey) ?? null;

  /** Closes the panel and hands focus back to the card that opened it. */
  const closePanel = (cardId: string) => {
    setOpenKey(null);
    document.getElementById(cardDomId(cardId))?.focus();
  };

  const cardView = (card: CharacterCard) => (
    <CharacterCardView
      key={card.id}
      card={card}
      pages={pages}
      open={openKey === card.id}
      onOpen={() => setOpenKey(card.id)}
      onClose={() => closePanel(card.id)}
    />
  );

  /** Everything the panel does for one card, wired to the server actions. */
  const panelProps = (card: CharacterCard) => ({
    card,
    scope,
    pages,
    cards: data.cards,
    known: data.known,
    activeVoices: data.activeVoices,
    canChangeVoice: !card.removed && characterIds.has(card.id),
    pullNote: `voice-lab pull for comic-reader: ${card.name} (character id "${card.id}") in ${data.bookName} (book "${data.bookId}"), ${data.issueName}. No voice-lab clone is on file for this character; it needs a clip to clone from.`,
    busy: pending,
    tab: panelTab,
    onTabChange: setPanelTab,
    onClose: () => closePanel(card.id),
    onRename: (name: string) =>
      run("Renaming", () =>
        renameCharacter({ scope, characterId: card.id, name }),
      ),
    onRemove: () =>
      run(`Removing ${card.name}`, () =>
        removeCharacter({ scope, characterId: card.id, name: card.name }),
      ),
    onAddBack: () =>
      run(`Adding ${card.name} back`, () =>
        addCharacter({
          scope,
          target: { kind: "existing", id: card.id },
          franchiseId: data.franchiseId,
        }),
      ),
    onConfirm: () =>
      run("Confirming the faces", () =>
        confirmFaces({ scope, characterId: card.id }),
      ),
    onMove: (face: FaceView, target: NameTarget, name: string) =>
      run(`Moving the page ${face.page} face to ${name}`, () =>
        moveFace({
          scope,
          detectionId: face.id,
          target,
          franchiseId: data.franchiseId,
        }),
      ),
    onPreviewVoice: (voiceId: string) => voicePreview({ scope, voiceId }),
    onMoveMany: (faces: FaceView[], target: NameTarget, name: string) =>
      run(`Moving ${faces.length} faces to ${name}`, () =>
        moveFaces({
          scope,
          detectionIds: faces.map((f) => f.id),
          target,
          franchiseId: data.franchiseId,
        }),
      ),
    onReject: (face: FaceView) =>
      run(`Dropping the page ${face.page} face`, () =>
        rejectFace({ scope, detectionId: face.id }),
      ),
    onRejectMany: (faces: FaceView[]) =>
      run(
        `Dropping ${faces.length} ${faces.length === 1 ? "face" : "faces"}`,
        () => rejectFaces({ scope, detectionIds: faces.map((f) => f.id) }),
      ),
    // Any other voice choice ends the appearance pick Undo would revert.
    onSetVoice: (voice: ActiveVoice) => {
      beforePick.current.delete(card.id);
      run(`Giving ${card.name} ${voice.name}`, () =>
        setActiveVoice({
          scope,
          characterId: card.id,
          name: card.name,
          group: card.group,
          voiceUuid: voice.id,
        }),
      );
    },
    onRequestVoice: (request: VoiceRequest) => {
      beforePick.current.delete(card.id);
      run(`Requesting a voice for ${card.name}`, () =>
        requestVoice({
          scope,
          characterId: card.id,
          name: card.name,
          request,
        }),
      );
    },
    onPickAppearance: (appearanceId: string) =>
      run(`Asking voice-lab for a clip for ${card.name}`, async () => {
        const result = await pickAppearance({
          scope,
          characterId: card.id,
          name: card.name,
          appearanceId,
        });
        // The first pick's voice is what Undo puts back; a repeat keeps it.
        if (
          result.ok &&
          result.previousVoiceUuid !== undefined &&
          !beforePick.current.has(card.id)
        )
          beforePick.current.set(card.id, result.previousVoiceUuid);
        return result;
      }),
    onCastArchived: (voiceId: string) => {
      beforePick.current.delete(card.id);
      run(`Casting an archived voice for ${card.name}`, () =>
        castArchivedVoice({
          scope,
          characterId: card.id,
          name: card.name,
          voiceUuid: voiceId,
        }),
      );
    },
    onUndoVoiceRequest: () =>
      run(`Undoing the voice request for ${card.name}`, async () => {
        const result = await undoVoiceRequest({
          scope,
          characterId: card.id,
          name: card.name,
          restoreVoiceUuid: beforePick.current.get(card.id),
        });
        if (result.ok) beforePick.current.delete(card.id);
        return result;
      }),
  });

  return (
    <div className="min-h-screen bg-neutral-950 text-[14px] text-neutral-200">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-4 backdrop-blur">
        <nav className="flex min-w-0 items-center gap-1.5 text-neutral-500">
          <Link href="/admin" className="hover:text-neutral-100">
            Admin
          </Link>
          <span>/</span>
          <Link
            href={`/admin/${data.bookId}/${data.issueId}/review/pipeline`}
            className="truncate hover:text-neutral-100"
          >
            {data.bookName}, {data.issueName}
          </Link>
          <span>/</span>
          <span className="shrink-0 text-neutral-100">Characters</span>
        </nav>
        <span className="flex-1" />
        <span
          className={`hidden truncate sm:inline ${data.blocker ? "text-amber-200" : "text-emerald-300"}`}
        >
          {data.blocker ?? `Cast of ${castCount}. Nothing needs you.`}
        </span>
        <Link
          href={`/admin/${data.bookId}/${data.issueId}/review/characters/voices`}
          className={BUTTON}
        >
          Voices →
        </Link>
        {data.runPaused &&
          (approved ? (
            <span className="rounded-sm bg-emerald-700/30 px-3 py-1.5 font-medium text-emerald-200">
              Pipeline resumed
            </span>
          ) : (
            <button
              type="button"
              disabled={pending || data.blocker !== null}
              title={
                data.blocker ??
                "Seeds the cast as shown and resumes the paused run. Gemini then reads every page (paid), the run stops at page review, writes voice descriptions and pauses again at the voices stop."
              }
              onClick={() =>
                run("Approving", async () => {
                  const result = await approveCharacters(scope);
                  if (result.ok) setApproved(true);
                  return result;
                })
              }
              className={PRIMARY}
            >
              Approve the cast
            </button>
          ))}
      </header>
      {data.runPaused && (
        <p className="border-b border-amber-400/30 bg-amber-400/5 px-4 py-2 text-[14px] text-amber-100">
          The ingest run is paused at this stop. Approve the cast seeds the cast
          and resumes it: Gemini reads every page (paid), the run stops at page
          review, then pauses again at the voices stop.
        </p>
      )}

      <div className="flex items-start">
        <main className="min-w-0 flex-1 px-4 py-8">
          <div className="mx-auto max-w-6xl">
            <p className="mb-8 max-w-3xl text-[15px] text-neutral-400">
              Everyone the run thinks is in {data.issueName}: faces the
              lookahead could not name first, then the characters it saw or the
              wiki lists, then the book&apos;s earlier cast, then the roles.
              Open a card for every face. Each change saves as you make it.
            </p>

            <Section
              title="Needs a name"
              blurb="Faces with no character, and wiki names the book does not know. Faces block Approve; wiki names do not."
              count={needs + data.suggestions.length}
            >
              {needs === 0 && data.suggestions.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
                  Every face has a name.
                </p>
              ) : (
                <>
                  {needs > 0 && (
                    <div className={`${GRID} mb-3`}>
                      {data.unknown.map((g) => (
                        <UnknownCardView
                          key={g.key}
                          group={g}
                          pages={pages}
                          known={data.known}
                          open={openKey === `unknown:${g.key}`}
                          busy={pending}
                          onOpen={() => setOpenKey(`unknown:${g.key}`)}
                          onClose={() => setOpenKey(null)}
                          onName={(target, name) =>
                            run(
                              `Naming ${g.faces.length} ${g.faces.length === 1 ? "face" : "faces"} ${name}`,
                              () =>
                                nameGroup({
                                  scope,
                                  detectionIds: g.faces.map((f) => f.id),
                                  suggestedNames: g.suggestedNames,
                                  target,
                                  franchiseId: data.franchiseId,
                                }),
                            )
                          }
                          onReject={() =>
                            run("Dropping the group", () =>
                              rejectGroup({
                                scope,
                                detectionIds: g.faces.map((f) => f.id),
                                suggestedNames: g.suggestedNames,
                              }),
                            )
                          }
                          onMove={(face, target, name) =>
                            run(
                              `Naming the page ${face.page} face ${name}`,
                              () =>
                                moveFace({
                                  scope,
                                  detectionId: face.id,
                                  target,
                                  franchiseId: data.franchiseId,
                                }),
                            )
                          }
                          onRejectFace={(face) =>
                            run(`Dropping the page ${face.page} face`, () =>
                              rejectFace({ scope, detectionId: face.id }),
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                  {data.suggestions.length > 0 && (
                    <ul className="space-y-2">
                      {data.suggestions.map((s) => (
                        <SuggestionRow
                          key={`${s.name}|${s.qualifier}`}
                          suggestion={s}
                          known={data.known}
                          busy={pending}
                          onName={(target, name) =>
                            run(`Naming ${s.name} as ${name}`, () =>
                              nameSuggestion({
                                scope,
                                name: s.name,
                                target,
                                franchiseId: data.franchiseId,
                              }),
                            )
                          }
                          onDismiss={
                            s.source === "wiki"
                              ? () =>
                                  run(`Dismissing ${s.name}`, () =>
                                    dismissWikiName({ scope, name: s.name }),
                                  )
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
              {data.dismissed.length > 0 && (
                <div className="mt-3 text-[14px]">
                  <button
                    type="button"
                    aria-expanded={showDismissed}
                    onClick={() => setShowDismissed((v) => !v)}
                    className={QUIET}
                  >
                    {showDismissed
                      ? "Hide dismissed"
                      : `Show ${data.dismissed.length} dismissed`}
                  </button>
                  {showDismissed && (
                    <ul className="mt-2 space-y-2">
                      {data.dismissed.map((s) => (
                        <li
                          key={`${s.name}|${s.qualifier}`}
                          className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-neutral-800 px-4 py-2"
                        >
                          <span className="min-w-0 flex-1 text-neutral-500">
                            {suggestionLabel(s)}
                          </span>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              run(`Restoring ${s.name}`, () =>
                                restoreWikiName({ scope, name: s.name }),
                              )
                            }
                            className={BUTTON}
                          >
                            Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Section>

            <Section
              title="In this issue"
              blurb="A face the lookahead named, a wiki mention, or a character added to the cast. Remove who is not here."
              count={here.filter((c) => !c.removed).length}
              action={
                adding ? (
                  <div className="flex w-full max-w-md items-center gap-2 sm:w-auto">
                    <NameField
                      known={notInCast}
                      placeholder="Add a character, known or new"
                      autoFocus
                      onPick={(target, name) => {
                        setAdding(false);
                        run(`Adding ${name}`, () =>
                          addCharacter({
                            scope,
                            target,
                            franchiseId: data.franchiseId,
                          }),
                        );
                      }}
                      onCancel={() => setAdding(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className={BUTTON}
                  >
                    Add a character
                  </button>
                )
              }
            >
              {here.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
                  No named faces and no wiki names yet.
                </p>
              ) : (
                <div className={GRID}>{here.map((card) => cardView(card))}</div>
              )}
            </Section>

            <Section
              title="Cast before, no sign here"
              blurb="In the book's castlist from an earlier issue, and not in this issue's cast yet. Remove who is absent."
              count={before.length}
            >
              {before.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
                  Nobody carried over without a sign here.
                </p>
              ) : (
                <div className={GRID}>
                  {before.map((card) => cardView(card))}
                </div>
              )}
            </Section>

            <Section
              title="Roles"
              blurb="The narrator, off-panel speech and the crowd. Always offered."
              count={roles.length}
            >
              <div className={GRID}>{roles.map((card) => cardView(card))}</div>
            </Section>
          </div>
        </main>
        {openCard && (
          <CharacterPanel key={openCard.id} {...panelProps(openCard)} />
        )}
      </div>

      {note && (
        <div
          role="status"
          className={`pointer-events-none fixed bottom-4 left-1/2 z-40 max-w-[80vw] -translate-x-1/2 rounded-sm border px-4 py-2 text-[14px] shadow-lg ${
            note.tone === "warn"
              ? "border-amber-400/60 bg-neutral-950 text-amber-200"
              : "border-neutral-600 bg-neutral-950 text-neutral-100"
          }`}
        >
          {pending ? <span className="text-neutral-400">Saving: </span> : null}
          {note.text}
        </div>
      )}
    </div>
  );
}
