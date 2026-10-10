"use client";

/**
 * What the Add content shell hands each step (#793), and the pieces the steps
 * share. A step is a plain function of the flow that returns its panel body
 * and its footer; all state stays in the shell (`AddFlow.tsx`).
 */
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import type { BookSearchResult } from "../../add-book/actions";
import type { CheckedSource } from "../../add-issue/SourceConfirm";
import type { DiskFile } from "../DiskPages";
import type { FlowBook, FlowIssue, SeriesFields, SeriesPlan } from "../model";
import type { PageProgress } from "../save-pages";
import { btn } from "../ui";

export type Step =
  | "book"
  | "newBook"
  | "issue"
  | "pages"
  | "online"
  | "disk"
  | "confirm"
  | "saving"
  | "done";

/** The searched book, with the series fields as edited (from the search). */
export interface NewBook extends SeriesFields {
  result: BookSearchResult;
  id: string;
  cover: string | null;
}

/** The book the flow is on, saved or not. */
export interface BookView {
  id: string;
  name: string;
  cover: string | null;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  isNew: boolean;
}

export type PagesChoice =
  | { kind: "online"; source: CheckedSource }
  | { kind: "disk" }
  | { kind: "none" };

export type RowState = "waiting" | "saving" | "saved" | "error";

export interface SaveState {
  book: RowState;
  issue: RowState;
  pages: RowState;
  progress: PageProgress | null;
  error: string | null;
  stored: number;
  warnings: string[];
}

export interface StepView {
  body: ReactNode;
  footer: ReactNode;
}

/** The shell's state and actions, as the steps read them. */
export interface Flow {
  books: FlowBook[];
  issues: FlowIssue[];
  resume: { bookId: string; issueId: string } | null;
  /** The issue whose online download was stopped, from `?stopped=`. */
  stopped: { bookId: string; issueId: string } | null;
  setStep: (step: Step) => void;

  bookChoice: string | null;
  draft: NewBook | null;
  setDraft: (update: (d: NewBook | null) => NewBook | null) => void;
  /** What the draft's series fields write; null with no draft. */
  seriesPlan: SeriesPlan | null;
  book: BookView | null;
  bookIssues: FlowIssue[];
  next: number;
  number: number;
  issueId: string;
  existingIssue: FlowIssue | undefined;
  issueIsNew: boolean;
  /** The `Book · Issue N` header of the Pages and Confirm steps. */
  issueContext: ReactNode;

  query: string;
  setQuery: (q: string) => void;
  searching: boolean;
  searchError: string | null;
  queryInput: RefObject<HTMLInputElement | null>;
  runBookSearch: () => Promise<void>;
  bookIdProblem: (id: string) => string | null;
  issueIdProblem: (id: string) => string | null;

  pickBook: (id: string) => void;
  pickIssue: (n: number) => void;
  continueResume: () => void;
  openOnline: () => void;

  pages: PagesChoice | null;
  setPages: (p: PagesChoice) => void;
  checked: CheckedSource | null;
  files: DiskFile[];
  skipped: number;
  addFiles: (list: FileList | null) => void;
  removeFile: (index: number) => void;

  save: SaveState;
  confirmAndSave: () => Promise<void>;
  stop: () => void;
}

export const pad = (n: number) => String(n).padStart(2, "0");

export function Note({ children }: { children: string }) {
  return <span className="text-xs text-neutral-500">{children}</span>;
}

export const Spacer = () => <div className="flex-1" />;

/** `← Back` to a step, or to the admin home. */
export function Back({ f, to }: { f: Flow; to: Step | "admin" }) {
  return to === "admin" ? (
    <Link href="/admin" className={btn("ghost")}>
      ← Back
    </Link>
  ) : (
    <button
      type="button"
      onClick={() => f.setStep(to)}
      className={btn("ghost")}
    >
      ← Back
    </button>
  );
}

// ─── Pick cards ──────────────────────────────────────────────────────────────

const CARD_BASE =
  "relative flex flex-col overflow-hidden rounded-[11px] border bg-neutral-800 text-left";
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";
/** A pickable card; `selected` swaps the border for the emerald ring. */
export const card = (selected: boolean) =>
  `${CARD_BASE} transition hover:-translate-y-px ${FOCUS} ${selected ? "border-emerald-400 ring-1 ring-emerald-400" : "border-neutral-700 hover:border-[#5a5a5a]"}`;
export const CARD_OFF = `${CARD_BASE} border-neutral-700 opacity-45`;
export const CARD_NAME =
  "px-2.5 pt-2 pb-0.5 text-[13px] leading-tight font-semibold";
export const CARD_META =
  "flex flex-wrap items-center gap-1.5 px-2.5 pb-[9px] text-[11.5px] text-neutral-400";
export const cardNew = (selected: boolean) =>
  `relative flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-[11px] border border-dashed font-medium transition hover:text-neutral-100 ${FOCUS} ${selected ? "border-emerald-400 text-neutral-100 ring-1 ring-emerald-400" : "border-neutral-700 text-neutral-500"}`;

export function SelDot() {
  return (
    <span
      aria-hidden
      className="absolute top-2 right-2 z-10 h-[18px] w-[18px] rounded-full bg-emerald-400"
    />
  );
}

export function PlusCircle() {
  return (
    <span className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-neutral-700 text-[22px] leading-none">
      +
    </span>
  );
}
