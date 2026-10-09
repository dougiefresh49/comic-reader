import { redirect } from "next/navigation";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

/** The voices stop is the casting page now (#787); old links land there. */
export default async function VoicesStopPage({ params }: Params) {
  const { bookId, issueId } = await params;
  redirect(
    `/admin/${encodeURIComponent(bookId)}/${encodeURIComponent(issueId)}/review/characters`,
  );
}
