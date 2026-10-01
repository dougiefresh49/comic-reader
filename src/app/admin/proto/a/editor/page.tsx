// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The pages stop: the workbench editor. Reads rows with SELECTs; every edit stays in the browser.
import { notFound } from "next/navigation";
import { loadProto, readQuery } from "../data";
import { Workbench } from "./Workbench";

export const dynamic = "force-dynamic";

interface EditorPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EditorPage({ searchParams }: EditorPageProps) {
  const sp = await searchParams;
  const data = await loadProto(readQuery(sp));
  if (!data) notFound();
  const page = typeof sp.page === "string" ? parseInt(sp.page, 10) : NaN;
  return (
    <Workbench
      key={`${data.bookId}/${data.issueId}`}
      data={data}
      initialPage={Number.isNaN(page) ? null : page}
    />
  );
}
