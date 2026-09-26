"use client";

import { useState } from "react";

export function ApproveClusterButton({
  bookId,
  issueId,
  disabled,
}: {
  bookId: string;
  issueId: string;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/admin/resume-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, issueId, step: "cluster-review" }),
    });
    if (res.ok) {
      setApproved(true);
    } else {
      let message = "Failed to resume";
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* keep default */
      }
      setError(message);
    }
    setLoading(false);
  }

  if (approved) {
    return (
      <span className="rounded bg-emerald-700/30 px-3 py-1.5 text-sm font-medium text-emerald-300">
        Pipeline Resumed
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleApprove}
        disabled={loading || disabled}
        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {loading ? "Resuming..." : "Approve & Continue Pipeline"}
      </button>
      {error && (
        <span className="max-w-xs text-right text-xs text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
