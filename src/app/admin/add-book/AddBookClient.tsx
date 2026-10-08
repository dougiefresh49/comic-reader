"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { searchForBook, createBook } from "./actions";

interface BookSearchResult {
  title: string;
  wikiUrl: string;
  wikiHost: string;
  publisher: string;
  franchises: string[];
  seriesName: string | null;
  volumeNumber: number | null;
  seriesId: string | null;
  seriesIsNew: boolean;
  totalIssues: number;
  wikiTitleTemplate: string;
  suggestedSlug: string;
}

export function AddBookClient() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<BookSearchResult | null>(null);
  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setResult(null);
    setError(null);
    const res = await searchForBook(query.trim());
    if (res.ok) {
      setResult(res.data);
      setSlug(res.data.suggestedSlug);
    } else {
      setError(res.error);
    }
    setSearching(false);
  }

  async function handleCreate() {
    if (!result || !slug.trim()) return;
    setCreating(true);
    setError(null);
    const res = await createBook({
      slug: slug.trim(),
      title: result.title,
      wikiHost: result.wikiHost,
      wikiTitleTemplate: result.wikiTitleTemplate,
      publisher: result.publisher,
      franchises: result.franchises,
      totalIssues: result.totalIssues,
      seriesName: result.seriesName ?? null,
      volumeNumber: result.volumeNumber ?? null,
    });
    if (res.ok) {
      router.push(`/admin/add-issue?book=${encodeURIComponent(slug.trim())}`);
    } else {
      setError(res.error);
      setCreating(false);
    }
  }

  function handleSearchAgain() {
    setResult(null);
    setSlug("");
    setQuery("");
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      {!result && (
        <form onSubmit={handleSearch} className="space-y-3">
          <label className="block text-sm font-medium text-neutral-300">
            What comic are you looking for?
          </label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="TMNT He-Man crossover comic"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {searching ? "Searching..." : "Search"}
          </button>
        </form>
      )}

      {error && (
        <p className="rounded-lg bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {/* Result Card */}
      {result && (
        <div className="space-y-4 rounded-lg border border-neutral-700 bg-neutral-900 p-5">
          <h2 className="text-lg font-semibold text-neutral-100">
            {result.title}
          </h2>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-400">
            <span>{result.publisher}</span>
            <span>Issues: {result.totalIssues}</span>
            <span>Franchises: {result.franchises.join(", ")}</span>
          </div>

          <p className="text-sm text-neutral-400">
            Wiki:{" "}
            <a
              href={result.wikiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline hover:text-emerald-300"
            >
              {result.wikiUrl}
            </a>
          </p>

          {/* What createBook stores as series_id and series_position */}
          <p className="text-sm text-neutral-400">
            {result.seriesId
              ? `Series: ${result.seriesName}${result.volumeNumber != null ? ` · Vol. ${result.volumeNumber}` : ""} (${result.seriesIsNew ? "new series" : "joins series"} ${result.seriesId})`
              : "Standalone"}
          </p>

          {/* Slug field */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-neutral-300">
              Book ID
            </label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 focus:outline-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleCreate}
              disabled={creating || !slug.trim()}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? "Creating..." : "Confirm & Create Book"}
            </button>
            <button
              onClick={handleSearchAgain}
              disabled={creating}
              className="rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Search Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
