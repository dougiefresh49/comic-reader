// The review editor: one workbench for an issue's panels and bubbles. Reads rows; every edit stays in the browser.
import { notFound } from "next/navigation";
import { Workbench } from "~/components/review-editor/Workbench";
import { loadEditor } from "./loader";

export const dynamic = "force-dynamic";

interface EditorPageProps {
  params: Promise<{ bookId: string; issueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EditorPage({
  params,
  searchParams,
}: EditorPageProps) {
  const { bookId, issueId } = await params;
  const sp = await searchParams;
  const data = await loadEditor(bookId, issueId);
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
