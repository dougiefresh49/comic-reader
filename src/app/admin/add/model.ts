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
  pipelineStep: string | null;
  createdAt: string | null;
  /** Page 1 when the issue has pages, else null. */
  cover: string | null;
}

/** `books.id` for a new book: lowercase letters, digits and single dashes. */
export const BOOK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `issues.id`: `issue-N`, N from 1. The issue actions derive the id from N. */
export const ISSUE_ID = /^issue-([1-9]\d*)$/;

/**
 * An issue can take pages here when it has none and no run has started.
 * One with pages, or one in the pipeline, is shown but not picked.
 */
export function isPickable(issue: FlowIssue): boolean {
  return issue.pageCount === 0 && isUnstartedStep(issue.pipelineStep);
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
