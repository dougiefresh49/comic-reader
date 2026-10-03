import { notFound } from "next/navigation";
import { loadCharacters } from "./load";
import { CharactersScreen } from "./CharactersScreen";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function CharactersStopPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const data = await loadCharacters(bookId, issueId);
  if (!data) notFound();
  return <CharactersScreen data={data} />;
}
