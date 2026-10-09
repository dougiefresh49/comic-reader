"use client";

import { useEffect, useRef, useState } from "react";
import { MIN_PAGE_IMAGES } from "~/lib/add-content/page-images";
import { Chip, Cover, FIELD, MONO, Spinner, btn } from "../add/ui";
import {
  findReadingSource,
  previewSource,
  type BookSearchInfo,
  type SourcePreview,
} from "./actions";

interface Found {
  url: string;
  siteName: string;
  /** The search that found it; null for a pasted URL. */
  query: string | null;
  confidence: "high" | "medium" | "low" | null;
}

/** An http(s) URL typed or pasted in, or null. */
function parseUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** What a passed check hands on: the URL Confirm saves and what it holds. */
export interface CheckedSource {
  url: string;
  siteName: string;
  pageCount: number;
  firstImageUrl: string | null;
}

/** Search text without its `web search: ` prefix. */
function shownQuery(query: string): string {
  return query.replace(/^web search:\s*/i, "");
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Find online (#792, restyled for #793 states F0–F4): search from the wiki
 * title as soon as it mounts, refine with more context, then Check pages for
 * the count and the first page beside the wiki cover. `onChecked` hands up a
 * check with enough pages, or null; a new search clears it, so what Confirm
 * saves is always the URL that was checked.
 */
export function SourceConfirm({
  bookId,
  issueNumber,
  searchTitle,
  fromWikiTitle,
  book,
  onChecked,
}: {
  bookId: string;
  issueNumber: number;
  /** The title the first search uses, shown while it runs. */
  searchTitle: string;
  fromWikiTitle: boolean;
  /** An unsaved book's search fields; a saved book is read by `bookId`. */
  book?: BookSearchInfo;
  onChecked: (checked: CheckedSource | null) => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  /** The query of the search that came back empty. */
  const [nothingFor, setNothingFor] = useState<{
    query: string;
    error: string;
  } | null>(null);
  const [lastQuery, setLastQuery] = useState(`"${searchTitle}"`);
  const [context, setContext] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const started = useRef(false);
  /**
   * Bumped by every search, pasted URL and check. A reply lands only while
   * its number is still the latest and the panel is mounted, so a slow check
   * of an old result never reaches `onChecked`.
   */
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = (n: number) => mounted.current && latest.current === n;

  /** A new result: whatever was checked before no longer counts. */
  function reset() {
    setFound(null);
    setNothingFor(null);
    setPreview(null);
    setChecking(false);
    setCheckError(null);
    onChecked(null);
  }

  async function search() {
    const n = ++latest.current;
    const extra = context.trim();
    const query = extra ? `"${searchTitle}" ${extra}` : `"${searchTitle}"`;
    setLastQuery(query);
    reset();
    setSearching(true);
    const result = await findReadingSource({
      bookId,
      issueNumber,
      extraContext: extra || undefined,
      book,
    });
    if (!current(n)) return;
    if (result.ok) setFound(result.data);
    else setNothingFor({ query, error: result.error });
    setSearching(false);
  }

  /** A pasted URL replaces the result and needs Check pages like a found one. */
  function takePasted() {
    const url = parseUrl(pasted);
    if (!url) return;
    latest.current++;
    reset();
    setSearching(false);
    setFound({
      url: url.href,
      siteName: url.hostname.replace(/^www\./, ""),
      query: null,
      confidence: null,
    });
    setPasted("");
  }

  async function check() {
    if (!found) return;
    const n = ++latest.current;
    setChecking(true);
    setCheckError(null);
    const result = await previewSource({
      bookId,
      issueNumber,
      url: found.url,
      book,
    });
    if (!current(n)) return;
    if (result.ok) {
      setPreview(result.data);
      onChecked(
        result.data.imageUrls.length >= MIN_PAGE_IMAGES
          ? {
              url: result.data.url,
              siteName: result.data.siteName,
              pageCount: result.data.imageUrls.length,
              firstImageUrl: result.data.firstImageUrl,
            }
          : null,
      );
    } else {
      setCheckError(result.error);
    }
    setChecking(false);
  }

  // The Find online card is the request to search: run it once on mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (searching) {
    return (
      <div>
        <div className="flex items-center gap-3 pt-7 pb-2.5">
          <Spinner />
          <span>Searching…</span>
        </div>
        <QueryLine query={lastQuery} fromWikiTitle={fromWikiTitle} />
      </div>
    );
  }

  const paste = (
    <div className="mt-3">
      <div className="mb-1.5 text-[11px] font-semibold tracking-[.08em] text-neutral-500 uppercase">
        Or paste a URL
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          takePasted();
        }}
      >
        <input
          type="url"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="https://…"
          aria-label="Or paste a URL"
          className={`${FIELD} max-w-[560px] flex-1 font-mono`}
        />
        <button type="submit" disabled={!parseUrl(pasted)} className={btn()}>
          Use this URL
        </button>
      </form>
    </div>
  );

  const refine = (
    <div className="mt-4 border-t border-[#2a2a2a] pt-3.5">
      <div className="mb-1.5 text-[11px] font-semibold tracking-[.08em] text-neutral-500 uppercase">
        Not it?
      </div>
      <div className="flex items-start gap-2">
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="More context: year, publisher, series, what it is not"
          aria-label="More context"
          rows={2}
          className={`${FIELD} min-h-16 max-w-[560px] flex-1 resize-y`}
        />
        <button type="button" onClick={search} className={btn()}>
          Search again
        </button>
      </div>
    </div>
  );

  if (!found) {
    return (
      <div className="max-w-[860px] rounded-[11px] border border-[#5a2d28] bg-neutral-800 px-[18px] py-4">
        <div className="mt-0.5 mb-2.5 text-2xl font-semibold text-red-300">
          No source found
        </div>
        <div className="text-[12.5px] text-neutral-400">
          No usable result for{" "}
          <b className="font-medium text-neutral-100">
            {nothingFor?.query ?? lastQuery}
          </b>
        </div>
        {nothingFor?.error && (
          <div className={`${MONO} mt-1 text-neutral-500`}>
            {nothingFor.error}
          </div>
        )}
        {refine}
        {paste}
      </div>
    );
  }

  const count = preview?.imageUrls.length ?? 0;
  const tooFew = preview !== null && count < MIN_PAGE_IMAGES;
  const wikiKey = key(searchTitle.replace(/\s*issue\s*#?\d+\s*$/i, ""));
  const titleDiffers =
    preview?.pageTitle != null &&
    wikiKey !== "" &&
    !key(preview.pageTitle).includes(wikiKey);

  return (
    <div
      className={`max-w-[860px] rounded-[11px] border bg-neutral-800 px-[18px] py-4 ${tooFew ? "border-[#5a2d28]" : "border-neutral-700"}`}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Chip tone="site">{preview?.siteName ?? found.siteName}</Chip>
        <a
          href={found.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${MONO} max-w-[520px] truncate text-[12.5px] text-cyan-300 underline decoration-dotted`}
        >
          {found.url}
        </a>
        {found.confidence && (
          <Chip
            tone={
              found.confidence === "high"
                ? "ok"
                : found.confidence === "medium"
                  ? "warn"
                  : "bad"
            }
          >
            {found.confidence}
          </Chip>
        )}
      </div>
      {found.query && (
        <QueryLine
          query={shownQuery(found.query)}
          fromWikiTitle={fromWikiTitle}
        />
      )}

      {preview?.pageTitle && (
        <div className="mt-1.5 text-[12.5px] text-neutral-400">
          Source page title:{" "}
          <b className="font-medium text-neutral-100">{preview.pageTitle}</b>{" "}
          {titleDiffers && <Chip tone="warn">title differs from the wiki</Chip>}
        </div>
      )}

      {preview ? (
        <>
          <div
            className={`mt-3.5 mb-2.5 flex items-baseline gap-2 text-2xl font-semibold tabular-nums ${tooFew ? "text-red-300" : ""}`}
          >
            {count}{" "}
            <small className="text-[13px] font-normal text-neutral-400">
              page images
            </small>
          </div>
          <div className="flex items-start gap-3.5">
            <Figure src={preview.firstImageUrl} caption="First page found" />
            <span className="self-center px-1 text-xl text-neutral-500">
              vs
            </span>
            <Figure src={preview.wikiCoverUrl} caption="Wiki cover" />
          </div>
          {tooFew && (
            <p className="mt-2.5 text-[12.5px] text-red-300">
              Too few for an issue. Nothing to download.
            </p>
          )}
        </>
      ) : (
        <div className="mt-3.5 flex items-center gap-3">
          <button
            type="button"
            onClick={check}
            disabled={checking}
            className={btn()}
          >
            {checking && <Spinner />}
            Check pages
          </button>
        </div>
      )}
      {checkError && (
        <p className="mt-2.5 text-[12.5px] text-red-300">{checkError}</p>
      )}
      {refine}
      {paste}
    </div>
  );
}

function QueryLine({
  query,
  fromWikiTitle,
}: {
  query: string;
  fromWikiTitle: boolean;
}) {
  return (
    <div className={`${MONO} mt-2 text-neutral-500`}>
      query <b className="font-medium text-neutral-400">{query}</b>
      {fromWikiTitle && " · from the wiki title"}
    </div>
  );
}

function Figure({ src, caption }: { src: string | null; caption: string }) {
  return (
    <figure className="m-0 w-[150px]">
      <Cover
        src={src}
        title={caption}
        label={false}
        className="aspect-[2/3] w-[150px] rounded-md"
      />
      <figcaption className="mt-[5px] text-[11px] font-semibold tracking-[.06em] text-neutral-500 uppercase">
        {caption}
      </figcaption>
    </figure>
  );
}
