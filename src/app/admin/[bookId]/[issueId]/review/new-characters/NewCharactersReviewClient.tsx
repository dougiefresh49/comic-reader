"use client";

import { useMemo, useState, useTransition } from "react";
import type { NewCharacterReview } from "~/server/admin/new-characters";
import {
  aliasNewCharacter,
  keepAsNewCharacter,
  skipPipelinePause,
  undoAliasNewCharacter,
  unkeepAsNewCharacter,
} from "./actions";

interface Props {
  bookId: string;
  issueId: string;
  initialAutoResolved: NewCharacterReview[];
  initialQueue: NewCharacterReview[];
  knownCharacters: string[];
  /** queue.length + kept-as-new count from server snapshot */
  initialSnapshotTotal: number;
}

type SessionResolved = {
  review: NewCharacterReview;
  canonicalName: string;
  aliasKey: string;
  scope: "global" | "book";
};

export function NewCharactersReviewClient({
  bookId,
  issueId,
  initialAutoResolved,
  initialQueue,
  knownCharacters,
  initialSnapshotTotal,
}: Props) {
  const [queue, setQueue] = useState<NewCharacterReview[]>(initialQueue);
  const [autoResolved, setAutoResolved] =
    useState<NewCharacterReview[]>(initialAutoResolved);
  const [sessionResolved, setSessionResolved] = useState<SessionResolved[]>(
    [],
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const reviewedCount = initialSnapshotTotal - queue.length;

  const sortedKnown = useMemo(
    () => [...knownCharacters].sort((a, b) => a.localeCompare(b)),
    [knownCharacters],
  );

  const handleAlias = (
    review: NewCharacterReview,
    canonicalName: string,
    scope: "global" | "book",
  ) => {
    const aliasKey =
      review.speakerVariants[0] ?? review.originalName ?? review.resolvedName;

    setQueue((prev) =>
      prev.filter((r) => r.resolvedName !== review.resolvedName),
    );
    setSessionResolved((prev) => [
      ...prev,
      {
        review,
        canonicalName,
        aliasKey,
        scope,
      },
    ]);

    startTransition(async () => {
      const res = await aliasNewCharacter({
        bookId,
        issueId,
        speakerVariants: review.speakerVariants,
        canonicalName,
        scope,
        aliasSource: aliasKey,
      });
      if (!res.ok) {
        setMsg(`Error: ${"error" in res ? res.error : "unknown"}`);
        setQueue((prev) =>
          [...prev, review].sort((a, b) =>
            a.resolvedName.localeCompare(b.resolvedName),
          ),
        );
        setSessionResolved((prev) =>
          prev.filter((s) => s.review.resolvedName !== review.resolvedName),
        );
      } else {
        setMsg(null);
      }
    });
  };

  const handleUndoSession = (entry: SessionResolved) => {
    setSessionResolved((prev) =>
      prev.filter((s) => s.review.resolvedName !== entry.review.resolvedName),
    );
    setQueue((prev) =>
      [...prev, { ...entry.review, status: "pending" as const }].sort((a, b) =>
        a.resolvedName.localeCompare(b.resolvedName),
      ),
    );
    startTransition(async () => {
      const res = await undoAliasNewCharacter({
        bookId,
        issueId,
        originalName: entry.aliasKey,
        canonicalName: entry.canonicalName,
        scope: entry.scope,
      });
      if (!res.ok) {
        setMsg(`Error: ${"error" in res ? res.error : "unknown"}`);
        setSessionResolved((prev) => [...prev, entry]);
        setQueue((prev) =>
          prev.filter((r) => r.resolvedName !== entry.review.resolvedName),
        );
      } else {
        setMsg(null);
      }
    });
  };

  const handleKeepAsNew = (review: NewCharacterReview) => {
    setQueue((prev) =>
      prev.filter((r) => r.resolvedName !== review.resolvedName),
    );
    setAutoResolved((prev) => [
      ...prev,
      {
        ...review,
        status: "kept_as_new",
        resolvedTo: null,
        autoReason: "kept_as_new",
      },
    ]);

    startTransition(async () => {
      const res = await keepAsNewCharacter({
        bookId,
        issueId,
        resolvedName: review.resolvedName,
      });
      if (!res.ok) setMsg("Could not persist keep-as-new.");
      else setMsg(null);
    });
  };

  const handleUnkeep = (review: NewCharacterReview) => {
    setAutoResolved((prev) =>
      prev.filter((r) => r.resolvedName !== review.resolvedName),
    );
    setQueue((prev) =>
      [...prev, { ...review, status: "pending" as const }].sort((a, b) =>
        a.resolvedName.localeCompare(b.resolvedName),
      ),
    );

    startTransition(async () => {
      await unkeepAsNewCharacter({
        bookId,
        issueId,
        resolvedName: review.resolvedName,
      });
    });
  };

  const handleSkipPause = () => {
    startTransition(async () => {
      const res = await skipPipelinePause({ bookId, issueId });
      if (!res.ok) setMsg(`Error: ${"error" in res ? res.error : "unknown"}`);
      else setMsg("Pipeline pause cleared for this issue.");
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="text-sm">
          <span className="font-medium">
            {reviewedCount} of {initialSnapshotTotal}
          </span>{" "}
          reviewed
        </div>
        <button
          type="button"
          onClick={handleSkipPause}
          disabled={pending}
          className="rounded border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          Skip pipeline pause
        </button>
      </div>

      {msg && (
        <div className="rounded border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-100">
          {msg}
        </div>
      )}

      {autoResolved.length > 0 && (
        <details className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <summary className="cursor-pointer text-sm text-neutral-400">
            Auto-resolved ({autoResolved.length})
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {autoResolved.map((r) => (
              <span
                key={r.resolvedName}
                className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
              >
                {r.resolvedName}
                {r.autoReason === "registry" && (
                  <span className="text-neutral-500">· registry</span>
                )}
                {r.autoReason === "castlist" && (
                  <span className="text-neutral-500">· cast</span>
                )}
                {r.autoReason === "narrator" && (
                  <span className="text-neutral-500">· narrator</span>
                )}
                {r.autoReason === "kept_as_new" && (
                  <span className="text-neutral-500">· kept as new</span>
                )}
                {r.autoReason === "kept_as_new" && (
                  <button
                    type="button"
                    onClick={() => handleUnkeep(r)}
                    className="ml-1 text-[10px] text-neutral-500 hover:text-neutral-300"
                  >
                    undo
                  </button>
                )}
              </span>
            ))}
          </div>
        </details>
      )}

      {queue.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">
            Review queue ({queue.length})
          </h2>
          {queue.map((r) => (
            <QueueCard
              key={r.resolvedName}
              review={r}
              knownCharacters={sortedKnown}
              disabled={pending}
              onAlias={handleAlias}
              onKeep={() => handleKeepAsNew(r)}
            />
          ))}
        </section>
      )}

      {sessionResolved.length > 0 && (
        <details className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <summary className="cursor-pointer text-sm text-neutral-400">
            Resolved this session ({sessionResolved.length})
          </summary>
          <div className="mt-3 space-y-2">
            {sessionResolved.map((s) => (
              <div
                key={s.review.resolvedName}
                className="flex items-center justify-between rounded bg-neutral-800/50 px-3 py-2 text-sm"
              >
                <div>
                  <span className="text-neutral-400 line-through">
                    {s.review.resolvedName}
                  </span>
                  {" → "}
                  <span className="text-emerald-300">{s.canonicalName}</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {s.scope}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleUndoSession(s)}
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

function QueueCard({
  review,
  knownCharacters,
  disabled,
  onAlias,
  onKeep,
}: {
  review: NewCharacterReview;
  knownCharacters: string[];
  disabled: boolean;
  onAlias: (
    review: NewCharacterReview,
    canonical: string,
    scope: "global" | "book",
  ) => void;
  onKeep: () => void;
}) {
  const [showAlias, setShowAlias] = useState(false);
  const [search, setSearch] = useState("");
  const [freeText, setFreeText] = useState("");
  const [scope, setScope] = useState<"global" | "book">("book");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return knownCharacters
      .filter((c) => c.toLowerCase().includes(q))
      .slice(0, 40);
  }, [knownCharacters, search]);

  const submitFreeText = () => {
    const v = freeText.trim();
    if (!v) return;
    onAlias(review, v, scope);
    setFreeText("");
    setShowAlias(false);
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-base font-medium text-neutral-100">
            &ldquo;{review.resolvedName}&rdquo;
          </span>
          <span className="ml-3 text-xs text-neutral-400">
            Pages: {review.pageNumbers.join(", ")} ({review.bubbleCount}{" "}
            bubbles){" "}
            <span className="text-neutral-500">
              [{review.classification}]
            </span>
          </span>
        </div>
      </div>

      {review.sampleText && (
        <p className="mb-3 rounded bg-neutral-800/50 px-3 py-2 text-xs italic text-neutral-300">
          Sample: &ldquo;{review.sampleText}&rdquo;
        </p>
      )}

      {!showAlias ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={onKeep}
            className="rounded bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            Keep as new — research appearances
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowAlias(true)}
            className="rounded bg-cyan-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-40"
          >
            Alias to existing ▾
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search cast / registry…"
            autoFocus
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <div className="max-h-44 overflow-y-auto rounded border border-neutral-800">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-neutral-500">No matches.</p>
            ) : (
              filtered.map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onAlias(review, name, scope);
                    setShowAlias(false);
                    setSearch("");
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-800"
                >
                  {name}
                </button>
              ))
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Or type a canonical name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") submitFreeText();
              }}
              className="min-w-[12rem] flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-1 text-xs text-neutral-400">
              Scope
              <select
                value={scope}
                onChange={(e) =>
                  setScope(e.target.value as "global" | "book")
                }
                className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
              >
                <option value="book">This book</option>
                <option value="global">Global</option>
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || !freeText.trim()}
              onClick={submitFreeText}
              className="rounded bg-emerald-800 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Apply alias
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAlias(false);
                setSearch("");
                setFreeText("");
              }}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
