import { notFound } from "next/navigation";
import { loadCharacters } from "./load";
import { CastingScreen } from "./CastingScreen";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

/** The casting page (#787): the characters stop and the voices stop on one page. */
export default async function CastingPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const data = await loadCharacters(bookId, issueId);
  if (!data) notFound();
  return <CastingScreen data={data} />;
}
