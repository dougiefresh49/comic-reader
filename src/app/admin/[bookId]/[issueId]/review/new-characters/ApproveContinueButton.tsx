"use client";

import { useState, useTransition } from "react";
import { approveAndContinuePipeline } from "./actions";

export function ApproveContinueButton({
  bookId,
  issueId,
}: {
  bookId: string;
  issueId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (doneMessage) {
    return (
      <span className="rounded bg-emerald-700/30 px-3 py-1.5 text-sm font-medium text-emerald-300">
        {doneMessage}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const res = await approveAndContinuePipeline({ bookId, issueId });
            if (!res.ok) {
              setError("error" in res ? res.error : "Failed to resume");
              return;
            }
            if (res.resumed) {
              setDoneMessage("Pipeline resumed");
              return;
            }
            const base = "No live run waiting, pause flags cleared";
            setDoneMessage(
              "resumeError" in res && res.resumeError
                ? `${base}: ${res.resumeError}`
                : base,
            );
          });
        }}
        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {pending ? "Resuming..." : "Approve & continue"}
      </button>
      {error && (
        <span className="max-w-xs text-right text-xs text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
