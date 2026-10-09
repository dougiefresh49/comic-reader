"use client";

import { useState, useEffect, useRef } from "react";
import { wikiPageUrl } from "~/lib/add-content/wiki";
import { confirmSource } from "./actions";
import { SourceConfirm } from "./SourceConfirm";

interface BookInfo {
  id: string;
  name: string;
  totalIssues: number | null;
  nextIssueNumber: number;
  wikiTitleTemplate: string | null;
  wikiHost: string | null;
}

interface DownloadProgress {
  status: string;
  current: number;
  total: number;
  done: boolean;
  error: string | null;
}

export function AddIssueClient({ bookInfo }: { bookInfo: BookInfo }) {
  const [issueNumber, setIssueNumber] = useState(bookInfo.nextIssueNumber);
  const [wikiUrl, setWikiUrl] = useState("");
  /** Set by Confirm: the saved issue and the URL the downloader will read. */
  const [confirmed, setConfirmed] = useState<{
    issueId: string;
    url: string;
  } | null>(null);
  const [download, setDownload] = useState<DownloadProgress>({
    status: "",
    current: 0,
    total: 0,
    done: false,
    error: null,
  });
  const [downloading, setDownloading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setWikiUrl(
      bookInfo.wikiHost && bookInfo.wikiTitleTemplate
        ? wikiPageUrl(
            bookInfo.wikiHost,
            bookInfo.wikiTitleTemplate,
            issueNumber,
          )
        : "",
    );
  }, [issueNumber, bookInfo.wikiHost, bookInfo.wikiTitleTemplate]);

  async function handleConfirm(checked: {
    url: string;
    pageCount: number;
  }): Promise<string | null> {
    if (!wikiUrl) return "Add the wiki URL first.";
    const result = await confirmSource({
      bookId: bookInfo.id,
      issueNumber,
      wikiUrl,
      sourceUrl: checked.url,
    });
    if (!result.ok) return result.error;
    setConfirmed({ issueId: result.data.id, url: checked.url });
    void handleDownloadPages(result.data.id, checked.pageCount);
    return null;
  }

  async function handleDownloadPages(issueId: string, expectedCount: number) {
    setDownloading(true);
    setDownload({
      status: "Starting...",
      current: 0,
      total: 0,
      done: false,
      error: null,
    });

    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;

    try {
      const res = await fetch("/api/admin/download-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The route reads the URL from the issue row Confirm just saved.
        body: JSON.stringify({
          bookId: bookInfo.id,
          issueId,
          expectedCount,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = (await res
          .json()
          .catch(() => ({ error: "Request failed" }))) as { error: string };
        failed = true;
        setDownload((d) => ({
          ...d,
          error: err.error,
          done: true,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as {
            type: string;
            message: string;
            current?: number;
            total?: number;
          };

          if (event.type === "error") {
            failed = true;
            setDownload((d) => ({
              ...d,
              status: event.message,
              error: event.message,
              done: true,
            }));
          } else if (event.type === "done") {
            setDownload({
              status: event.message,
              current: event.current ?? 0,
              total: event.total ?? 0,
              done: true,
              error: null,
            });
          } else {
            setDownload((d) => ({
              ...d,
              status: event.message,
              current: event.current ?? d.current,
              total: event.total ?? d.total,
            }));
          }
        }
      }
    } catch (err) {
      failed = true;
      if ((err as Error).name !== "AbortError") {
        setDownload((d) => ({
          ...d,
          error: err instanceof Error ? err.message : "Unknown error",
          done: true,
        }));
      }
    } finally {
      setDownloading(false);
      abortRef.current = null;
      // Nothing was stored: unlock the source so it can be checked again.
      if (failed) setConfirmed(null);
    }
  }

  const command = confirmed
    ? `pnpm scrape-pages -- --url "${confirmed.url}" --book ${bookInfo.id} --issue ${issueNumber}`
    : "";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Add Issue — {bookInfo.name}</h1>

      <div>
        <label className="mb-1 block text-sm text-neutral-400">
          Issue Number
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={issueNumber}
            disabled={confirmed !== null}
            onChange={(e) => setIssueNumber(Number(e.target.value))}
            className="w-24 rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 focus:ring-2 focus:ring-emerald-600 focus:outline-none disabled:opacity-60"
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
          disabled={confirmed !== null}
          onChange={(e) => setWikiUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg bg-neutral-800 px-4 py-2 text-neutral-100 placeholder-neutral-500 focus:ring-2 focus:ring-emerald-600 focus:outline-none disabled:opacity-60"
        />
      </div>

      <SourceConfirm
        key={issueNumber}
        bookId={bookInfo.id}
        issueNumber={issueNumber}
        locked={confirmed !== null}
        onConfirm={handleConfirm}
      />

      {(downloading || download.done) && (
        <div className="space-y-2 rounded-lg bg-neutral-800 p-4">
          <div className="flex items-center gap-3">
            <p className="text-sm text-neutral-300">{download.status}</p>
            {downloading && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded bg-red-700/60 px-3 py-1 text-xs text-red-200 hover:bg-red-600"
              >
                Cancel
              </button>
            )}
          </div>
          {download.total > 0 && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-700">
              <div
                className={`h-full transition-all ${download.error ? "bg-red-500" : "bg-cyan-500"}`}
                style={{
                  width: `${(download.current / download.total) * 100}%`,
                }}
              />
            </div>
          )}
          {download.error && (
            <p className="text-sm text-red-400">{download.error}</p>
          )}
        </div>
      )}

      {confirmed && (
        <details className="border-t border-neutral-700 pt-3">
          <summary className="cursor-pointer text-sm text-neutral-500 hover:text-neutral-300">
            Manual command (CLI)
          </summary>
          <div className="mt-2 space-y-2">
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
        </details>
      )}
    </div>
  );
}
