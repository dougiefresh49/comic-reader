"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setBookPublished } from "./publish-actions";

/**
 * The publish switch on one admin book row. `router.refresh()` re-runs the
 * server component so the badge and the library both reflect the write; the
 * action already revalidates the public paths, so this is only the admin view.
 */
export default function BookPublishToggle({
  bookId,
  published,
}: {
  bookId: string;
  published: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const result = await setBookPublished(bookId, !published);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={published}
        className="rounded bg-emerald-700/60 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {pending ? "Saving" : published ? "Unpublish" : "Publish"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
