"use client";

import { useState, useEffect, useCallback } from "react";
import { findReadingSource, createIssue } from "./actions";

interface BookInfo {
  id: string;
  name: string;
  totalIssues: number | null;
  parts: { id: string; number: number; name: string; slug: string }[];
  nextIssueNumber: number;
  wikiTitleTemplate: string | null;
  wikiHost: string | null;
}

export function AddIssueClient({ bookInfo }: { bookInfo: BookInfo }) {
  const [partId, setPartId] = useState<string>(
    bookInfo.parts.length > 0 ? bookInfo.parts[0]!.id : "",
  );
  const [issueNumber, setIssueNumber] = useState(bookInfo.nextIssueNumber);
  const [wikiUrl, setWikiUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [confidence, setConfidence] = useState<
    "high" | "medium" | "low" | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildWikiUrl = useCallback(
    (num: number) => {
      if (bookInfo.wikiHost && bookInfo.wikiTitleTemplate) {
        const title = bookInfo.wikiTitleTemplate.replace(
          "{number}",
          String(num),
        );
        const host = bookInfo.wikiHost.startsWith("http")
          ? bookInfo.wikiHost
          : `https://${bookInfo.wikiHost}`;
        return `${host}/wiki/${title}`;
      }
      return "";
    },
    [bookInfo.wikiHost, bookInfo.wikiTitleTemplate],
  );

  useEffect(() => {
    setWikiUrl(buildWikiUrl(issueNumber));
  }, [issueNumber, buildWikiUrl]);

  async function handleFindSource() {
    setLoading(true);
    setError(null);
    const result = await findReadingSource(bookInfo.name, issueNumber);
    if (result.ok) {
      setSourceUrl(result.data.url);
      setConfidence(result.data.confidence);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  async function handleCreate() {
    setLoading(true);
    setError(null);
    const result = await createIssue({
      bookId: bookInfo.id,
      issueNumber,
      partId: partId || undefined,
      wikiUrl,
      sourceUrl,
    });
    if (result.ok) {
      setCreated(result.data.id);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  const command = `pnpm scrape-pages -- --url "${sourceUrl}" --book ${bookInfo.id} --issue ${issueNumber}`;

  const confidenceColors = {
    high: "bg-emerald-700 text-emerald-100",
    medium: "bg-yellow-700 text-yellow-100",
    low: "bg-red-700 text-red-100",
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Add Issue — {bookInfo.name}</h1>

      {bookInfo.parts.length > 0 && (
        <div>
          <label className="mb-1 block text-sm text-neutral-400">Part</label>
          <select
            value={partId}
            onChange={(e) => setPartId(e.target.value)}
            className="w-full rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 focus:ring-2 focus:ring-emerald-600 focus:outline-none"
          >
            {bookInfo.parts.map((p) => (
              <option key={p.id} value={p.id}>
                Part {p.number}: {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm text-neutral-400">
          Issue Number
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={issueNumber}
            onChange={(e) => setIssueNumber(Number(e.target.value))}
            className="w-24 rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 focus:ring-2 focus:ring-emerald-600 focus:outline-none"
          />
          <span className="text-sm text-neutral-400">
            Next: #{bookInfo.nextIssueNumber}
            {bookInfo.totalIssues ? ` of ${bookInfo.totalIssues}` : ""}
          </span>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm text-neutral-400">Wiki URL</label>
        <input
          type="url"
          value={wikiUrl}
          onChange={(e) => setWikiUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 placeholder-neutral-500 focus:ring-2 focus:ring-emerald-600 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-neutral-400">
          Reading Source
        </label>
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 placeholder-neutral-500 focus:ring-2 focus:ring-emerald-600 focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={handleFindSource}
            disabled={loading}
            className="rounded-lg bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-600 disabled:opacity-50"
          >
            {loading ? "Searching..." : "Find Source"}
          </button>
          {confidence && (
            <span
              className={`rounded px-2 py-1 text-xs font-medium ${confidenceColors[confidence]}`}
            >
              {confidence}
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {!created ? (
        <button
          onClick={handleCreate}
          disabled={loading || !sourceUrl || !wikiUrl}
          className="rounded-lg bg-emerald-700 px-6 py-2 font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create Issue"}
        </button>
      ) : (
        <div className="space-y-3 rounded-lg bg-neutral-800 p-4">
          <p className="text-sm font-medium text-emerald-400">
            Issue created successfully.
          </p>
          <p className="text-sm text-neutral-400">
            Run this command to scrape pages:
          </p>
          <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-sm text-neutral-200">
            {command}
          </pre>
          <button
            onClick={() => navigator.clipboard.writeText(command)}
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-200 transition-colors hover:bg-neutral-600"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
