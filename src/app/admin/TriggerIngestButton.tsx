"use client";

import { useState } from "react";

export function TriggerIngestButton({
  bookId,
  issueId,
}: {
  bookId: string;
  issueId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);

  async function handleTrigger() {
    setLoading(true);
    const res = await fetch("/api/admin/trigger-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, issueId }),
    });
    if (res.ok) {
      setTriggered(true);
    }
    setLoading(false);
  }

  if (triggered) {
    return (
      <span className="rounded bg-emerald-700/30 px-2.5 py-1 text-xs font-medium text-emerald-300">
        Queued
      </span>
    );
  }

  return (
    <button
      onClick={handleTrigger}
      disabled={loading}
      className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
    >
      {loading ? "..." : "Start Pipeline"}
    </button>
  );
}
