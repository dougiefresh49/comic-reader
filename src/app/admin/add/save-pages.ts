/**
 * The page writes Confirm runs (#793), client side: the confirmed download
 * (`POST /api/admin/download-pages`, SSE) or the upload of files from disk
 * (`POST /api/admin/upload-source-page`, init → one signed PUT per file →
 * finalize). Both report progress and stop on `signal`.
 */

import { storedPages } from "./actions";

export interface PageProgress {
  current: number;
  total: number;
  /** The latest event message, or the file being sent. */
  detail: string;
  /**
   * Set once the upload's finalize runs, which cannot be stopped. `current`
   * then counts the pages stored as WebP so far, from 0.
   */
  finalizing?: boolean;
}

type Outcome =
  | { ok: true; stored: number; warnings: string[] }
  | { ok: false; error: string };

async function errorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string; errors?: string[] };
    if (parsed.errors?.length) return parsed.errors.join("; ");
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`;
}

/** Stores the pages of the issue's saved `source_url`. */
export async function downloadPages(args: {
  bookId: string;
  issueId: string;
  expectedCount: number;
  signal: AbortSignal;
  onProgress: (p: PageProgress) => void;
}): Promise<Outcome> {
  const res = await fetch("/api/admin/download-pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bookId: args.bookId,
      issueId: args.issueId,
      expectedCount: args.expectedCount,
    }),
    signal: args.signal,
  });
  if (!res.ok || !res.body) return { ok: false, error: await errorOf(res) };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let progress: PageProgress = {
    current: 0,
    total: args.expectedCount,
    detail: "",
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      const event = JSON.parse(chunk.slice(6)) as {
        type: "status" | "page" | "done" | "error";
        message: string;
        current?: number;
        total?: number;
      };
      if (event.type === "error") return { ok: false, error: event.message };
      progress = {
        current: event.current ?? progress.current,
        total: event.total ?? progress.total,
        detail: event.message,
      };
      args.onProgress(progress);
      if (event.type === "done") {
        return { ok: true, stored: progress.current, warnings: [] };
      }
    }
  }
  return { ok: false, error: "The download stopped before it finished." };
}

function extOf(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

// At #818's ~3.1 s a page, 50 pages take ~155 s, half the 300 s maxDuration.
const FINALIZE_BATCH = 50;

/**
 * The files each issue was last sent with in this tab. A resume skips only
 * the stored pages whose file is still at the same place in the pick: Back
 * lets the pick change, and a removed or replaced file shifts what follows.
 */
const lastPicks = new Map<string, string[]>();
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

async function post(body: object, signal: AbortSignal): Promise<Response> {
  return fetch("/api/admin/upload-source-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Sends the files as pages 1..N of a saved issue that has none, or resumes an
 * unfinished one from the page init names. Each file is stored raw as
 * `page-NN.<ext>`; finalize turns them into WebP and the `pages` rows, in
 * batches of `FINALIZE_BATCH`.
 */
export async function uploadPages(args: {
  bookId: string;
  issueId: string;
  number: number;
  files: File[];
  signal: AbortSignal;
  onProgress: (p: PageProgress) => void;
}): Promise<Outcome> {
  const { bookId, issueId, files, signal } = args;
  const init = await post(
    { mode: "init", bookId, issueId, number: args.number },
    signal,
  );
  if (!init.ok) return { ok: false, error: await errorOf(init) };
  const { resumeFrom = 1, lastStored = 0 } = (await init.json()) as {
    resumeFrom?: number;
    lastStored?: number;
  };
  const total = files.length;
  if (lastStored > total) {
    return {
      ok: false,
      error: `${issueId} already holds pages up to ${lastStored}, but ${total} files were picked.`,
    };
  }
  // Stored pages count as done only up to the first file that differs from
  // the last pick; with no record of one, everything is sent again.
  const picked = files.map(fileKey);
  const prior = lastPicks.get(`${bookId}/${issueId}`) ?? [];
  let same = 0;
  while (same < picked.length && picked[same] === prior[same]) same++;
  lastPicks.set(`${bookId}/${issueId}`, picked);
  // Every page stored but the issue row unwritten: redo the last page alone,
  // whose finalize writes it.
  const start = Math.max(1, Math.min(resumeFrom, same + 1, total));
  if (start > 1) {
    args.onProgress({ current: start - 1, total, detail: "" });
  }

  let sent = start - 1;
  let failure: string | null = null;
  let next = start - 1;
  const sendOne = async (index: number) => {
    const file = files[index]!;
    const filename = `page-${String(index + 1).padStart(2, "0")}.${extOf(file)}`;
    const urlRes = await post(
      { mode: "url", bookId, issueId, filename },
      signal,
    );
    if (!urlRes.ok) throw new Error(`${file.name}: ${await errorOf(urlRes)}`);
    const { uploadUrl } = (await urlRes.json()) as { uploadUrl: string };
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": file.type },
      body: file,
      signal,
    });
    if (!put.ok) throw new Error(`${file.name}: upload HTTP ${put.status}`);
    sent += 1;
    args.onProgress({ current: sent, total: files.length, detail: file.name });
  };
  // Five at a time; the first failure stops the rest.
  await Promise.all(
    Array.from({ length: Math.min(5, total - next) }, async () => {
      while (failure === null && next < files.length) {
        const index = next++;
        try {
          await sendOne(index);
        } catch (e) {
          failure ??= e instanceof Error ? e.message : String(e);
        }
      }
    }),
  );
  if (failure !== null) return { ok: false, error: failure };

  // Finalize is one long request per batch. Poll the stored rows across all
  // of them so the count moves: one poll at a time, none reported once the
  // last batch ends or one fails.
  let shown = start - 1;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = () =>
    args.onProgress({
      current: shown,
      total,
      detail: "uploaded · storing as WebP",
      finalizing: true,
    });
  const poll = async () => {
    try {
      const rows = await storedPages(bookId, issueId);
      if (ended || signal.aborted) return;
      shown = Math.max(shown, Math.min(rows, total));
      report();
    } catch {
      // the next poll tries again
    }
    if (!ended && !signal.aborted) timer = setTimeout(() => void poll(), 2000);
  };
  report();
  timer = setTimeout(() => void poll(), 2000);
  try {
    let stored = start - 1;
    const warnings: string[] = [];
    for (let from = start; from <= total; from += FINALIZE_BATCH) {
      const to = Math.min(from + FINALIZE_BATCH - 1, total);
      const fin = await post(
        { mode: "finalize", bookId, issueId, count: total, from, to },
        signal,
      );
      if (!fin.ok) {
        ended = true;
        const { resumeFrom: at } = (await fin
          .clone()
          .json()
          .catch(() => ({}))) as { resumeFrom?: number };
        const range =
          from === to
            ? `Page ${from} did not store`
            : `Pages ${from}–${to} did not all store`;
        const back = at
          ? `picks up at page ${at}`
          : "picks up where it stopped";
        return {
          ok: false,
          error: `${range} (${await errorOf(fin)}). Back, then Confirm and save ${back}.`,
        };
      }
      const body = (await fin.json()) as {
        stored: number;
        warnings?: string[];
      };
      stored += body.stored;
      warnings.push(...(body.warnings ?? []));
    }
    return { ok: true, stored, warnings };
  } finally {
    ended = true;
    clearTimeout(timer);
  }
}
