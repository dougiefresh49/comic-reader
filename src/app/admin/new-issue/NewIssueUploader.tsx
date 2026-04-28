"use client";

import { useCallback, useMemo, useState } from "react";

interface FileEntry {
  file: File;
  preview: string;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

export function NewIssueUploader() {
  const [bookId, setBookId] = useState("");
  const [bookName, setBookName] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [issueName, setIssueName] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [step, setStep] = useState<"meta" | "files" | "uploading" | "done">(
    "meta",
  );
  const [error, setError] = useState<string | null>(null);

  const issueId = useMemo(
    () => (issueNumber ? `issue-${issueNumber}` : ""),
    [issueNumber],
  );

  const onDrop = useCallback((dropped: FileList | null) => {
    if (!dropped) return;
    const accepted: FileEntry[] = [];
    for (const f of Array.from(dropped)) {
      if (!f.type.startsWith("image/")) continue;
      accepted.push({
        file: f,
        preview: URL.createObjectURL(f),
        status: "pending",
      });
    }
    accepted.sort((a, b) => a.file.name.localeCompare(b.file.name));
    setFiles((prev) => [...prev, ...accepted]);
  }, []);

  const removeFile = (idx: number) => {
    setFiles((prev) => {
      URL.revokeObjectURL(prev[idx]!.preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleNextFromMeta = () => {
    setError(null);
    if (!bookId.trim() || !issueNumber.trim()) {
      setError("Book ID and issue number are required.");
      return;
    }
    if (Number.isNaN(Number(issueNumber))) {
      setError("Issue number must be a number.");
      return;
    }
    setStep("files");
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      setError("No files to upload.");
      return;
    }
    setError(null);
    setStep("uploading");

    try {
      // Step 1: init issue
      const initRes = await fetch("/api/admin/upload-source-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "init",
          bookId,
          bookName: bookName || undefined,
          issueId,
          issueName: issueName || undefined,
          number: Number(issueNumber),
        }),
      });
      if (!initRes.ok) {
        throw new Error(`init: ${initRes.status} ${await initRes.text()}`);
      }

      // Step 2: upload each file in parallel (limit 5 concurrent)
      let nextIndex = 0;
      const workers: Promise<void>[] = [];
      const concurrency = 5;
      const upload = async (idx: number) => {
        const entry = files[idx]!;
        setFiles((prev) =>
          prev.map((f, i) => (i === idx ? { ...f, status: "uploading" } : f)),
        );
        try {
          const padded = String(idx + 1).padStart(2, "0");
          const filename = `page-${padded}.jpg`;
          const urlRes = await fetch("/api/admin/upload-source-page", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "url",
              bookId,
              issueId,
              filename,
            }),
          });
          if (!urlRes.ok) {
            throw new Error(`signed url: ${urlRes.status}`);
          }
          const { uploadUrl } = (await urlRes.json()) as { uploadUrl: string };
          const putRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "content-type": entry.file.type },
            body: entry.file,
          });
          if (!putRes.ok) {
            throw new Error(`upload: ${putRes.status}`);
          }
          setFiles((prev) =>
            prev.map((f, i) => (i === idx ? { ...f, status: "done" } : f)),
          );
        } catch (e) {
          setFiles((prev) =>
            prev.map((f, i) =>
              i === idx
                ? { ...f, status: "error", error: (e as Error).message }
                : f,
            ),
          );
        }
      };

      for (let w = 0; w < concurrency; w++) {
        workers.push(
          (async () => {
            while (true) {
              const idx = nextIndex;
              nextIndex += 1;
              if (idx >= files.length) return;
              await upload(idx);
            }
          })(),
        );
      }
      await Promise.all(workers);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("files");
    }
  };

  const completed = files.filter((f) => f.status === "done").length;
  const failed = files.filter((f) => f.status === "error").length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-700 bg-red-900/30 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {step === "meta" && (
        <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-medium">Issue metadata</h2>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm">
              <span className="block text-neutral-400">Book ID *</span>
              <input
                type="text"
                value={bookId}
                onChange={(e) => setBookId(e.target.value.trim())}
                placeholder="tmnt-mmpr-iii"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-neutral-400">
                Book name (only if new)
              </span>
              <input
                type="text"
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
                placeholder="TMNT × MMPR III"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-neutral-400">Issue number *</span>
              <input
                type="number"
                value={issueNumber}
                onChange={(e) => setIssueNumber(e.target.value)}
                placeholder="3"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-neutral-400">Issue name</span>
              <input
                type="text"
                value={issueName}
                onChange={(e) => setIssueName(e.target.value)}
                placeholder="Issue 3"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
          </div>
          {issueId && (
            <p className="text-xs text-neutral-500">
              Will create issue{" "}
              <code>
                {bookId}/{issueId}
              </code>
              .
            </p>
          )}
          <button
            onClick={handleNextFromMeta}
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
          >
            Next →
          </button>
        </section>
      )}

      {(step === "files" || step === "uploading" || step === "done") && (
        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium">Pages</h2>
            <span className="text-xs text-neutral-500">
              {bookId} / {issueId}
            </span>
          </div>

          {step === "files" && (
            <label
              htmlFor="file-input"
              className="flex h-32 cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-neutral-700 text-center text-sm text-neutral-400 hover:border-neutral-500"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(e.dataTransfer.files);
              }}
            >
              Drop JPEGs or click to select
              <input
                id="file-input"
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => onDrop(e.target.files)}
              />
            </label>
          )}

          {files.length > 0 && (
            <div className="mt-4 grid grid-cols-6 gap-2">
              {files.map((f, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.preview}
                    alt={f.file.name}
                    className="aspect-[2/3] w-full rounded object-cover"
                  />
                  <span
                    className={`absolute top-1 left-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      f.status === "done"
                        ? "bg-emerald-700 text-white"
                        : f.status === "error"
                          ? "bg-red-700 text-white"
                          : f.status === "uploading"
                            ? "bg-yellow-700 text-white"
                            : "bg-neutral-700/80 text-neutral-200"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {step === "files" && (
                    <button
                      onClick={() => removeFile(i)}
                      className="absolute top-1 right-1 rounded bg-black/60 px-1 text-xs text-white hover:bg-red-700"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {step === "files" && files.length > 0 && (
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={handleUpload}
                className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
              >
                Upload {files.length} page{files.length === 1 ? "" : "s"}
              </button>
              <button
                onClick={() => setStep("meta")}
                className="text-xs text-neutral-400 hover:text-neutral-200"
              >
                ← Back
              </button>
            </div>
          )}

          {step === "uploading" && (
            <p className="mt-4 text-sm text-neutral-400">
              Uploading… {completed} / {files.length} done
              {failed > 0 && ` · ${failed} failed`}
            </p>
          )}

          {step === "done" && (
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-emerald-300">
                ✓ {completed} of {files.length} pages uploaded.
              </p>
              {failed > 0 && (
                <p className="text-red-300">{failed} failed (see badges).</p>
              )}
              <p className="text-neutral-400">
                Run locally:{" "}
                <code className="rounded bg-neutral-800 px-1.5 py-0.5">
                  pnpm ingest -- --book {bookId} --issue {issueNumber}
                </code>
              </p>
              <a
                href="/admin"
                className="inline-block rounded bg-neutral-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-600"
              >
                ← Back to dashboard
              </a>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
