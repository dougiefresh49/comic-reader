"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { wikiPageUrl, wikiTitleWords } from "~/lib/add-content/wiki";
import { isUnstartedStep } from "~/lib/pipeline-steps";
import {
  createBook,
  searchForBook,
  type BookSearchResult,
} from "../add-book/actions";
import { confirmSource, createIssue } from "../add-issue/actions";
import { SourceConfirm, type CheckedSource } from "../add-issue/SourceConfirm";
import { wikiCover } from "./actions";
import { DiskPages, type DiskFile } from "./DiskPages";
import {
  BOOK_ID,
  DISK_TYPES,
  ISSUE_ID,
  isPickable,
  naturalCompare,
  nextIssueNumber,
  type FlowBook,
  type FlowIssue,
} from "./model";
import { downloadPages, uploadPages, type PageProgress } from "./save-pages";
import {
  CheckIcon,
  Chip,
  Choice,
  Context,
  Cover,
  DiskIcon,
  FIELD,
  GlobeIcon,
  Heading,
  HomeIcon,
  IdLine,
  MONO,
  PlayIcon,
  PlusIcon,
  Rail,
  Spinner,
  WriteList,
  WriteRow,
  btn,
  type RailStep,
} from "./ui";

type Step =
  | "book"
  | "newBook"
  | "issue"
  | "pages"
  | "online"
  | "disk"
  | "confirm"
  | "saving"
  | "done";

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

interface NewBook {
  result: BookSearchResult;
  id: string;
  cover: string | null;
}

/** The book the flow is on, saved or not. */
interface BookView {
  id: string;
  name: string;
  cover: string | null;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  isNew: boolean;
}

type PagesChoice =
  | { kind: "online"; source: CheckedSource }
  | { kind: "disk" }
  | { kind: "none" };

type RowState = "waiting" | "saving" | "saved" | "error";

interface SaveState {
  book: RowState;
  issue: RowState;
  pages: RowState;
  progress: PageProgress | null;
  error: string | null;
  stored: number;
  warnings: string[];
}

const IDLE_SAVE: SaveState = {
  book: "waiting",
  issue: "waiting",
  pages: "waiting",
  progress: null,
  error: null,
  stored: 0,
  warnings: [],
};

const pad = (n: number) => String(n).padStart(2, "0");

export function AddFlow({
  books,
  issues,
  resume,
  initialBookId,
  initialIssueId,
}: {
  books: FlowBook[];
  issues: FlowIssue[];
  resume: { bookId: string; issueId: string } | null;
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
  /** Set once Confirm has written the draft book, so a retry skips it. */
  const [bookWritten, setBookWritten] = useState(false);
  const [issueNumber, setIssueNumber] = useState<number | null>(
    startIssue?.number ?? null,
  );
  const [issueWritten, setIssueWritten] = useState(false);
  const [pages, setPages] = useState<PagesChoice | null>(null);
  const [checked, setChecked] = useState<CheckedSource | null>(null);
  /** Mounts Find online; a new value starts a new search. */
  const [onlineRun, setOnlineRun] = useState<number | null>(null);
  const [files, setFiles] = useState<DiskFile[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [save, setSave] = useState<SaveState>(IDLE_SAVE);
  const abortRef = useRef<AbortController | null>(null);

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

  const saved = books.find((b) => b.id === bookChoice) ?? null;
  const book: BookView | null =
    bookChoice === "new" && draft
      ? {
          id: draft.id,
          name: draft.result.title,
          cover: draft.cover,
          wikiHost: draft.result.wikiHost,
          wikiTitleTemplate: draft.result.wikiTitleTemplate,
          isNew: !bookWritten,
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
  const issueIsNew = !existingIssue && !issueWritten;
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

  /** The draft the Issue step was opened with, so a new draft resets it. */
  const usedDraft = useRef<NewBook | null>(null);

  function pickBook(id: string) {
    const changed =
      id !== bookChoice || (id === "new" && usedDraft.current !== draft);
    if (id === "new") usedDraft.current = draft;
    if (changed) {
      setIssueNumber(null);
      setIssueWritten(false);
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
    setIssueWritten(false);
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
    setBookWritten(false);
    const res = await searchForBook(q);
    setSearching(false);
    if (!res.ok) {
      setSearchError(res.error);
      return;
    }
    const r = res.data;
    setDraft({ result: r, id: r.suggestedSlug, cover: null });
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
      return iss.pageCount > 0
        ? `${id} already has pages`
        : `${id} is in the pipeline`;
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
    if (!book || !pages) return;
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
        seriesName: r.seriesName,
        volumeNumber: r.volumeNumber,
      });
      if (!res.ok) return fail("book", res.error);
      setBookWritten(true);
      setSave((s) => ({ ...s, book: "saved", issue: "saving" }));
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
    setIssueWritten(true);
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
        warnings: res.warnings,
      }));
      setStep("done");
    } catch (e) {
      if (controller.signal.aborted) return;
      fail("pages", e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
    }
  }

  /** Stop keeps what is saved; the resume banner picks it up. */
  function stop() {
    abortRef.current?.abort();
    window.location.assign("/admin/add");
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

  let body: ReactNode = null;
  let footer: ReactNode = null;
  const note = (text: string) => (
    <span className="text-xs text-neutral-500">{text}</span>
  );
  const back = (to: Step | "admin") =>
    to === "admin" ? (
      <Link href="/admin" className={btn("ghost")}>
        ← Back
      </Link>
    ) : (
      <button
        type="button"
        onClick={() => setStep(to)}
        className={btn("ghost")}
      >
        ← Back
      </button>
    );
  const spacer = <div className="flex-1" />;

  // ─── B, B2: which book ─────────────────────────────────────────────────────
  if (step === "book") {
    const resumeIssue = resume
      ? issues.find(
          (i) => i.bookId === resume.bookId && i.id === resume.issueId,
        )
      : undefined;
    const resumeBook = resume
      ? books.find((b) => b.id === resume.bookId)
      : undefined;
    body = (
      <>
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
              onClick={continueResume}
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
                onClick={() => pickBook(b.id)}
                className={card(bookChoice === b.id)}
              >
                {bookChoice === b.id && <SelDot />}
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
              setStep("newBook");
              setTimeout(() => queryInput.current?.focus(), 0);
            }}
            className={cardNew(false)}
          >
            <PlusCircle />
            New book
          </button>
        </div>
      </>
    );
    footer = (
      <>
        {back("admin")}
        {note("Nothing is saved until Confirm.")}
        {spacer}
      </>
    );
  }

  // ─── C, Ce: new book from the wiki ─────────────────────────────────────────
  if (step === "newBook") {
    const r = draft?.result;
    const idProblem = draft ? bookIdProblem(draft.id) : null;
    body = (
      <>
        <Heading title="New book" sub="Searched on the wiki." />
        <form
          className="mb-[18px] flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runBookSearch();
          }}
        >
          <input
            ref={queryInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="TMNT He-Man crossover comic"
            aria-label="Book search"
            className={`${FIELD} flex-1`}
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className={btn()}
          >
            {searching && <Spinner />}
            Search
          </button>
        </form>
        {searchError && (
          <p className="mb-3 text-[12.5px] text-red-300">{searchError}</p>
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
                <Chip tone="none">
                  {r.seriesName
                    ? `${r.seriesName}${r.volumeNumber != null ? ` · Vol. ${r.volumeNumber}` : ""}`
                    : "Standalone"}
                </Chip>
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
              <IdLine
                label="book id"
                value={draft.id}
                hint="lowercase, digits, dashes"
                validate={bookIdProblem}
                onKeep={(id) => setDraft((d) => (d ? { ...d, id } : d))}
              />
              {idProblem && (
                <p className="mt-1.5 text-xs text-amber-400">{idProblem}</p>
              )}
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  disabled={idProblem !== null}
                  onClick={() => pickBook("new")}
                  className={btn("primary")}
                >
                  Use this book
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    queryInput.current?.focus();
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
    footer = (
      <>
        {back("book")}
        {note("Nothing is saved until Confirm.")}
        {spacer}
      </>
    );
  }

  // ─── D, D2: which issue ────────────────────────────────────────────────────
  if (step === "issue" && book) {
    const newNumber = existingIssue ? next : number;
    body = (
      <>
        <Context cover={book.cover} title={book.name} ids={[book.id]} />
        <Heading
          title="Which issue?"
          sub={
            bookIssues.length > 0
              ? "An issue with pages is not picked here."
              : "No issues yet."
          }
        />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {bookIssues.map((iss) => {
            const pickable = isPickable(iss);
            const selected = pickable && iss.number === number;
            const inner = (
              <>
                {selected && <SelDot />}
                <Cover
                  src={iss.cover}
                  title={`Issue ${iss.number}`}
                  className={`aspect-[2/2.6] w-full ${pickable ? "" : "grayscale-[.6]"}`}
                />
                <span className={CARD_NAME}>Issue {iss.number}</span>
                <span className={CARD_META}>
                  {pickable ? (
                    <Chip tone="none">no pages</Chip>
                  ) : isUnstartedStep(iss.pipelineStep) ? (
                    <Chip tone="ok">{iss.pageCount} pages</Chip>
                  ) : (
                    <Chip tone="run">in pipeline</Chip>
                  )}
                </span>
              </>
            );
            return pickable ? (
              <button
                key={iss.id}
                type="button"
                onClick={() => pickIssue(iss.number)}
                className={card(selected)}
              >
                {inner}
              </button>
            ) : (
              <div key={iss.id} className={CARD_OFF}>
                {inner}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => pickIssue(newNumber)}
            className={cardNew(!existingIssue)}
          >
            {!existingIssue && <SelDot />}
            <PlusCircle />
            Issue {newNumber}
            <Chip tone="none">{newNumber === next ? "next · new" : "new"}</Chip>
          </button>
        </div>
        <IdLine
          key={`${book.id}/${number}`}
          label={`Issue ${number}`}
          prefix={`${book.id} /`}
          value={issueId}
          hint="issue-, then a number"
          validate={issueIdProblem}
          onKeep={(id) => pickIssue(Number(ISSUE_ID.exec(id)![1]))}
        />
      </>
    );
    footer = (
      <>
        {back(bookChoice === "new" ? "newBook" : "book")}
        {note("Nothing is saved until Confirm.")}
        {spacer}
        <button
          type="button"
          onClick={() => setStep("pages")}
          className={btn("primary")}
        >
          Next: Pages →
        </button>
      </>
    );
  }

  // ─── E: pages, two ways ────────────────────────────────────────────────────
  if (step === "pages" && book) {
    body = (
      <>
        {issueContext}
        <Heading title="Pages" sub="Where are they?" />
        <div className="grid max-w-[760px] grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Choice
            icon={<GlobeIcon className="mb-1.5 h-[26px] w-[26px]" />}
            title="Find online"
            sub={
              book.isNew
                ? "Works once the book is saved"
                : "Searches the open web from the wiki title"
            }
            disabled={book.isNew}
            onClick={openOnline}
          />
          <Choice
            icon={<DiskIcon className="mb-1.5 h-[26px] w-[26px]" />}
            title="From my computer"
            sub="JPEG, PNG or WebP, in filename order"
            onClick={() => setStep("disk")}
          />
        </div>
        {(book.isNew || issueIsNew) && (
          <div className="mt-3.5">
            <button
              type="button"
              onClick={() => {
                setPages({ kind: "none" });
                setStep("confirm");
              }}
              className={btn("ghost")}
            >
              Save without pages →
            </button>
          </div>
        )}
      </>
    );
    footer = (
      <>
        {back("issue")}
        {note("Nothing is saved until Confirm.")}
        {spacer}
      </>
    );
  }

  // ─── F0–F4: find online ────────────────────────────────────────────────────
  // Kept mounted once started, so Back from Confirm finds the same result.
  const online =
    book && !book.isNew && onlineRun !== null ? (
      <div hidden={step !== "online"}>
        <SourceConfirm
          key={`${book.id}/${number}/${onlineRun}`}
          bookId={book.id}
          issueNumber={number}
          searchTitle={searchTitle}
          fromWikiTitle={book.wikiTitleTemplate !== null}
          onChecked={setChecked}
        />
      </div>
    ) : null;
  if (step === "online" && book) {
    body = (
      <>
        {issueContext}
        <Heading title="Find online" />
      </>
    );
    footer = (
      <>
        {back("pages")}
        {note("Nothing downloads until Confirm.")}
        {spacer}
        <button
          type="button"
          onClick={() => setStep("disk")}
          className={btn("ghost")}
        >
          From my computer instead
        </button>
        <button
          type="button"
          disabled={!checked}
          onClick={() => {
            if (!checked) return;
            setPages({ kind: "online", source: checked });
            setStep("confirm");
          }}
          className={btn("primary")}
        >
          {checked
            ? `Use these ${checked.pageCount} pages →`
            : "Use these pages"}
        </button>
      </>
    );
  }

  // ─── G1, G2: from my computer ──────────────────────────────────────────────
  if (step === "disk" && book) {
    body = (
      <>
        {issueContext}
        <Heading title="From my computer" />
        <DiskPages
          files={files}
          skipped={skipped}
          onAdd={addFiles}
          onRemove={removeFile}
        />
      </>
    );
    footer = (
      <>
        {back("pages")}
        {note("Nothing uploads until Confirm.")}
        {spacer}
        {!book.isNew && (
          <button type="button" onClick={openOnline} className={btn("ghost")}>
            Find online instead
          </button>
        )}
        <button
          type="button"
          disabled={files.length === 0}
          onClick={() => {
            setPages({ kind: "disk" });
            setStep("confirm");
          }}
          className={btn("primary")}
        >
          {files.length > 0
            ? `Use these ${files.length} pages →`
            : "Use these pages"}
        </button>
      </>
    );
  }

  // ─── H1–H3: confirm, and I: saving ─────────────────────────────────────────
  if ((step === "confirm" || step === "saving") && book && pages) {
    const saving = step === "saving";
    const status = (row: RowState, fresh: boolean) => {
      if (!saving) {
        return fresh ? (
          <Chip tone="ok">new</Chip>
        ) : (
          <Chip tone="none">saved</Chip>
        );
      }
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
    const firstFile = files[0]?.file.name ?? "";
    const lastFile = files[files.length - 1]?.file.name ?? "";
    const progress = save.progress;
    const total =
      pages.kind === "online" ? pages.source.pageCount : files.length;

    let pagesRow: ReactNode;
    if (saving && pages.kind !== "none" && save.pages !== "waiting") {
      pagesRow = (
        <WriteRow
          k="Pages"
          title={
            save.pages === "saved"
              ? `${save.stored} of ${total}`
              : `${progress?.current ?? 0} of ${progress?.total ?? total}`
          }
          pic={null}
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
    } else if (pages.kind === "online") {
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

    const seriesPart =
      draft?.result.seriesIsNew && bookChoice === "new"
        ? "+ series, franchises"
        : "+ franchises";
    body = (
      <>
        {issueContext}
        <Heading title={saving ? "Saving" : "Confirm"} />
        {!saving && (
          <div className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] text-neutral-400">
            <span className="h-2 w-2 rounded-full border-[1.5px] border-neutral-500" />
            Nothing is saved yet. This is what Confirm writes.
          </div>
        )}
        <WriteList>
          <WriteRow
            k="Book"
            title={book.name}
            pic={
              saving ? null : (
                <Cover
                  src={book.cover}
                  title={book.name}
                  label={false}
                  className="aspect-[2/3] w-10 rounded"
                />
              )
            }
          >
            {status(save.book, book.isNew)}
            {!saving && (
              <span className={`${MONO} text-neutral-500`}>
                books · {book.id}
              </span>
            )}
            {!saving && book.isNew && (
              <span className={`${MONO} text-neutral-500`}>{seriesPart}</span>
            )}
          </WriteRow>
          <WriteRow k="Issue" title={`Issue ${number}`}>
            {status(save.issue, issueIsNew)}
            {!saving && (
              <span className={`${MONO} text-neutral-500`}>
                issues · {book.id} / {issueId}
              </span>
            )}
          </WriteRow>
          {pagesRow}
        </WriteList>
      </>
    );
    const backTo: Step =
      pages.kind === "online"
        ? "online"
        : pages.kind === "disk"
          ? "disk"
          : "pages";
    footer = saving ? (
      save.error ? (
        <>
          <button
            type="button"
            onClick={() => setStep("confirm")}
            className={btn("ghost")}
          >
            ← Back
          </button>
          {spacer}
        </>
      ) : (
        <>
          {note(
            "Stop keeps what is saved. You can continue later from the book.",
          )}
          {spacer}
          <button type="button" onClick={stop} className={btn("ghost")}>
            Stop
          </button>
        </>
      )
    ) : (
      <>
        {back(backTo)}
        {note(
          pages.kind === "online"
            ? "Downloads only from the URL above."
            : pages.kind === "disk"
              ? "Uploads these files, in this order."
              : book.isNew
                ? "Writes the book and issue rows only."
                : "Writes the issue row only.",
        )}
        {spacer}
        <button
          type="button"
          onClick={() => void confirmAndSave()}
          className={btn("primary")}
        >
          Confirm and save
        </button>
      </>
    );
  }

  // ─── J: what next ──────────────────────────────────────────────────────────
  if (step === "done" && book && pages) {
    const after = Math.max(next, number + 1);
    const expected =
      pages.kind === "online"
        ? pages.source.pageCount
        : pages.kind === "disk"
          ? files.length
          : 0;
    body = (
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
              {book.id} / {issueId}
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
    footer = spacer;
  }

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
          {body}
          {online}
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-2.5 px-[22px] pt-3 pb-7">
        {footer}
      </footer>
    </div>
  );
}

const CARD_BASE =
  "relative flex flex-col overflow-hidden rounded-[11px] border bg-neutral-800 text-left";
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";
/** A pickable card; `selected` swaps the border for the emerald ring. */
const card = (selected: boolean) =>
  `${CARD_BASE} transition hover:-translate-y-px ${FOCUS} ${selected ? "border-emerald-400 ring-1 ring-emerald-400" : "border-neutral-700 hover:border-[#5a5a5a]"}`;
const CARD_OFF = `${CARD_BASE} border-neutral-700 opacity-45`;
const CARD_NAME = "px-2.5 pt-2 pb-0.5 text-[13px] leading-tight font-semibold";
const CARD_META =
  "flex flex-wrap items-center gap-1.5 px-2.5 pb-[9px] text-[11.5px] text-neutral-400";
const cardNew = (selected: boolean) =>
  `relative flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-[11px] border border-dashed font-medium transition hover:text-neutral-100 ${FOCUS} ${selected ? "border-emerald-400 text-neutral-100 ring-1 ring-emerald-400" : "border-neutral-700 text-neutral-500"}`;

function SelDot() {
  return (
    <span
      aria-hidden
      className="absolute top-2 right-2 z-10 h-[18px] w-[18px] rounded-full bg-emerald-400"
    />
  );
}

function PlusCircle() {
  return (
    <span className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-neutral-700 text-[22px] leading-none">
      +
    </span>
  );
}
