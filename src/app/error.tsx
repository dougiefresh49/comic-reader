"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * App-wide error boundary. Renders a friendly retry page instead of
 * Vercel's raw 500, and surfaces the Next.js error digest — the same
 * digest Next logs server-side, so one log query finds the stack.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error.digest ?? "", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-4 text-center text-neutral-100">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-sm text-neutral-400">
          The page hit an error. It&apos;s usually temporary — try again.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-neutral-300 transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        >
          Back to Library
        </Link>
      </div>

      {error.digest ? (
        <p className="text-xs text-neutral-600 tabular-nums">
          Error digest: {error.digest}
        </p>
      ) : null}
    </main>
  );
}
