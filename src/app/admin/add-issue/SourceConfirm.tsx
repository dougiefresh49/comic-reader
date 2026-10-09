"use client";

import { useState } from "react";
import { MIN_PAGE_IMAGES } from "~/lib/add-content/page-images";
import {
  findReadingSource,
  previewSource,
  type SourcePreview,
} from "./actions";

interface Found {
  siteName: string;
  query: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Find a reading source, check what it holds, and confirm it (#792): search,
 * refine with more context, Check (page count, first page beside the wiki
 * cover), then Confirm. Editing the URL clears the check, so what Confirm
 * hands on is always the URL that was checked.
 */
export function SourceConfirm({
  bookId,
  issueNumber,
  locked,
  onConfirm,
}: {
  bookId: string;
  issueNumber: number;
  /** True once confirmed: everything here is read-only. */
  locked: boolean;
  /** Saves the checked URL and starts the download; returns an error or null. */
  onConfirm: (checked: {
    url: string;
    pageCount: number;
  }) => Promise<string | null>;
}) {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [context, setContext] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [busy, setBusy] = useState<"search" | "check" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setBusy("search");
    setError(null);
    const result = await findReadingSource({
      bookId,
      issueNumber,
      extraContext: context.trim() || undefined,
    });
    if (result.ok) {
      setUrl(result.data.url);
      setPreview(null);
      setFound(result.data);
    } else {
      setError(result.error);
    }
    setBusy(null);
  }

  async function check() {
    setBusy("check");
    setError(null);
    const result = await previewSource({ bookId, issueNumber, url });
    if (result.ok) setPreview(result.data);
    else setError(result.error);
    setBusy(null);
  }

  async function confirm() {
    if (!preview) return;
    setBusy("confirm");
    setError(null);
    const err = await onConfirm({
      url: preview.url,
      pageCount: preview.imageUrls.length,
    });
    if (err) setError(err);
    setBusy(null);
  }

  const pageCount = preview?.imageUrls.length ?? 0;
  const canConfirm = !locked && busy === null && pageCount >= MIN_PAGE_IMAGES;
  const input =
    "w-full rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 placeholder-neutral-500 focus:ring-2 focus:ring-emerald-600 focus:outline-none disabled:opacity-60";
  const button =
    "rounded-lg bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-600 disabled:opacity-50";

  return (
    <div className="space-y-3">
      <label className="block text-sm text-neutral-400" htmlFor="source-url">
        Reading Source
      </label>
      <input
        id="source-url"
        type="url"
        value={url}
        disabled={locked}
        onChange={(e) => {
          setUrl(e.target.value);
          setPreview(null);
        }}
        placeholder="https://..."
        className={input}
      />

      {found && (
        <p className="text-sm text-neutral-400">
          <span className="font-medium text-neutral-200">{found.siteName}</span>{" "}
          · {found.confidence} · searched {found.query}
        </p>
      )}

      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          {found && (
            <input
              type="text"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="More context (e.g. Metal Legion, 2025)"
              aria-label="More context"
              className={`${input} max-w-sm flex-1`}
            />
          )}
          <button onClick={search} disabled={busy !== null} className={button}>
            {busy === "search"
              ? "Searching..."
              : found
                ? "Search Again"
                : "Find Source"}
          </button>
          <button
            onClick={check}
            disabled={busy !== null || !url.trim()}
            className={button}
          >
            {busy === "check" ? "Checking..." : "Check"}
          </button>
        </div>
      )}

      {preview && (
        <div className="space-y-3 rounded-lg bg-neutral-800 p-4">
          <p className="text-sm text-neutral-200">
            <span className="font-medium">{preview.siteName}</span> ·{" "}
            {pageCount} page{pageCount === 1 ? "" : "s"} found
          </p>
          <p className="truncate text-xs text-neutral-500">{preview.url}</p>
          <div className="flex gap-4">
            <Thumb src={preview.firstImageUrl} label="First page" />
            <Thumb src={preview.wikiCoverUrl} label="Wiki cover" />
          </div>
          {pageCount < MIN_PAGE_IMAGES && (
            <p className="text-sm text-yellow-300">
              Too few page images to be a whole issue. Try another source.
            </p>
          )}
          {!locked && (
            <button
              onClick={confirm}
              disabled={!canConfirm}
              className="rounded-lg bg-emerald-700 px-6 py-2 font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
            >
              {busy === "confirm"
                ? "Confirming..."
                : `Confirm ${pageCount} pages`}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Thumb({ src, label }: { src: string | null; label: string }) {
  return (
    <figure className="w-40">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={label}
          referrerPolicy="no-referrer"
          className="h-60 w-40 rounded bg-neutral-900 object-contain"
        />
      ) : (
        <div className="flex h-60 w-40 items-center justify-center rounded bg-neutral-900 text-xs text-neutral-500">
          None
        </div>
      )}
      <figcaption className="mt-1 text-center text-xs text-neutral-400">
        {label}
      </figcaption>
    </figure>
  );
}
