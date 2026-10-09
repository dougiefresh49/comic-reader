"use client";

import type { ReactNode } from "react";
import {
  CheckIcon,
  Choice,
  Cover,
  Heading,
  HomeIcon,
  MONO,
  PlayIcon,
  PlusIcon,
  Spinner,
  WriteList,
  WriteRow,
  btn,
} from "../ui";
import { plannedPagesRow } from "./ConfirmStep";
import {
  Note,
  Spacer,
  type Flow,
  type RowState,
  type StepView,
} from "./shared";

/** I: the rows Confirm is writing, book then issue then pages. */
export function savingStep(f: Flow): StepView | null {
  const { book, pages, save, files } = f;
  if (!book || !pages) return null;
  const status = (row: RowState): ReactNode => {
    if (row === "saved")
      return (
        <span className="inline-flex items-center gap-1 font-semibold text-emerald-400">
          <CheckIcon /> saved
        </span>
      );
    if (row === "saving") return <Spinner />;
    if (row === "error")
      return <span className="text-red-300">{save.error}</span>;
    return null;
  };
  const progress = save.progress;
  const total = pages.kind === "online" ? pages.source.pageCount : files.length;

  const pagesRow =
    pages.kind === "none" || save.pages === "waiting" ? (
      plannedPagesRow(f)
    ) : (
      <WriteRow
        k="Pages"
        title={
          save.pages === "saved"
            ? `${save.stored} of ${total}`
            : `${progress?.current ?? 0} of ${progress?.total ?? total}`
        }
      >
        {save.pages === "error" ? (
          <span className="text-red-300">{save.error}</span>
        ) : (
          <span className={`${MONO} truncate text-neutral-500`}>
            {progress?.detail ?? ""}
          </span>
        )}
        <span className="mt-1.5 block h-1.5 w-full max-w-[420px] overflow-hidden rounded-[3px] bg-[#303030]">
          <i
            className="block h-full bg-emerald-400 transition-all"
            style={{
              width: `${progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
            }}
          />
        </span>
      </WriteRow>
    );

  const body = (
    <>
      {f.issueContext}
      <Heading title="Saving" />
      <WriteList>
        <WriteRow k="Book" title={book.name}>
          {status(save.book)}
        </WriteRow>
        <WriteRow k="Issue" title={`Issue ${f.number}`}>
          {status(save.issue)}
        </WriteRow>
        {pagesRow}
      </WriteList>
    </>
  );
  const footer = save.error ? (
    <>
      <button
        type="button"
        onClick={() => f.setStep("confirm")}
        className={btn("ghost")}
      >
        ← Back
      </button>
      <Spacer />
    </>
  ) : (
    <>
      <Note>
        {pages.kind === "online"
          ? "Stop keeps what is saved. Pages may still arrive after Stop."
          : "Stop keeps what is saved. You can continue later from the book."}
      </Note>
      <Spacer />
      <button type="button" onClick={f.stop} className={btn("ghost")}>
        Stop
      </button>
    </>
  );
  return { body, footer };
}

/** J: what next. Start Pipeline is a link to the admin page, never a call. */
export function doneStep(f: Flow): StepView | null {
  const { book, pages, save, files, number } = f;
  if (!book || !pages) return null;
  const after = Math.max(f.next, number + 1);
  const expected =
    pages.kind === "online"
      ? pages.source.pageCount
      : pages.kind === "disk"
        ? files.length
        : 0;
  const body = (
    <>
      <div className="mb-[22px] flex items-center gap-4">
        <Cover
          src={book.cover}
          title={book.name}
          label={false}
          className="h-[82px] w-14 flex-none rounded-lg"
        />
        <div>
          <div className="text-xl font-semibold">
            <span className="mr-1.5 text-emerald-400">
              <CheckIcon className="h-4 w-4" />
            </span>
            Issue {number} saved ·{" "}
            {pages.kind === "none" ? "no pages yet" : `${save.stored} pages`}
          </div>
          <div className={`${MONO} text-neutral-500`}>
            {book.id} / {f.issueId}
            {pages.kind !== "none" && " · pages-downloaded"}
          </div>
          {pages.kind !== "none" && save.stored < expected && (
            <div className="mt-1 text-[12.5px] text-amber-400">
              {expected - save.stored} of {expected} pages did not store.
            </div>
          )}
          {save.warnings.map((w) => (
            <div key={w} className={`${MONO} mt-1 text-amber-400`}>
              {w}
            </div>
          ))}
        </div>
      </div>
      <Heading title="What next?" />
      <div className="grid max-w-[860px] grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Choice
          icon={<PlusIcon className="mb-1.5 h-[26px] w-[26px]" />}
          title={`Add issue ${after}`}
          sub="same book, same flow"
          href={`/admin/add?book=${encodeURIComponent(book.id)}`}
        />
        <Choice
          warn
          icon={<PlayIcon className="mb-1.5 h-[26px] w-[26px]" />}
          title="Start Pipeline ↗"
          sub="the button on the admin page. This flow never starts it."
          href="/admin"
        />
        <Choice
          icon={<HomeIcon className="mb-1.5 h-[26px] w-[26px]" />}
          title="Done"
          sub="back to admin"
          href="/admin"
        />
      </div>
    </>
  );
  return { body, footer: <Spacer /> };
}
