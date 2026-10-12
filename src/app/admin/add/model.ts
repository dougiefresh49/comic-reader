/**
 * Shared shapes and rules for the Add content flow (#793). Client-safe.
 */
import { franchiseSlug } from "~/lib/character-id";
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
  /** `books.series_id` and `books.series_position`; null when standalone. */
  seriesId: string | null;
  seriesPosition: number | null;
}

/** A `series` row. */
export interface FlowSeries {
  id: string;
  name: string;
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

// ─── Series (#822) ───────────────────────────────────────────────────────────

/** The series a name resolves to: an existing row, or the row a save adds. */
export interface SeriesMatch {
  id: string;
  name: string;
  isNew: boolean;
}

/**
 * The series a book joins: an existing row whose id is the name's slug, or
 * whose name matches ignoring case, spacing and punctuation, keeps its id, so
 * a later volume lands in the same series; otherwise the id a new row would
 * get. Null when there is no name. `createBook` and the Book step both use it.
 */
export function matchSeries(
  rows: FlowSeries[],
  name: string | null | undefined,
): SeriesMatch | null {
  const series = name?.trim();
  const slug = series ? franchiseSlug(series) : "";
  if (!series || !slug) return null;
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const existing = rows.find(
    (r) => r.id === slug || key(r.name) === key(series),
  );
  return existing
    ? { id: existing.id, name: existing.name, isNew: false }
    : { id: slug, name: series, isNew: true };
}

/** A volume number, kept only when it is a positive integer. */
export function volumeOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Gemini's book search answer, each field checked; `volumeNumber` is raw. */
export interface BookSearchReply {
  title: string;
  wikiUrl: string | null;
  wikiHost: string | null;
  wikiTitleTemplate: string | null;
  publisher: string | null;
  seriesName: string | null;
  franchises: string[];
  totalIssues: number | null;
  volumeNumber: unknown;
}

/**
 * Gemini's book search text as a `BookSearchReply`, or the error the Book
 * step shows. A missing or wrong-typed field becomes null (or `[]`), so a
 * one-volume book with no issue wiki pages still gets a card.
 */
export function bookSearchReply(
  text: string,
): { ok: true; data: BookSearchReply } | { ok: false; error: string } {
  const cleaned = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Not JSON: falls through to the "wasn't a book" error below.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      ok: false,
      error: "Gemini's answer wasn't a book. Try the search again.",
    };
  const reply = parsed as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const title = str(reply.title);
  if (!title)
    return {
      ok: false,
      error: "Gemini's answer had no title. Try the search again or reword it.",
    };
  return {
    ok: true,
    data: {
      title,
      wikiUrl: str(reply.wikiUrl),
      wikiHost: str(reply.wikiHost),
      wikiTitleTemplate: str(reply.wikiTitleTemplate),
      publisher: str(reply.publisher),
      seriesName: str(reply.seriesName),
      franchises: Array.isArray(reply.franchises)
        ? reply.franchises.flatMap((f: unknown) => str(f) ?? [])
        : [],
      totalIssues: volumeOrNull(reply.totalIssues),
      volumeNumber: reply.volumeNumber,
    },
  };
}

/** The Book step's series fields, as typed. */
export interface SeriesFields {
  seriesName: string;
  /** The new book's volume field; empty for none. */
  volume: string;
  /** Standalone books ticked to join the series: book id → volume field. */
  attach: Record<string, string>;
}

/**
 * A ticked book's volume field, or null when it is not ticked. Own keys only:
 * a book id such as `constructor` is not ticked by inheritance.
 */
export function attachField(
  attach: Record<string, string>,
  id: string,
): string | null {
  return Object.hasOwn(attach, id) ? (attach[id] ?? "") : null;
}

/** What the series fields will write, and the one problem that blocks them. */
export interface SeriesPlan {
  series: SeriesMatch | null;
  /** The new book's volume; null when empty or standalone. */
  volume: number | null;
  /** The matched series' saved books, by volume. Empty for a new series. */
  members: FlowBook[];
  /** Saved books with no series, the ones that can be ticked. */
  standalone: FlowBook[];
  /** Ticked books; `position` is 0 while the volume is missing or bad. */
  attach: { bookId: string; name: string; position: number }[];
  problem: string | null;
}

export function planSeries(
  rows: FlowSeries[],
  books: FlowBook[],
  fields: SeriesFields,
): SeriesPlan {
  const series = matchSeries(rows, fields.seriesName);
  const standalone = books.filter((b) => b.seriesId === null);
  if (!series) {
    return {
      series,
      volume: null,
      members: [],
      standalone,
      attach: [],
      problem: null,
    };
  }
  const read = (text: string) =>
    text.trim() === "" ? null : volumeOrNull(Number(text));
  const members = series.isNew
    ? []
    : books
        .filter((b) => b.seriesId === series.id)
        .sort(
          (a, b) =>
            (a.seriesPosition ?? Infinity) - (b.seriesPosition ?? Infinity),
        );
  const volume = read(fields.volume);
  const attach = standalone
    .filter((b) => attachField(fields.attach, b.id) !== null)
    .map((b) => ({
      bookId: b.id,
      name: b.name,
      position: read(attachField(fields.attach, b.id) ?? "") ?? 0,
    }));

  const problem = ((): string | null => {
    if (fields.volume.trim() !== "" && volume === null)
      return "Volume must be a whole number above 0.";
    const missing = attach.find((a) => a.position === 0);
    if (missing) return `${missing.name} needs a volume.`;
    // Each volume once: the series' saved books (by name), then this save's.
    const taken = new Map<number, string | null>();
    for (const b of members)
      if (b.seriesPosition !== null) taken.set(b.seriesPosition, b.name);
    const planned = [
      ...(volume !== null ? [volume] : []),
      ...attach.map((a) => a.position),
    ];
    for (const n of planned) {
      if (taken.has(n)) {
        const holder = taken.get(n);
        return holder
          ? `Vol. ${n} is already ${holder}.`
          : `Vol. ${n} is used twice.`;
      }
      taken.set(n, null);
    }
    return null;
  })();
  return { series, volume, members, standalone, attach, problem };
}

// ─── Franchises (#858) ───────────────────────────────────────────────────────

/** A `franchises` row, with how many characters it holds. */
export interface FlowFranchise {
  id: string;
  name: string;
  characters: number;
}

/** A franchise a new book links: an existing row, or a new one by name. */
export type FranchisePick = { id: string } | { newName: string };

/**
 * One entry of the new book's franchise list, in order. A `suggested` entry
 * is a search name that matched no row; it waits on a choice and blocks the
 * book until then. The picks, in this order, are the `position`s `createBook`
 * writes; the first is the default franchise for new characters.
 */
export type FranchiseEntry = FranchisePick | { suggested: string };

/**
 * The row a franchise name means: one whose id is the name's slug, or whose
 * name is the same ignoring case. No fuzzy or alias matching.
 */
export function matchFranchise(
  rows: FlowFranchise[],
  name: string,
): FlowFranchise | null {
  const slug = franchiseSlug(name);
  const lower = name.trim().toLowerCase();
  return (
    rows.find((r) => r.id === slug || r.name.toLowerCase() === lower) ?? null
  );
}

/** Whether two entries name the same franchise row (same id, or same slug). */
function sameFranchise(a: FranchiseEntry, b: FranchiseEntry): boolean {
  const key = (e: FranchiseEntry) =>
    "id" in e
      ? `id:${e.id}`
      : "newName" in e
        ? `new:${franchiseSlug(e.newName)}`
        : `suggested:${franchiseSlug(e.suggested)}`;
  return key(a) === key(b);
}

/**
 * The search's franchise names as entries: a name that matches a row with
 * characters becomes that row, the rest wait as suggestions. A name with no
 * slug is dropped, and a repeat keeps its first place.
 */
export function franchiseEntries(
  rows: FlowFranchise[],
  names: string[],
): FranchiseEntry[] {
  const entries: FranchiseEntry[] = [];
  for (const name of names) {
    if (!franchiseSlug(name)) continue;
    const row = matchFranchise(rows, name);
    // A row with no characters is left as a suggestion: it may be an empty
    // duplicate of a franchise saved under another name (#858).
    const entry: FranchiseEntry =
      row && row.characters > 0 ? { id: row.id } : { suggested: name.trim() };
    if (!entries.some((e) => sameFranchise(e, entry))) entries.push(entry);
  }
  return entries;
}

/**
 * The list with entry `index` replaced by `entry`, or removed when `entry` is
 * null. When `entry` names a franchise already in the list, the earlier of
 * the two places keeps it and the later one goes.
 */
export function setFranchiseEntry(
  entries: FranchiseEntry[],
  index: number,
  entry: FranchiseEntry | null,
): FranchiseEntry[] {
  if (entry === null) return entries.filter((_, i) => i !== index);
  const next = entries.map((e, i) => (i === index ? entry : e));
  return next.filter(
    (e, i) => next.findIndex((f) => sameFranchise(f, e)) === i,
  );
}

/** The entries `createBook` writes, in order; suggestions are left out. */
export function franchisePicks(entries: FranchiseEntry[]): FranchisePick[] {
  return entries.filter((e): e is FranchisePick => !("suggested" in e));
}

/** The one-line reason Use this book is off, or null. */
export function franchiseProblem(entries: FranchiseEntry[]): string | null {
  const open = entries.filter((e) => "suggested" in e).length;
  if (open === 0) return null;
  return open === 1
    ? "Choose a franchise for the suggestion above, or drop it."
    : `Choose a franchise for the ${open} suggestions above, or drop them.`;
}
