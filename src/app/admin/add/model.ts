/**
 * Shared shapes and rules for the Add content flow (#793). Client-safe.
 */
import { isUnstartedStep } from "~/lib/pipeline-steps";

/** A saved book, as the Book step's cards show it. */
export interface FlowBook {
  id: string;
  name: string;
  publisher: string | null;
  totalIssues: number | null;
  published: boolean;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  /** Page 1 of the first issue that has pages, or null. */
  cover: string | null;
}

/** A saved issue, as the Issue step's cards show it. */
export interface FlowIssue {
  bookId: string;
  id: string;
  number: number;
  pageCount: number;
  /**
   * Highest stored `pages` row number. Rows land before `page_count`, so a
   * store that stopped part way has rows and a count of 0.
   */
  storedPages: number;
  pipelineStep: string | null;
  status: string;
  createdAt: string | null;
  /** Page 1 when the issue has pages, else null. */
  cover: string | null;
}

/** `books.id` for a new book: lowercase letters, digits and single dashes. */
export const BOOK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A new book's id from its title: lowercase words joined by single dashes
 * (`/`, `:` and every other separator become a dash), at most 60 characters,
 * cut back to the last whole word. Always matches `BOOK_ID` when the title
 * has a letter or digit.
 */
export function bookIdFromTitle(title: string): string {
  const id = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (id.length <= 60) return id;
  const cut = id.slice(0, 60);
  // A cut that lands inside a word drops that word.
  const lastDash = cut.lastIndexOf("-");
  const whole = id[60] === "-" || lastDash < 0 ? cut : cut.slice(0, lastDash);
  return whole.replace(/-+$/, "") || cut.replace(/-+$/, "");
}

/** `issues.id`: `issue-N`, N from 1. The issue actions derive the id from N. */
export const ISSUE_ID = /^issue-([1-9]\d*)$/;

/**
 * Where an issue stands for the Issue step. `empty`: saved with no pages and
 * no `pages` rows, the only state that can take pages here. `unfinished`:
 * rows stored but no count, a store that stopped part way. `pipeline`: a run
 * between pages-downloaded and complete. `pages`: anything else with pages.
 */
export type IssueState = "empty" | "unfinished" | "pipeline" | "pages";

export function issueState(issue: FlowIssue): IssueState {
  const step = issue.pipelineStep;
  const ready = step === "complete" || issue.status === "ready";
  if (!isUnstartedStep(step) && !ready) return "pipeline";
  if (issue.pageCount > 0 || ready) return "pages";
  return issue.storedPages > 0 ? "unfinished" : "empty";
}

/** An issue can take pages here only when it has none stored at all. */
export function isPickable(issue: FlowIssue): boolean {
  return issueState(issue) === "empty";
}

export function nextIssueNumber(issues: FlowIssue[]): number {
  return issues.reduce((max, i) => Math.max(max, i.number), 0) + 1;
}

/** Filename order a person expects: `page-2` before `page-10`. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The image types the Pages step accepts from disk. */
export const DISK_TYPES = ["image/jpeg", "image/png", "image/webp"];
