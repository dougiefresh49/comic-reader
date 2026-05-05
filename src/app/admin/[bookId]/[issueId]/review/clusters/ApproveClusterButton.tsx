"use client";

import { useState } from "react";

export function ApproveClusterButton({
  bookId,
  issueId,
}: {
  bookId: string;
  issueId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);

  async function handleApprove() {
    setLoading(true);
    const res = await fetch("/api/admin/resume-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, issueId, step: "cluster-review" }),
    });
    if (res.ok) {
      setApproved(true);
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
    <button
      onClick={handleApprove}
      disabled={loading}
      className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
    >
      {loading ? "Resuming..." : "Approve & Continue Pipeline"}
    </button>
  );
}
