// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The characters stop. Reads rows with SELECTs only; every choice stays in the browser.
import { notFound } from "next/navigation";
import { loadProto, readQuery } from "../data";
import { ProtoHeader } from "../ProtoHeader";
import { Characters } from "./Characters";

export const dynamic = "force-dynamic";

interface CharactersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CharactersPage({
  searchParams,
}: CharactersPageProps) {
  const data = await loadProto(readQuery(await searchParams));
  if (!data) notFound();
  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <ProtoHeader
        book={data.bookId}
        issue={data.issueId}
        bookName={data.bookName}
        issueName={data.issueName}
        current="characters"
      />
      <Characters key={`${data.bookId}/${data.issueId}`} data={data} />
    </div>
  );
}
