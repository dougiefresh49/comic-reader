// The old cluster review lives on as a redirect: the characters stop (#349) is the one screen for the cast and its faces.
import { redirect } from "next/navigation";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewClustersPage({ params }: Params) {
  const { bookId, issueId } = await params;
  redirect(`/admin/${bookId}/${issueId}/review/characters`);
}
