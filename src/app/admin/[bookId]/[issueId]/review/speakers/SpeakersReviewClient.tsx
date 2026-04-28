"use client";

import { useMemo, useState, useTransition } from "react";
import type { SpeakerReview } from "~/server/admin/speakers";
import {
  completeSpeakerReview,
  resolveSpeakerReview,
  unresolveSpeakerReview,
} from "./actions";

interface Props {
  bookId: string;
  issueId: string;
  initialReviews: SpeakerReview[];
  knownCharacters: string[];
}

export function SpeakersReviewClient({
  bookId,
  issueId,
  initialReviews,
  knownCharacters,
}: Props) {
  const [reviews, setReviews] = useState<SpeakerReview[]>(initialReviews);
  const [pending, startTransition] = useTransition();
  const [completeMsg, setCompleteMsg] = useState<string | null>(null);

  const { autoAccepted, queue, resolved } = useMemo(() => {
    const auto: SpeakerReview[] = [];
    const queue: SpeakerReview[] = [];
    const resolved: SpeakerReview[] = [];
    for (const r of reviews) {
      if (r.autoAccepted) {
        auto.push(r);
      } else if (r.status === "pending") {
        queue.push(r);
      } else {
        resolved.push(r);
      }
    }
    return { autoAccepted: auto, queue, resolved };
  }, [reviews]);

  const totalNonAuto = reviews.filter((r) => !r.autoAccepted).length;
  const reviewedCount = totalNonAuto - queue.length;
  const allResolved = queue.length === 0;

  const updateLocal = (originalName: string, patch: Partial<SpeakerReview>) => {
    setReviews((prev) =>
      prev.map((r) =>
        r.originalName === originalName ? { ...r, ...patch } : r,
      ),
    );
  };

  const handleResolve = (
    review: SpeakerReview,
    resolvedName: string,
    status: "accepted" | "renamed" | "skipped",
    opts: { saveAsAlias?: boolean; aliasScope?: "global" | "book" } = {},
  ) => {
    updateLocal(review.originalName, {
      resolvedName,
      status,
      saveAsAlias: opts.saveAsAlias ?? false,
      aliasScope: opts.aliasScope ?? null,
    });
    startTransition(async () => {
      const res = await resolveSpeakerReview({
        bookId,
        issueId,
        originalName: review.originalName,
        resolvedName,
        status,
        saveAsAlias: opts.saveAsAlias,
        aliasScope: opts.aliasScope,
      });
      if (!res.ok) {
        updateLocal(review.originalName, {
          resolvedName: null,
          status: "pending",
          saveAsAlias: false,
          aliasScope: null,
        });
        setCompleteMsg(`Error: ${res.error ?? "unknown"}`);
      }
    });
  };

  const handleUndo = (review: SpeakerReview) => {
    updateLocal(review.originalName, {
      resolvedName: null,
      status: "pending",
      saveAsAlias: false,
      aliasScope: null,
    });
    startTransition(async () => {
      await unresolveSpeakerReview({
        bookId,
        issueId,
        originalName: review.originalName,
      });
    });
  };

  const handleComplete = () => {
    startTransition(async () => {
      const res = await completeSpeakerReview(bookId, issueId);
      if (res.ok) {
        setCompleteMsg(
          `Applied ${res.bubblesUpdated} bubble update(s), ${res.aliasesAdded} alias(es).`,
        );
      } else {
        setCompleteMsg(`Error: ${res.error ?? "unknown"}`);
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Header / progress */}
      <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="text-sm">
          <span className="font-medium">
            {reviewedCount} of {totalNonAuto}
          </span>{" "}
          reviewed
        </div>
        <button
          onClick={handleComplete}
          disabled={!allResolved || pending}
          className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          {pending ? "Working…" : "Complete review"}
        </button>
      </div>

      {completeMsg && (
        <div
          className={`rounded border px-4 py-2 text-sm ${
            completeMsg.startsWith("Error")
              ? "border-red-700 bg-red-900/20 text-red-200"
              : "border-emerald-700 bg-emerald-900/20 text-emerald-200"
          }`}
        >
          {completeMsg}
        </div>
      )}

      {/* Auto-accepted */}
      {autoAccepted.length > 0 && (
        <details className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <summary className="cursor-pointer text-sm text-neutral-400">
            ✓ {autoAccepted.length} auto-accepted (registry / roster match)
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {autoAccepted.map((r) => (
              <span
                key={r.originalName}
                className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
              >
                {r.resolvedName ?? r.originalName}
              </span>
            ))}
          </div>
        </details>
      )}

      {/* Queue */}
      {queue.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">
            Review queue ({queue.length})
          </h2>
          {queue.map((r) => (
            <ReviewCard
              key={r.originalName}
              review={r}
              knownCharacters={knownCharacters}
              onResolve={handleResolve}
            />
          ))}
        </section>
      )}

      {/* Resolved */}
      {resolved.length > 0 && (
        <details className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <summary className="cursor-pointer text-sm text-neutral-400">
            ↩ {resolved.length} resolved (click to expand)
          </summary>
          <div className="mt-3 space-y-2">
            {resolved.map((r) => (
              <div
                key={r.originalName}
                className="flex items-center justify-between rounded bg-neutral-800/50 px-3 py-2 text-sm"
              >
                <div>
                  <span className="text-neutral-400 line-through">
                    {r.originalName}
                  </span>
                  {" → "}
                  <span className="text-emerald-300">{r.resolvedName}</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {r.status}
                    {r.saveAsAlias ? " · alias" : ""}
                  </span>
                </div>
                <button
                  onClick={() => handleUndo(r)}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  undo
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ReviewCard({
  review,
  knownCharacters,
  onResolve,
}: {
  review: SpeakerReview;
  knownCharacters: string[];
  onResolve: (
    review: SpeakerReview,
    resolvedName: string,
    status: "accepted" | "renamed" | "skipped",
    opts?: { saveAsAlias?: boolean; aliasScope?: "global" | "book" },
  ) => void;
}) {
  const [renameValue, setRenameValue] = useState(review.originalName);
  const [showRename, setShowRename] = useState(false);
  const [showList, setShowList] = useState(false);
  const [saveAsAlias, setSaveAsAlias] = useState(false);
  const [aliasScope, setAliasScope] = useState<"global" | "book">("global");
  const [search, setSearch] = useState("");

  const filteredKnown = useMemo(() => {
    const q = search.toLowerCase();
    return knownCharacters
      .filter((c) => c.toLowerCase().includes(q))
      .slice(0, 30);
  }, [knownCharacters, search]);

  const submitRename = () => {
    const v = renameValue.trim();
    if (!v) return;
    onResolve(
      review,
      v,
      v.toLowerCase() === review.originalName.toLowerCase()
        ? "accepted"
        : "renamed",
      saveAsAlias && v !== review.originalName
        ? { saveAsAlias: true, aliasScope }
        : {},
    );
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-base font-medium text-neutral-100">
            &ldquo;{review.originalName}&rdquo;
          </span>
          <span className="ml-3 text-xs text-neutral-400">
            {review.bubbleCount} bubble(s)
            {review.pageNumbers && review.pageNumbers.length > 0
              ? ` · pages ${review.pageNumbers.join(", ")}`
              : ""}
          </span>
        </div>
      </div>

      {review.sampleText && (
        <p className="mb-3 rounded bg-neutral-800/50 px-3 py-2 text-xs text-neutral-300 italic">
          &ldquo;{review.sampleText}&rdquo;
        </p>
      )}

      {!showRename && !showList && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onResolve(review, review.originalName, "accepted")}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
          >
            Accept as-is
          </button>
          <button
            onClick={() => setShowRename(true)}
            className="rounded bg-cyan-700 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-600"
          >
            Rename
          </button>
          <button
            onClick={() => setShowList(true)}
            className="rounded bg-neutral-700 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-600"
          >
            Choose from list
          </button>
          <button
            onClick={() => onResolve(review, review.originalName, "skipped")}
            className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-700"
          >
            Skip
          </button>
        </div>
      )}

      {showRename && (
        <div className="space-y-3">
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setShowRename(false);
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={saveAsAlias}
              onChange={(e) => setSaveAsAlias(e.target.checked)}
            />
            Also save as alias →
            <select
              value={aliasScope}
              onChange={(e) =>
                setAliasScope(e.target.value as "global" | "book")
              }
              disabled={!saveAsAlias}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5"
            >
              <option value="global">Global</option>
              <option value="book">This book only</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button
              onClick={submitRename}
              className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowRename(false)}
              className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showList && (
        <div className="space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search characters…"
            autoFocus
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <div className="max-h-48 overflow-y-auto rounded border border-neutral-800">
            {filteredKnown.length === 0 ? (
              <p className="px-3 py-2 text-xs text-neutral-500">No matches.</p>
            ) : (
              filteredKnown.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    onResolve(
                      review,
                      name,
                      name.toLowerCase() === review.originalName.toLowerCase()
                        ? "accepted"
                        : "renamed",
                      saveAsAlias ? { saveAsAlias: true, aliasScope } : {},
                    );
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-800"
                >
                  {name}
                </button>
              ))
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={saveAsAlias}
              onChange={(e) => setSaveAsAlias(e.target.checked)}
            />
            Save as alias →
            <select
              value={aliasScope}
              onChange={(e) =>
                setAliasScope(e.target.value as "global" | "book")
              }
              disabled={!saveAsAlias}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5"
            >
              <option value="global">Global</option>
              <option value="book">This book only</option>
            </select>
          </label>
          <button
            onClick={() => setShowList(false)}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
