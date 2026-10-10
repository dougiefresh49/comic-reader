"use client";

import type { ReactNode } from "react";
import { Chip, Cover, Heading, MONO, WriteList, WriteRow, btn } from "../ui";
import {
  Back,
  Note,
  Spacer,
  pad,
  type Flow,
  type Step,
  type StepView,
} from "./shared";

/** The Pages row as planned: H1–H3, and Saving until the pages start. */
export function plannedPagesRow(f: Flow): ReactNode {
  const { pages, files } = f;
  if (!pages) return null;
  const firstFile = files[0]?.file.name ?? "";
  const lastFile = files[files.length - 1]?.file.name ?? "";

  let pagesRow: ReactNode;
  if (pages.kind === "online") {
    const n = pages.source.pageCount;
    pagesRow = (
      <WriteRow
        k="Pages"
        title={`${n} pages from ${pages.source.siteName}`}
        pic={
          <Cover
            src={pages.source.firstImageUrl}
            title="First page"
            label={false}
            className="aspect-[2/3] w-10 rounded"
          />
        }
      >
        <span className={`${MONO} break-all text-neutral-500`}>
          {pages.source.url.replace(/^https?:\/\//, "")}
        </span>
        <span className={`${MONO} text-neutral-500`}>
          page-01 → page-{pad(n)} · pipeline_step: pages-downloaded
        </span>
      </WriteRow>
    );
  } else if (pages.kind === "disk") {
    pagesRow = (
      <WriteRow
        k="Pages"
        title={`${files.length} files from your computer`}
        pic={
          <Cover
            src={files[0]?.url ?? null}
            title="First page"
            label={false}
            className="aspect-[2/3] w-10 rounded"
          />
        }
      >
        <span className={`${MONO} text-neutral-500`}>
          {files.length === 1 ? firstFile : `${firstFile} → ${lastFile}`}
        </span>
        <span className={`${MONO} text-neutral-500`}>
          stored as WebP · pipeline_step: pages-downloaded
        </span>
      </WriteRow>
    );
  } else {
    pagesRow = (
      <WriteRow k="Pages" title="None yet">
        <Chip tone="none">add later from this book</Chip>
      </WriteRow>
    );
  }
  return pagesRow;
}

/** H1–H3: what Confirm writes. Nothing is written until the button. */
export function confirmStep(f: Flow): StepView | null {
  const { book, pages } = f;
  if (!book || !pages) return null;
  const fresh = (isNew: boolean) =>
    isNew ? <Chip tone="ok">new</Chip> : <Chip tone="none">saved</Chip>;
  // The series fields as edited in the Book step, for a new book only.
  const plan = book.isNew && f.bookChoice === "new" ? f.seriesPlan : null;
  const series = plan?.series ?? null;
  const seriesPart = series?.isNew ? "+ series, franchises" : "+ franchises";
  const body = (
    <>
      {f.issueContext}
      <Heading title="Confirm" />
      <div className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] text-neutral-400">
        <span className="h-2 w-2 rounded-full border-[1.5px] border-neutral-500" />
        {book.isNew && f.issueIsNew
          ? "Nothing is saved yet. This is what Confirm writes."
          : "Nothing new is saved yet. This is what Confirm writes."}
      </div>
      <WriteList>
        <WriteRow
          k="Book"
          title={book.name}
          pic={
            <Cover
              src={book.cover}
              title={book.name}
              label={false}
              className="aspect-[2/3] w-10 rounded"
            />
          }
        >
          {fresh(book.isNew)}
          <span className={`${MONO} text-neutral-500`}>books · {book.id}</span>
          {book.isNew && (
            <span className={`${MONO} text-neutral-500`}>{seriesPart}</span>
          )}
        </WriteRow>
        {plan && series && (
          <WriteRow
            k="Series"
            title={
              plan.volume !== null
                ? `${series.name} · Vol. ${plan.volume}`
                : series.name
            }
          >
            {fresh(series.isNew)}
            <span className={`${MONO} text-neutral-500`}>
              series · {series.id}
            </span>
            {plan.attach.map((a) => (
              <span key={a.bookId} className="basis-full">
                {a.name} → Vol. {a.position}
              </span>
            ))}
          </WriteRow>
        )}
        <WriteRow k="Issue" title={`Issue ${f.number}`}>
          {fresh(f.issueIsNew)}
          <span className={`${MONO} text-neutral-500`}>
            issues · {book.id} / {f.issueId}
          </span>
        </WriteRow>
        {plannedPagesRow(f)}
      </WriteList>
    </>
  );

  const backTo: Step =
    pages.kind === "online"
      ? "online"
      : pages.kind === "disk"
        ? "disk"
        : "pages";
  const footer = (
    <>
      <Back f={f} to={backTo} />
      <Note>
        {pages.kind === "online"
          ? "Downloads only from the URL above."
          : pages.kind === "disk"
            ? "Uploads these files, in this order."
            : book.isNew
              ? plan?.series
                ? "Writes the book, series and issue rows only."
                : "Writes the book and issue rows only."
              : "Writes the issue row only."}
      </Note>
      <Spacer />
      <button
        type="button"
        onClick={() => void f.confirmAndSave()}
        className={btn("primary")}
      >
        Confirm and save
      </button>
    </>
  );
  return { body, footer };
}
