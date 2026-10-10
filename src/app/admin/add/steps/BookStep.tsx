"use client";

import {
  CheckIcon,
  Chip,
  Cover,
  FIELD,
  Heading,
  IdLine,
  MONO,
  Spinner,
  btn,
} from "../ui";
import type { SeriesFields } from "../model";
import {
  Back,
  CARD_META,
  CARD_NAME,
  Note,
  PlusCircle,
  SelDot,
  Spacer,
  card,
  cardNew,
  type Flow,
  type NewBook,
  type StepView,
} from "./shared";

/** B, B2: which book, with the resume banner for an issue saved without pages. */
export function bookStep(f: Flow): StepView {
  const { books, issues, resume, stopped } = f;
  const resumeIssue = resume
    ? issues.find((i) => i.bookId === resume.bookId && i.id === resume.issueId)
    : undefined;
  const resumeBook = resume
    ? books.find((b) => b.id === resume.bookId)
    : undefined;
  const stoppedIssue = stopped
    ? issues.find(
        (i) => i.bookId === stopped.bookId && i.id === stopped.issueId,
      )
    : undefined;
  const stoppedBook = stopped
    ? books.find((b) => b.id === stopped.bookId)
    : undefined;

  const body = (
    <>
      {stoppedIssue && stoppedBook && (
        <p className="mb-3 text-[12.5px] text-amber-400">
          {stoppedBook.name} · Issue {stoppedIssue.number}: still downloading.
          The admin page shows the pages when it finishes.
        </p>
      )}
      {resumeIssue && resumeBook && (
        <div className="mb-5 flex items-center gap-3.5 rounded-[11px] border border-[#4a3f14] bg-[#2e2108] px-3.5 py-3">
          <Cover
            src={resumeBook.cover}
            title={resumeBook.name}
            label={false}
            className="h-[50px] w-[34px] flex-none rounded"
          />
          <div>
            <div className="font-semibold">
              Unfinished · {resumeBook.name} · Issue {resumeIssue.number}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Chip tone="ok">
                <CheckIcon /> book saved
              </Chip>
              <Chip tone="ok">
                <CheckIcon /> issue saved
              </Chip>
              <Chip tone="none">no pages yet</Chip>
            </div>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={f.continueResume}
            className={btn("primary")}
          >
            Continue →
          </button>
        </div>
      )}
      <Heading title="Which book?" sub="Pick one, or start a new one." />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {books.map((b) => {
          const count = issues.filter((i) => i.bookId === b.id).length;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => f.pickBook(b.id)}
              className={card(f.bookChoice === b.id)}
            >
              {f.bookChoice === b.id && <SelDot />}
              <Cover
                src={b.cover}
                title={b.name}
                className="aspect-[2/2.6] w-full"
              />
              <span className={CARD_NAME}>{b.name}</span>
              <span className={CARD_META}>
                {b.publisher && <span>{b.publisher}</span>}
                <span className={`${MONO} text-[11px] text-neutral-500`}>
                  {b.totalIssues
                    ? `${count}/${b.totalIssues} issues`
                    : `${count} ${count === 1 ? "issue" : "issues"}`}
                </span>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            f.setStep("newBook");
            setTimeout(() => f.queryInput.current?.focus(), 0);
          }}
          className={cardNew(false)}
        >
          <PlusCircle />
          New book
        </button>
      </div>
    </>
  );
  const footer = (
    <>
      <Back f={f} to="admin" />
      <Note>Nothing is saved until Confirm.</Note>
      <Spacer />
    </>
  );
  return { body, footer };
}

const VOLUME = `${FIELD} w-[72px] disabled:opacity-40`;

/**
 * The new book's series and volume, prefilled from the search (#822). An
 * empty name is standalone. With a name, standalone saved books can be
 * ticked to join the series at Confirm, each at its own volume.
 */
function seriesFields(f: Flow, draft: NewBook) {
  const plan = f.seriesPlan;
  if (!plan) return null;
  const { series } = plan;
  const set = (patch: Partial<SeriesFields>) =>
    f.setDraft((d) => (d ? { ...d, ...patch } : d));
  /** Ticks a book with its volume field, or unticks it with null. */
  const setAttach = (id: string, volume: string | null) =>
    f.setDraft((d) => {
      if (!d) return d;
      const attach = { ...d.attach };
      if (volume === null) delete attach[id];
      else attach[id] = volume;
      return { ...d, attach };
    });
  return (
    <>
      <div className="mt-3 grid grid-cols-[90px_1fr] items-center gap-x-3 gap-y-1.5 text-[13px]">
        <span className="text-neutral-500">Series</span>
        <div className="flex items-center gap-2">
          <input
            value={draft.seriesName}
            onChange={(e) => set({ seriesName: e.target.value })}
            placeholder="Standalone"
            aria-label="Series name"
            className={`${FIELD} min-w-0 flex-1`}
          />
          <input
            value={draft.volume}
            onChange={(e) => set({ volume: e.target.value })}
            disabled={!series}
            inputMode="numeric"
            placeholder="Vol."
            aria-label="Volume"
            className={VOLUME}
          />
        </div>
        {series && (
          <>
            <span />
            <div className="flex flex-col gap-0.5 text-xs text-neutral-500">
              <span>
                {series.isNew ? "New series" : `Joins ${series.name}`}
              </span>
              {plan.members.map((b) => (
                <span key={b.id}>
                  {b.seriesPosition !== null
                    ? `Vol. ${b.seriesPosition}`
                    : "No volume"}{" "}
                  · {b.name}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      {series && plan.standalone.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-semibold text-neutral-400">
            Also in this series
          </div>
          <ul className="flex flex-col gap-1.5">
            {plan.standalone.map((b) => {
              const on = b.id in draft.attach;
              return (
                <li key={b.id} className="flex items-center gap-2 text-[13px]">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setAttach(b.id, on ? null : "")}
                      className="accent-emerald-500"
                    />
                    <span className="truncate">{b.name}</span>
                  </label>
                  <input
                    value={draft.attach[b.id] ?? ""}
                    onChange={(e) => setAttach(b.id, e.target.value)}
                    disabled={!on}
                    inputMode="numeric"
                    placeholder="Vol."
                    aria-label={`${b.name} volume`}
                    className={VOLUME}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

/** C, Ce: a new book from the wiki, its id derived and editable on request. */
export function newBookStep(f: Flow): StepView {
  const { draft } = f;
  const r = draft?.result;
  const idProblem = draft ? f.bookIdProblem(draft.id) : null;
  const seriesProblem = f.seriesPlan?.problem ?? null;
  const body = (
    <>
      <Heading title="New book" sub="Searched on the wiki." />
      <form
        className="mb-[18px] flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void f.runBookSearch();
        }}
      >
        <input
          ref={f.queryInput}
          value={f.query}
          onChange={(e) => f.setQuery(e.target.value)}
          placeholder="TMNT He-Man crossover comic"
          aria-label="Book search"
          className={`${FIELD} flex-1`}
        />
        <button
          type="submit"
          disabled={f.searching || !f.query.trim()}
          className={btn()}
        >
          {f.searching && <Spinner />}
          Search
        </button>
      </form>
      {f.searchError && (
        <p className="mb-3 text-[12.5px] text-red-300">{f.searchError}</p>
      )}
      {draft && r && (
        <div className="grid max-w-[720px] grid-cols-[100px_1fr] gap-[18px] rounded-[11px] border border-neutral-700 bg-neutral-800 p-4 sm:grid-cols-[132px_1fr]">
          <Cover
            src={draft.cover}
            title={r.title}
            className="aspect-[2/3] w-full rounded-lg"
          />
          <div>
            <h3 className="mb-1 text-[17px] font-semibold">{r.title}</h3>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="site">{r.wikiHost}</Chip>
              <Chip tone="none">{r.totalIssues} issues</Chip>
            </div>
            <div className="mt-2 grid grid-cols-[90px_1fr] gap-x-3 gap-y-[3px] text-[13px]">
              <span className="text-neutral-500">Publisher</span>
              <span>{r.publisher}</span>
              <span className="text-neutral-500">Franchises</span>
              <span>{r.franchises.join(", ")}</span>
              <span className="text-neutral-500">Wiki</span>
              <span className={`${MONO} break-all text-neutral-400`}>
                {r.wikiHost}/wiki/
                {r.wikiTitleTemplate.replace(/^\/?(wiki\/)?/i, "")}
              </span>
            </div>
            {seriesFields(f, draft)}
            <IdLine
              label="book id"
              value={draft.id}
              hint="lowercase, digits, dashes"
              validate={f.bookIdProblem}
              onKeep={(id) => f.setDraft((d) => (d ? { ...d, id } : d))}
            />
            {seriesProblem && (
              <p className="mt-2 text-[12.5px] text-red-300">{seriesProblem}</p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                disabled={idProblem !== null || seriesProblem !== null}
                onClick={() => f.pickBook("new")}
                className={btn("primary")}
              >
                Use this book
              </button>
              <button
                type="button"
                onClick={() => {
                  f.setDraft(() => null);
                  f.queryInput.current?.focus();
                }}
                className={btn("ghost")}
              >
                Search again
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
  const footer = (
    <>
      <Back f={f} to="book" />
      <Note>Nothing is saved until Confirm.</Note>
      <Spacer />
    </>
  );
  return { body, footer };
}
