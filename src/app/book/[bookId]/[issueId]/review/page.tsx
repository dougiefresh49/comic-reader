import { permanentRedirect } from "next/navigation";

// The bubble review editor moved under /admin (issue #121). The old path
// answers with a permanent redirect so bookmarks and the pipeline's pause
// link keep working. It carries the query string across, because
// ?mode=pipeline is what the pipeline sends.
export default async function ReviewRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string; issueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { bookId, issueId } = await params;
  const sp = await searchParams;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) {
      for (const v of value) query.append(key, v);
    }
  }
  const qs = query.toString();
  const target = `/admin/${bookId}/${issueId}/review/bubbles${qs ? `?${qs}` : ""}`;

  permanentRedirect(target);
}
