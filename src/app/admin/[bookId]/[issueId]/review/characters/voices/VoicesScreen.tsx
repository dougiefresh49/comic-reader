// The voices stop: every voice request and every speaker with no voice, the slot plan for each, Run, samples, and Continue.
// Continue shows only while a run is paused at casting; the header always links on to the editor (#757).
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { PageCrop } from "~/components/review-editor/PageCrop";
import {
  acceptVoice,
  checkAgain,
  chooseVoice,
  clearNoAudio,
  continueRun,
  noAudio,
  playSample,
  restoreVoice,
  runAgain,
  runItem,
  pickActiveVoice,
  type ActionResult,
  type ItemRef,
} from "./actions";
import type {
  ItemView,
  LeftWithout,
  Portrait,
  SampleLine,
  SlotsView,
  VoiceRef,
  VoicesData,
} from "./types";

// The characters stop's (#349) button and layout classes, so the two stops look alike.
const BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-neutral-700 px-3 text-[14px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
const PRIMARY =
  "inline-flex h-8 shrink-0 items-center rounded-sm bg-neutral-100 px-3 text-[14px] font-medium whitespace-nowrap text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400";
const QUIET =
  "inline-flex h-8 shrink-0 items-center rounded-sm px-2 text-[14px] whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";
const SELECT =
  "h-8 min-w-0 rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-[14px] text-neutral-100 outline-none focus:border-neutral-400";

type Note = { text: string; tone: "plain" | "warn"; busy?: true } | null;
type Run = (label: string, work: () => Promise<ActionResult>) => void;
type Scope = { bookId: string; issueId: string };

const FREE = "free";

const refOf = (item: ItemView): ItemRef => ({
  characterId: item.characterId,
  action: item.action,
  targetId: item.target?.id ?? null,
  designedVoices: item.designedVoices,
});

function Avatar({ name, portrait }: { name: string; portrait?: Portrait }) {
  if (!portrait)
    return (
      <div className="flex size-16 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-[22px] text-neutral-500">
        {name.charAt(0).toUpperCase() || "?"}
      </div>
    );
  return (
    <PageCrop
      url={portrait.page.imageUrl}
      rect={portrait.rect}
      pageAspect={portrait.page.width / portrait.page.height}
      boxAspect={1}
      mode="cover"
      pad={0.15}
      alt={name}
      className="size-16 shrink-0 rounded-md bg-neutral-800"
    />
  );
}

function sourceLine(item: ItemView): string {
  const lines = `${item.lines} ${item.lines === 1 ? "line" : "lines"}`;
  if (item.source === "request")
    return `Asked for at the characters stop. ${lines}.`;
  if (item.source === "archived voice")
    return `Its voice is archived. ${lines}.`;
  return `No voice. ${lines}.`;
}

function choiceLine(item: ItemView): string {
  // Not a request and not planned: the plan's default is not on offer.
  if (item.source !== "request" && !item.needsSlot && !item.refusals.length)
    return "Nothing chosen yet.";
  if (item.action === "design") return "Now: a new designed voice.";
  const name = item.target?.name ?? "a voice not found";
  return item.action === "restore"
    ? `Now: restore ${name}.`
    : `Now: clone ${name}.`;
}

function Leaves({ leaves }: { leaves: LeftWithout[] }) {
  if (leaves.length === 0)
    return (
      <p className="text-neutral-400">
        No castlist row is left without a voice.
      </p>
    );
  return (
    <div className="text-amber-200">
      Leaves without a voice:
      <ul className="mt-1 list-disc pl-5 text-neutral-300">
        {leaves.map((l) => (
          <li key={`${l.bookId}/${l.issueId}/${l.character}`}>
            {l.character}, {l.bookId} / {l.issueId}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reasons({ items, tone }: { items: string[]; tone: "warn" | "note" }) {
  if (items.length === 0) return null;
  return (
    <ul
      className={`space-y-0.5 ${tone === "warn" ? "text-amber-200" : "text-neutral-400"}`}
    >
      {items.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

/** The slot plan for one slot-taking item, with the voice Run would archive and a way to pick another. */
function SlotPlan({
  item,
  slots,
  busy,
  onRun,
}: {
  item: ItemView;
  slots: SlotsView;
  busy: boolean;
  onRun: (archive: VoiceRef | null) => void;
}) {
  const planned = item.outgoing?.kind === "archive" ? item.outgoing.id : FREE;
  const [picked, setPicked] = useState(planned);
  const choice = item.choices.find((c) => c.id === picked) ?? null;
  const freeOffered = slots.free > 0 || item.outgoing?.kind === "free slot";
  const order =
    item.outgoing?.kind === "archive" && item.outgoing.id === picked
      ? item.outgoing.order
      : null;
  const blocked =
    item.refusals.length > 0 ||
    (choice?.refusals.length ?? 0) > 0 ||
    (picked === FREE && slots.free === 0) ||
    (picked !== FREE && !choice);

  return (
    <div className="mt-3 space-y-2 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
      <p className="text-neutral-300">
        Takes a slot: {slots.used} of {slots.limit} used, {slots.free} free.
        Add/edit {slots.addEditUsed} of {slots.addEditMax} used,{" "}
        {slots.headroom} left.
      </p>
      {item.outgoing === null && (
        <p className="text-amber-200">
          The plan found no slot for this item. Pick a voice to archive.
        </p>
      )}
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-neutral-400">Archive</span>
        <select
          className={SELECT}
          value={picked}
          disabled={busy}
          onChange={(e) => setPicked(e.target.value)}
        >
          {freeOffered && (
            <option value={FREE}>nothing, use a free slot</option>
          )}
          {item.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.id === item.replaces?.id ? " (the voice it replaces)" : ""}
              {c.id === planned ? " (planned)" : ""}
            </option>
          ))}
        </select>
      </label>
      {choice && (
        <>
          {order && (
            <p className="text-neutral-400">
              {order === "add first"
                ? `Adds the new voice first, then archives ${choice.name}.`
                : `Archives ${choice.name} first. If the add is refused, ${choice.name} is restored.`}
            </p>
          )}
          <Leaves leaves={choice.leaves} />
          <Reasons items={choice.refusals} tone="warn" />
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy || blocked}
          onClick={() =>
            onRun(choice ? { id: choice.id, name: choice.name } : null)
          }
        >
          {choice ? `Run, archive ${choice.name}` : "Run, free slot"}
        </button>
        {picked !== FREE && (
          <span className="text-neutral-500">
            Nothing is archived until you click Run.
          </span>
        )}
      </div>
    </div>
  );
}

function Samples({
  scope,
  item,
  busy,
  setNote,
}: {
  scope: Scope;
  item: ItemView;
  busy: boolean;
  setNote: (n: Note) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  if (!item.voice || item.samples.length === 0) return null;
  const play = async (line: SampleLine) => {
    setPlaying(line.bubbleId);
    setNote({
      text: `Playing page ${line.page} in ${item.voice?.name}…`,
      tone: "plain",
    });
    const result = await playSample({
      scope,
      characterId: item.characterId,
      bubbleId: line.bubbleId,
    });
    if (!result.ok) {
      setPlaying(null);
      setNote({ text: result.error, tone: "warn" });
      return;
    }
    const audio = new Audio(`data:audio/mpeg;base64,${result.audio}`);
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    setNote(null);
    await audio.play().catch(() => setPlaying(null));
  };
  return (
    <div className="mt-3">
      <div className="mb-1 text-neutral-400">
        Hear {item.voice.name} (test audio, not saved):
      </div>
      <ul className="space-y-1">
        {item.samples.map((line) => (
          <li key={line.bubbleId} className="flex items-start gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy || playing !== null}
              onClick={() => void play(line)}
            >
              {playing === line.bubbleId ? "Playing" : "Play"}
            </button>
            <span className="pt-1 text-neutral-300">
              <span className="text-neutral-500">p.{line.page}</span>{" "}
              {line.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What he can choose for an unsettled item: a clone, a design, an active voice, keep, or no audio. */
function Choices({
  scope,
  item,
  active,
  busy,
  run,
}: {
  scope: Scope;
  item: ItemView;
  active: VoiceRef[];
  busy: boolean;
  run: Run;
}) {
  const [voiceId, setVoiceId] = useState("");
  const voice = active.find((v) => v.id === voiceId);
  const ref = refOf(item);
  return (
    <div className="mt-3 space-y-3">
      {item.candidates.length > 0 && (
        <div>
          <div className="mb-1 text-neutral-400">voice-lab clones</div>
          <ul className="space-y-1.5">
            {item.candidates.map((c) => {
              const chosen =
                item.action !== "design" && item.target?.id === c.id;
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-32 text-neutral-200">
                    {c.name}
                    {c.labDefault && (
                      <span className="text-neutral-500"> (lab default)</span>
                    )}
                  </span>
                  {c.clipUrl ? (
                    <audio
                      controls
                      preload="none"
                      src={c.clipUrl}
                      className="h-8 max-w-56"
                    />
                  ) : (
                    <span className="text-neutral-500">no clip</span>
                  )}
                  {chosen ? (
                    <span className="text-emerald-300">chosen</span>
                  ) : (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      onClick={() =>
                        run(`Choosing ${c.name}`, () =>
                          chooseVoice({
                            scope,
                            characterId: item.characterId,
                            choice: { kind: "clone", voice: c },
                          }),
                        )
                      }
                    >
                      Use this clone
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!(item.action === "design" && item.source === "request") && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() =>
              run("Choosing a new designed voice", () =>
                chooseVoice({
                  scope,
                  characterId: item.characterId,
                  choice: { kind: "design" },
                }),
              )
            }
          >
            Design a new voice
          </button>
        )}
        {item.replaces && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() =>
              run(`Keeping ${item.replaces!.name}`, () =>
                pickActiveVoice({ scope, item: ref, voice: item.replaces! }),
              )
            }
          >
            Keep {item.replaces.name}
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() =>
            run("No audio this run", () => noAudio({ scope, item: ref }))
          }
        >
          No audio this run
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT}
          value={voiceId}
          disabled={busy}
          onChange={(e) => setVoiceId(e.target.value)}
        >
          <option value="">An active voice, no slot…</option>
          {active.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !voice}
          onClick={() =>
            voice &&
            run(`Using ${voice.name}`, () =>
              pickActiveVoice({ scope, item: ref, voice }),
            )
          }
        >
          Use
        </button>
      </div>
    </div>
  );
}

function ItemCard({
  scope,
  item,
  data,
  busy,
  run,
  setNote,
}: {
  scope: Scope;
  item: ItemView;
  data: VoicesData;
  busy: boolean;
  run: Run;
  setNote: (n: Note) => void;
}) {
  const ref = refOf(item);
  const [nextTarget, setNextTarget] = useState(item.target?.id ?? "");
  const retargets = [
    ...(item.target ? [item.target] : []),
    ...item.candidates.filter((c) => c.id !== item.target?.id),
  ];

  let body: React.ReactNode;
  if (item.state === "settled" && item.noAudio) {
    body = (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-neutral-300">No audio this run.</span>
        <button
          type="button"
          className={QUIET}
          disabled={busy}
          onClick={() =>
            run("Clearing", () =>
              clearNoAudio({ scope, characterId: item.characterId }),
            )
          }
        >
          Clear
        </button>
      </div>
    );
  } else if (!item.known) {
    body = (
      <div className="mt-2 space-y-2">
        <p className="text-amber-200">
          No character goes by this speaker, so it cannot get a voice here. Name
          the speaker on the{" "}
          <Link
            href={`/admin/${scope.bookId}/${scope.issueId}/review/editor`}
            className="underline hover:text-amber-100"
          >
            pages stop
          </Link>
          , or skip it for this run.
        </p>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() =>
            run("No audio this run", () => noAudio({ scope, item: ref }))
          }
        >
          No audio this run
        </button>
      </div>
    );
  } else if (item.state === "needs attention") {
    const archived = item.attention?.archived ?? null;
    body = (
      <div className="mt-2 space-y-2">
        <p className="text-amber-200">
          Needs attention: a run stopped at &ldquo;{item.attention?.phase}
          &rdquo;.
          {archived && ` ${archived.name} was archived for it.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() =>
              run("Checking ElevenLabs", () => checkAgain({ scope, item: ref }))
            }
          >
            Check again
          </button>
          {archived && (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              title="Adds the voice back from its bucket copy; takes a slot"
              onClick={() =>
                run(`Restoring ${archived.name}`, () =>
                  restoreVoice({ scope, voiceId: archived.id }),
                )
              }
            >
              Restore {archived.name}
            </button>
          )}
        </div>
      </div>
    );
  } else if (item.state === "made") {
    body = (
      <div className="mt-2">
        <p className="text-emerald-300">
          Made: {item.voice?.name ?? item.target?.name ?? "a new voice"}.
        </p>
        <Samples scope={scope} item={item} busy={busy} setNote={setNote} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={() =>
              run("Accepting", () => acceptVoice({ scope, item: ref }))
            }
          >
            Accept
          </button>
          {item.action !== "design" && retargets.length > 0 && (
            <select
              className={SELECT}
              value={nextTarget}
              disabled={busy}
              onChange={(e) => setNextTarget(e.target.value)}
            >
              {retargets.map((v) => (
                <option key={v.id} value={v.id}>
                  next: {v.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={BUTTON}
            disabled={busy || (item.action !== "design" && !nextTarget)}
            onClick={() =>
              run("Back to pending", () =>
                runAgain({
                  scope,
                  item: ref,
                  targetVoiceId: item.action === "design" ? null : nextTarget,
                }),
              )
            }
          >
            Run again
          </button>
        </div>
      </div>
    );
  } else if (item.state === "settled") {
    body = (
      <div className="mt-2">
        <p className="text-neutral-300">
          Voice: {item.voice?.name ?? "none active"}.
        </p>
        <Samples scope={scope} item={item} busy={busy} setNote={setNote} />
      </div>
    );
  } else {
    body = (
      <div className="mt-2">
        <p className={item.noDefault ? "text-amber-200" : "text-neutral-300"}>
          {item.noDefault ?? choiceLine(item)}
        </p>
        <Reasons items={item.warnings} tone="note" />
        {item.needsSlot && data.slots ? (
          <SlotPlan
            key={item.outgoing?.kind === "archive" ? item.outgoing.id : FREE}
            item={item}
            slots={data.slots}
            busy={busy}
            onRun={(archive) =>
              run(
                archive ? `Running, archiving ${archive.name}` : "Running",
                () =>
                  runItem({
                    scope,
                    item: ref,
                    archiveVoiceId: archive?.id ?? null,
                  }),
              )
            }
          />
        ) : (
          <div className="mt-2">
            <Reasons items={item.refusals} tone="warn" />
          </div>
        )}
        <Choices
          scope={scope}
          item={item}
          active={data.active}
          busy={busy}
          run={run}
        />
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 rounded-md border border-neutral-800 bg-neutral-900/60 p-4">
      <Avatar name={item.name} portrait={data.portraits[item.characterId]} />
      <div className="min-w-0 flex-1 text-[14px]">
        <div className="truncate text-[16px] font-medium text-neutral-100">
          {item.name}
        </div>
        <div className="mt-1 text-neutral-400">{sourceLine(item)}</div>
        {body}
      </div>
    </div>
  );
}

function Section({
  title,
  blurb,
  items,
  children,
}: {
  title: string;
  blurb: string;
  items: ItemView[];
  children: (item: ItemView) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <h2 className="text-[18px] font-semibold text-neutral-50">
          {title}{" "}
          <span className="font-normal text-neutral-500">{items.length}</span>
        </h2>
        <p className="min-w-0 flex-1 text-[14px] text-neutral-500">{blurb}</p>
      </div>
      <div className="space-y-3">{items.map(children)}</div>
    </section>
  );
}

/** What Continue does, one sentence for its tooltip and the run note (#757). */
const CONTINUE_DOES =
  "resumes the paused run into audio and spends ElevenLabs credits on every bubble that still needs audio.";

export function VoicesScreen({ data }: { data: VoicesData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [continued, setContinued] = useState(false);
  const scope = useMemo(
    () => ({ bookId: data.bookId, issueId: data.issueId }),
    [data.bookId, data.issueId],
  );

  const run = useCallback<Run>(
    (label, work) => {
      setNote({ text: `${label}…`, tone: "plain", busy: true });
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

  useEffect(() => {
    if (!note || pending || note.tone === "warn") return;
    const timer = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(timer);
  }, [note, pending]);

  const by = (state: ItemView["state"]) =>
    data.items.filter((i) => i.state === state);
  const card = (item: ItemView) => (
    <ItemCard
      key={item.characterId}
      scope={scope}
      item={item}
      data={data}
      busy={pending}
      run={run}
      setNote={setNote}
    />
  );
  const s = data.slots;

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
          <Link
            href={`/admin/${data.bookId}/${data.issueId}/review/characters`}
            className="shrink-0 hover:text-neutral-100"
          >
            Characters
          </Link>
          <span>/</span>
          <span className="shrink-0 text-neutral-100">Voices</span>
        </nav>
        <span className="flex-1" />
        <span
          className={`hidden truncate sm:inline ${data.blocker ? "text-amber-200" : "text-emerald-300"}`}
        >
          {data.blocker ?? "Every item is settled."}
        </span>
        <Link
          href={`/admin/${data.bookId}/${data.issueId}/review/editor`}
          className={BUTTON}
        >
          Editor →
        </Link>
        {/* The badge keys on the click, not the row: a resumed run clears the pause before the refresh lands. */}
        {continued ? (
          <span className="rounded-sm bg-emerald-700/30 px-3 py-1.5 font-medium text-emerald-200">
            Pipeline resumed
          </span>
        ) : (
          data.runPaused && (
            <button
              type="button"
              disabled={pending || data.blocker !== null}
              title={data.blocker ?? `Continue ${CONTINUE_DOES}`}
              onClick={() =>
                run("Continuing", async () => {
                  const result = await continueRun(scope);
                  if (result.ok) setContinued(true);
                  return result;
                })
              }
              className={PRIMARY}
            >
              Continue
            </button>
          )
        )}
      </header>
      {data.runPaused && (
        <p className="border-b border-amber-400/30 bg-amber-400/5 px-4 py-2 text-[14px] text-amber-100">
          The ingest run is paused at this stop. Continue {CONTINUE_DOES}
        </p>
      )}

      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="mb-4 max-w-3xl text-[15px] text-neutral-400">
          The voice work for {data.issueName}: every voice asked for at the
          characters stop, and every speaker with no voice. Pick a voice for
          each, check the slot plan, Run, and hear a few lines before the audio
          is made. Nothing is archived or made until you click Run.
        </p>
        {s && (
          <p className="mb-2 text-neutral-300">
            Slots: {s.used} of {s.limit} used, {s.free} free. Add/edit:{" "}
            {s.addEditUsed} of {s.addEditMax} used. The whole list needs{" "}
            {s.adds} {s.adds === 1 ? "add" : "adds"} and {s.archives}{" "}
            {s.archives === 1 ? "archive" : "archives"}.
          </p>
        )}
        {data.planError && (
          <p className="mb-2 text-amber-200">
            The slot plan could not be read: {data.planError}
          </p>
        )}
        <div className="mb-8">
          <Reasons items={data.planRefusals} tone="warn" />
        </div>

        {data.items.length === 0 && !data.planError && (
          <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
            No voice work in this issue.
          </p>
        )}
        <Section
          title="Needs attention"
          blurb="A run stopped and could not tell what happened. Check again, or restore the archived voice."
          items={by("needs attention")}
        >
          {card}
        </Section>
        <Section
          title="To decide"
          blurb="Pick a voice for each. A clone or a new design takes a slot; an active voice does not."
          items={by("pending")}
        >
          {card}
        </Section>
        <Section
          title="Made"
          blurb="Hear a few lines, then accept the voice or run the item again."
          items={by("made")}
        >
          {card}
        </Section>
        <Section
          title="Settled"
          blurb="These no longer hold the run."
          items={by("settled")}
        >
          {card}
        </Section>
      </main>

      {note && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-40 max-w-[80vw] -translate-x-1/2 rounded-sm border px-4 py-2 text-[14px] shadow-lg ${
            note.tone === "warn"
              ? "border-amber-400/60 bg-neutral-950 text-amber-200"
              : "border-neutral-600 bg-neutral-950 text-neutral-100"
          }`}
        >
          {note.busy ? (
            <span className="text-neutral-400">Saving: </span>
          ) : null}
          {note.text}
          {note.tone === "warn" && !pending && (
            <button
              type="button"
              className="ml-3 text-neutral-400 hover:text-neutral-100"
              onClick={() => setNote(null)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
