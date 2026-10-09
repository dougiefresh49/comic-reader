// The voices stop: every voice request and every speaker with no voice, each card one decision (#779: the voice, what it costs, one action), samples, and Continue.
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
  clearNoAudio,
  continueRun,
  noAudio,
  restoreVoice,
  runAgain,
} from "./actions";
import { Reasons, Samples } from "./bits";
import { Decision, decisionKey, presetCounts } from "./Decision";
import {
  BUTTON,
  PRIMARY,
  QUIET,
  SELECT,
  plain,
  refOf,
  type Note,
  type Run,
  type Scope,
} from "./shared";
import type { ItemView, Portrait, VoicesData } from "./types";

function sourceLine(item: ItemView): string {
  const lines = `${item.lines} ${item.lines === 1 ? "line" : "lines"}`;
  if (item.source === "request")
    return `Asked for on the Characters screen. ${lines}.`;
  if (item.source === "archived voice")
    return `Its voice is archived. ${lines}.`;
  return `No voice. ${lines}.`;
}

/** Warnings the pending card states in its own words (the replaced voice that stays active is said under the slot pick). */
const cardWarnings = (item: ItemView): string[] =>
  item.warnings.filter((w) => !w.includes("cannot be archived ("));

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
            review editor
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
              title="Adds the voice back from its backup copy; takes a slot"
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
        <div className="mt-3">
          <Samples scope={scope} item={item} busy={busy} setNote={setNote} />
        </div>
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
              name="next-target"
              aria-label={`Run again voice for ${item.name}`}
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
        <div className="mt-3">
          <Samples scope={scope} item={item} busy={busy} setNote={setNote} />
        </div>
      </div>
    );
  } else {
    body = (
      <div className="mt-2 space-y-2">
        {item.noDefault && (
          <p className="text-amber-200">{plain(item.noDefault)}</p>
        )}
        <Reasons items={cardWarnings(item)} tone="note" />
        <Decision
          key={decisionKey(item, data.slots)}
          scope={scope}
          item={item}
          slots={data.slots}
          active={data.active}
          busy={busy}
          run={run}
          setNote={setNote}
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
  // What the cards start on, not the plan's own archives: a card whose planned archive is refused starts on the free slot.
  const counts = presetCounts(data.items, s);

  return (
    <div className="min-h-screen bg-neutral-950 text-[14px] text-neutral-200">
      {/* The status wraps (min-w-0, no truncate) instead of being cut off; the header grows with it (#779). */}
      <header className="sticky top-0 z-30 flex min-h-12 items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-4 py-2 backdrop-blur">
        <nav className="flex max-w-[55%] min-w-0 shrink-0 items-center gap-1.5 text-neutral-500">
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
        <span
          className={`hidden min-w-0 flex-1 text-right sm:block ${data.blocker ? "text-amber-200" : "text-emerald-300"}`}
        >
          {plain(data.blocker ?? "Every item is settled.")}
        </span>
        <span className="flex-1 sm:hidden" />
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
          The voice work for {data.issueName}: every voice asked for on the
          Characters screen, and every speaker with no voice. Pick a voice for
          each, read what it costs, then add it and hear a few lines before the
          audio is made. Nothing is added or archived until you click Add.
        </p>
        {s && (
          <p className="mb-2 text-neutral-300">
            Voice slots: {s.used} of {s.limit} used, {s.free} free. Voice
            changes this month: {s.addEditUsed} of {s.addEditMax}. This list
            needs {counts.adds} {counts.adds === 1 ? "voice" : "voices"} added
            and {counts.archives} {counts.archives === 1 ? "voice" : "voices"}{" "}
            archived.
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
          blurb="Pick a voice for each. A clone or a new designed voice takes a slot; a voice already active does not."
          items={by("pending")}
        >
          {card}
        </Section>
        <Section
          title="Made"
          blurb="Hear a few lines, then accept the voice or run the item again with another."
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
