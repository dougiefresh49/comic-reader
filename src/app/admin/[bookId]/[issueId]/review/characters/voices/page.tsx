import { notFound } from "next/navigation";
import { loadVoices } from "./load";
import { VoicesScreen } from "./VoicesScreen";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function VoicesStopPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const data = await loadVoices(bookId, issueId);
  if (!data) notFound();
  return <VoicesScreen data={data} />;
}
