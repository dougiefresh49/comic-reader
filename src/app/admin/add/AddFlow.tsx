"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { wikiPageUrl, wikiTitleWords } from "~/lib/add-content/wiki";
import { createBook, searchForBook } from "../add-book/actions";
import { confirmSource, createIssue } from "../add-issue/actions";
import { SourceConfirm, type CheckedSource } from "../add-issue/SourceConfirm";
import { bookExists, wikiCover } from "./actions";
import { type DiskFile } from "./DiskPages";
import {
  BOOK_ID,
  DISK_TYPES,
  ISSUE_ID,
  isPickable,
  issueState,
  naturalCompare,
  nextIssueNumber,
  planSeries,
  type FlowBook,
  type FlowIssue,
  type FlowSeries,
} from "./model";
import { downloadPages, uploadPages, type PageProgress } from "./save-pages";
import { bookStep, newBookStep } from "./steps/BookStep";
import { confirmStep } from "./steps/ConfirmStep";
import { issueStep } from "./steps/IssueStep";
import { diskStep, onlineStep, pagesStep } from "./steps/PagesStep";
import { doneStep, savingStep } from "./steps/SavingStep";
import type {
  BookView,
  Flow,
  NewBook,
  PagesChoice,
  SaveState,
  Step,
  StepView,
} from "./steps/shared";
import { Context, Cover, Rail, btn, type RailStep } from "./ui";

/** The rail position of each step: Book, Issue, Pages, Confirm. */
const RAIL_INDEX: Record<Step, number> = {
  book: 0,
  newBook: 0,
  issue: 1,
  pages: 2,
  online: 2,
  disk: 2,
  confirm: 3,
  saving: 3,
  done: 3,
};

const IDLE_SAVE: SaveState = {
  book: "waiting",
  issue: "waiting",
  pages: "waiting",
  progress: null,
  error: null,
  stored: 0,
  warnings: [],
};

/** Each step's panel and footer (`steps/`). */
const STEPS: Record<Step, (f: Flow) => StepView | null> = {
  book: bookStep,
  newBook: newBookStep,
  issue: issueStep,
  pages: pagesStep,
  online: onlineStep,
  disk: diskStep,
  confirm: confirmStep,
  saving: savingStep,
  done: doneStep,
};

/**
 * The Add content shell (#793): state, the writes Confirm runs, the header,
 * the step rail and the frame.
 */
export function AddFlow({
  books,
  series,
  issues,
  resume,
  stopped,
  initialBookId,
  initialIssueId,
}: {
  books: FlowBook[];
  series: FlowSeries[];
  issues: FlowIssue[];
  resume: { bookId: string; issueId: string } | null;
  stopped: { bookId: string; issueId: string } | null;
  initialBookId: string | null;
  initialIssueId: string | null;
}) {
  const startBook = books.find((b) => b.id === initialBookId) ?? null;
  const startIssue = startBook
    ? issues.find(
        (i) =>
          i.bookId === startBook.id && i.id === initialIssueId && isPickable(i),
      )
    : undefined;

  const [step, setStep] = useState<Step>(
    startIssue ? "pages" : startBook ? "issue" : "book",
  );
  /** A saved book's id, or "new" for the draft below. */
  const [bookChoice, setBookChoice] = useState<string | null>(
    startBook?.id ?? null,
  );
  const [draft, setDraft] = useState<NewBook | null>(null);
  /**
   * The book ids and `book/issue` keys this page has written, so a retry
   * skips exactly those rows and an edited id is never taken for saved.
   */
  const [writtenBooks, setWrittenBooks] = useState<string[]>([]);
  const [issueNumber, setIssueNumber] = useState<number | null>(
    startIssue?.number ?? null,
  );
  const [writtenIssues, setWrittenIssues] = useState<string[]>([]);
  const [pages, setPages] = useState<PagesChoice | null>(null);
  const [checked, setChecked] = useState<CheckedSource | null>(null);
  /** Mounts Find online; a new value starts a new search. */
  const [onlineRun, setOnlineRun] = useState<number | null>(null);
  const [files, setFiles] = useState<DiskFile[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [save, setSave] = useState<SaveState>(IDLE_SAVE);
  const abortRef = useRef<AbortController | null>(null);
  /** Set while Confirm runs, so a second click cannot start a second save. */
  const saving = useRef(false);

  // New book search (state C).
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);

  // Thumbnails are object URLs: revoke whatever is left on unmount.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(
    () => () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.url)),
    [],
  );

  // ─── Derived ───────────────────────────────────────────────────────────────

  const seriesPlan = draft ? planSeries(series, books, draft) : null;
  const saved = books.find((b) => b.id === bookChoice) ?? null;
  const book: BookView | null =
    bookChoice === "new" && draft
      ? {
          id: draft.id,
          name: draft.result.title,
          cover: draft.cover,
          wikiHost: draft.result.wikiHost,
          wikiTitleTemplate: draft.result.wikiTitleTemplate,
          isNew: !writtenBooks.includes(draft.id),
        }
      : saved
        ? {
            id: saved.id,
            name: saved.name,
            cover: saved.cover,
            wikiHost: saved.wikiHost,
            wikiTitleTemplate: saved.wikiTitleTemplate,
            isNew: false,
          }
        : null;
  const bookIssues = book ? issues.filter((i) => i.bookId === book.id) : [];
  const next = nextIssueNumber(bookIssues);
  const number = issueNumber ?? next;
  const issueId = `issue-${number}`;
  const existingIssue = bookIssues.find((i) => i.number === number);
  const issueIsNew =
    !existingIssue && !writtenIssues.includes(`${book?.id}/${issueId}`);
  const searchTitle = book?.wikiTitleTemplate
    ? wikiTitleWords(book.wikiTitleTemplate, number)
    : `${book?.name ?? ""} Issue ${number}`;

  // ─── Choices ───────────────────────────────────────────────────────────────

  function clearPages() {
    files.forEach((f) => URL.revokeObjectURL(f.url));
    setFiles([]);
    setSkipped(0);
    setPages(null);
    setChecked(null);
    setOnlineRun(null);
  }

  /**
   * The draft the Issue step was opened with, so a new search or book id
   * resets it. A series edit does not: the issue and pages stay.
   */
  const usedDraft = useRef<NewBook | null>(null);

  function pickBook(id: string) {
    const changed =
      id !== bookChoice ||
      (id === "new" &&
        (usedDraft.current?.result !== draft?.result ||
          usedDraft.current?.id !== draft?.id));
    if (id === "new") usedDraft.current = draft;
    if (changed) {
      setIssueNumber(null);
      clearPages();
    }
    setBookChoice(id);
    setStep("issue");
  }

  function pickIssue(n: number) {
    if (n !== number) clearPages();
    setIssueNumber(n);
  }

  function continueResume() {
    if (!resume) return;
    const iss = issues.find(
      (i) => i.bookId === resume.bookId && i.id === resume.issueId,
    );
    if (!iss) return;
    clearPages();
    setBookChoice(resume.bookId);
    setIssueNumber(iss.number);
    setStep("pages");
  }

  async function runBookSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    setDraft(null);
    const res = await searchForBook(q);
    setSearching(false);
    if (!res.ok) {
      setSearchError(res.error);
      return;
    }
    const r = res.data;
    setDraft({
      result: r,
      id: r.suggestedSlug,
      cover: null,
      seriesName: r.seriesName ?? "",
      volume: r.volumeNumber != null ? String(r.volumeNumber) : "",
      attach: {},
    });
    if (r.wikiHost && r.wikiTitleTemplate) {
      const cover = await wikiCover({
        wikiHost: r.wikiHost,
        wikiTitleTemplate: r.wikiTitleTemplate,
        issueNumber: 1,
      }).catch(() => null);
      setDraft((d) => (d?.result === r ? { ...d, cover } : d));
    }
  }

  function bookIdProblem(id: string): string | null {
    if (!BOOK_ID.test(id)) return "lowercase, digits, dashes";
    if (books.some((b) => b.id === id)) return `${id} is taken by another book`;
    return null;
  }

  function issueIdProblem(id: string): string | null {
    const m = ISSUE_ID.exec(id);
    if (!m) return "issue-, then a number";
    const iss = bookIssues.find((i) => i.number === Number(m[1]));
    if (iss && !isPickable(iss)) {
      return issueState(iss) === "pipeline"
        ? `${id} is in the pipeline`
        : `${id} already has pages`;
    }
    return null;
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const all = Array.from(list);
    const accepted = all.filter((f) => DISK_TYPES.includes(f.type));
    setSkipped(all.length - accepted.length);
    setFiles((prev) => {
      const names = new Set(accepted.map((f) => f.name));
      // A file added again by name replaces the earlier one.
      const kept = prev.filter((p) => {
        if (!names.has(p.file.name)) return true;
        URL.revokeObjectURL(p.url);
        return false;
      });
      const added = accepted.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      }));
      return [...kept, ...added].sort((a, b) =>
        naturalCompare(a.file.name, b.file.name),
      );
    });
  }

  function removeFile(index: number) {
    setFiles((prev) => {
      const gone = prev[index];
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((_, i) => i !== index);
    });
  }

  function openOnline() {
    if (onlineRun === null) setOnlineRun(Date.now());
    setStep("online");
  }

  // ─── Confirm: book, then issue, then pages, in that order ────────────────

  async function confirmAndSave() {
    if (!book || !pages || saving.current) return;
    saving.current = true;
    try {
      await runSave(book, pages);
    } finally {
      saving.current = false;
    }
  }

  async function runSave(book: BookView, pages: PagesChoice) {
    const controller = new AbortController();
    abortRef.current = controller;
    setSave({
      ...IDLE_SAVE,
      book: book.isNew ? "saving" : "saved",
      issue: book.isNew ? "waiting" : "saving",
    });
    setStep("saving");
    const fail = (row: "book" | "issue" | "pages", error: string) =>
      setSave((s) => ({ ...s, [row]: "error", error }));

    if (book.isNew && draft) {
      const r = draft.result;
      const res = await createBook({
        slug: book.id,
        title: r.title,
        wikiHost: r.wikiHost,
        wikiTitleTemplate: r.wikiTitleTemplate,
        publisher: r.publisher,
        franchises: r.franchises,
        totalIssues: r.totalIssues,
        seriesName: seriesPlan?.series?.name ?? null,
        volumeNumber: seriesPlan?.volume ?? null,
        attach: (seriesPlan?.attach ?? []).map(({ bookId, position }) => ({
          bookId,
          position,
        })),
      });
      // The books row goes in before the series books and franchise links;
      // when only those failed, the book is saved and the save carries on.
      const exists = res.ok || (await bookExists(book.id).catch(() => false));
      if (!exists) return fail("book", res.ok ? "" : res.error);
      setWrittenBooks((w) => [...w, book.id]);
      setSave((s) => ({
        ...s,
        book: "saved",
        issue: "saving",
        // A retry finds the row this page wrote before: no warning for that.
        // createBook's error names the part that failed.
        warnings: res.ok || res.error.includes("books_pkey") ? [] : [res.error],
      }));
    }

    const wikiUrl =
      book.wikiHost && book.wikiTitleTemplate
        ? wikiPageUrl(book.wikiHost, book.wikiTitleTemplate, number)
        : "";
    if (pages.kind === "online") {
      // Creates the issue when it is new, and saves the checked URL on it.
      const res = await confirmSource({
        bookId: book.id,
        issueNumber: number,
        wikiUrl,
        sourceUrl: pages.source.url,
      });
      if (!res.ok) return fail("issue", res.error);
    } else if (issueIsNew) {
      const res = await createIssue({
        bookId: book.id,
        issueNumber: number,
        wikiUrl,
        sourceUrl: "",
      });
      if (!res.ok) return fail("issue", res.error);
    }
    setWrittenIssues((w) => [...w, `${book.id}/${issueId}`]);
    if (pages.kind === "none") {
      setSave((s) => ({ ...s, issue: "saved", pages: "saved" }));
      setStep("done");
      return;
    }
    setSave((s) => ({ ...s, issue: "saved", pages: "saving" }));

    const onProgress = (progress: PageProgress) =>
      setSave((s) => ({ ...s, progress }));
    try {
      const res =
        pages.kind === "online"
          ? await downloadPages({
              bookId: book.id,
              issueId,
              expectedCount: pages.source.pageCount,
              signal: controller.signal,
              onProgress,
            })
          : await uploadPages({
              bookId: book.id,
              issueId,
              number,
              files: files.map((f) => f.file),
              signal: controller.signal,
              onProgress,
            });
      if (!res.ok) return fail("pages", res.error);
      setSave((s) => ({
        ...s,
        pages: "saved",
        stored: res.stored,
        warnings: [...s.warnings, ...res.warnings],
      }));
      setStep("done");
    } catch (e) {
      if (controller.signal.aborted) return;
      fail("pages", e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
    }
  }

  /**
   * Stop (disk) or Leave (online) keeps what is saved. An online download
   * goes on storing on the server after the abort, so the Book step says so
   * for that issue (`?stopped=`) and offers no Continue on it.
   */
  function stop() {
    abortRef.current?.abort();
    window.location.assign(
      pages?.kind === "online" && book
        ? `/admin/add?stopped=${encodeURIComponent(`${book.id}/${issueId}`)}`
        : "/admin/add",
    );
  }

  // ─── Frame ─────────────────────────────────────────────────────────────────

  const at = RAIL_INDEX[step];
  const locked = step === "saving" || step === "done";
  const pagesLabel =
    pages?.kind === "online"
      ? `${pages.source.pageCount} online`
      : pages?.kind === "disk"
        ? `${files.length} files`
        : pages?.kind === "none"
          ? "none yet"
          : undefined;
  const railState = (i: number): RailStep["state"] =>
    i === at ? "on" : i < at ? "done" : "todo";
  const revisit = (i: number, to: Step) =>
    !locked && i < at ? () => setStep(to) : undefined;
  const rail: RailStep[] = [
    {
      key: "book",
      label: "Book",
      state: railState(0),
      value:
        at > 0 && book ? (
          <>
            <Cover
              src={book.cover}
              title={book.name}
              label={false}
              className="h-5 w-3.5 flex-none rounded-[2px]"
            />
            <span className="truncate">{book.name}</span>
          </>
        ) : undefined,
      onClick: revisit(0, bookChoice === "new" ? "newBook" : "book"),
    },
    {
      key: "issue",
      label: "Issue",
      state: railState(1),
      value: at > 1 ? String(number) : undefined,
      onClick: revisit(1, "issue"),
    },
    {
      key: "pages",
      label: "Pages",
      state: railState(2),
      value: at > 2 ? pagesLabel : undefined,
      onClick: revisit(2, "pages"),
    },
    { key: "confirm", label: "Confirm", state: railState(3) },
  ];

  const issueContext = book && (
    <Context
      cover={book.cover}
      title={`${book.name} · Issue ${number}`}
      ids={[book.id, `/ ${issueId}`]}
    />
  );

  const flow: Flow = {
    books,
    issues,
    resume,
    stopped,
    setStep,
    bookChoice,
    draft,
    setDraft,
    seriesPlan,
    book,
    bookIssues,
    next,
    number,
    issueId,
    existingIssue,
    issueIsNew,
    issueContext,
    query,
    setQuery,
    searching,
    searchError,
    queryInput,
    runBookSearch,
    bookIdProblem,
    issueIdProblem,
    pickBook,
    pickIssue,
    continueResume,
    openOnline,
    pages,
    setPages,
    checked,
    files,
    skipped,
    addFiles,
    removeFile,
    save,
    confirmAndSave,
    stop,
  };
  const view = STEPS[step](flow);

  // F0–F4: kept mounted once started, so Back from Confirm finds the same
  // result. An unsaved book's search fields go with it (#792 `book`).
  const online =
    book && onlineRun !== null ? (
      <div hidden={step !== "online"}>
        <SourceConfirm
          key={`${book.id}/${number}/${onlineRun}`}
          bookId={book.id}
          issueNumber={number}
          searchTitle={searchTitle}
          fromWikiTitle={book.wikiTitleTemplate !== null}
          book={
            book.isNew
              ? {
                  name: book.name,
                  wiki_host: book.wikiHost,
                  wiki_title_template: book.wikiTitleTemplate,
                }
              : undefined
          }
          onChecked={setChecked}
        />
      </div>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-sm text-neutral-100">
      <header className="flex h-[54px] items-center gap-4 border-b border-[#2a2a2a] bg-neutral-900 px-[22px]">
        <div className="whitespace-nowrap text-neutral-400">
          <Link href="/admin" className="hover:text-neutral-100">
            Admin
          </Link>
          <span className="mx-1.5 text-neutral-500">/</span>
          <b className="font-semibold text-neutral-100">Add content</b>
        </div>
        <div className="flex-1" />
        {!locked && (
          <Link href="/admin" className={btn("ghost")}>
            Cancel
          </Link>
        )}
      </header>
      <Rail steps={rail} />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-[22px] pb-5">
        <div className="min-h-[420px] rounded-b-xl border border-t-0 border-[#2a2a2a] bg-neutral-900 px-6 pt-[22px] pb-6">
          {view?.body}
          {online}
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-2.5 px-[22px] pt-3 pb-7">
        {view?.footer}
      </footer>
    </div>
  );
}
