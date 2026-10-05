// The old casting page (#353, #357) lives on as a redirect: to the voices stop with a book and issue, to /admin without.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface SearchParams {
  searchParams: Promise<{ book?: string; issue?: string }>;
}

const voicesStop = (bookId: string, issueId: string) =>
  `/admin/${encodeURIComponent(bookId)}/${encodeURIComponent(issueId)}/review/characters/voices`;

export default async function CastingPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  if (sp.book && sp.issue) redirect(voicesStop(sp.book, sp.issue));
  redirect("/admin");
}
