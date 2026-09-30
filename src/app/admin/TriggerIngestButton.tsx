"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  type TriggerRefusal,
  TriggerRefusalNotice,
  readTriggerRefusal,
} from "./PipelineActions";

export function TriggerIngestButton({
  bookId,
  issueId,
}: {
  bookId: string;
  issueId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);
  const [refusal, setRefusal] = useState<TriggerRefusal | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();

  async function handleTrigger() {
    setLoading(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/admin/trigger-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, issueId }),
      });
      if (res.ok) {
        setTriggered(true);
      } else {
        setRefusal(await readTriggerRefusal(res));
      }
    } finally {
      setLoading(false);
    }
  }

  if (triggered) {
    return (
      <span className="rounded bg-emerald-700/30 px-2.5 py-1 text-xs font-medium text-emerald-300">
        Queued
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        onClick={handleTrigger}
        disabled={loading || cancelling}
        className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
      >
        {loading ? "..." : "Start Pipeline"}
      </button>
      {refusal && (
        <TriggerRefusalNotice
          bookId={bookId}
          issueId={issueId}
          refusal={refusal}
          onCancelled={() => {
            setRefusal(null);
            router.refresh();
          }}
          onCancellingChange={setCancelling}
        />
      )}
    </span>
  );
}
