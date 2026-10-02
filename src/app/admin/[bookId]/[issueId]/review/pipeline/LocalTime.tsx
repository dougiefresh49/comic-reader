"use client";

import { useEffect, useState } from "react";

/**
 * An ISO timestamp in the browser's time zone. The server renders UTC first,
 * then the browser swaps in its own zone after mount, so the markup it
 * hydrates against is the markup it was sent.
 */
export function LocalTime({ iso }: { iso: string }) {
  const date = new Date(iso);
  const [text, setText] = useState(() => `${utcLabel(date)} UTC`);

  useEffect(() => {
    setText(
      date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iso is the only input
  }, [iso]);

  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

function utcLabel(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
