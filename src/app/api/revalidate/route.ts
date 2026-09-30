import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { revalidateReaderPages } from "~/lib/revalidate-reader";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-revalidate-secret");
  if (secret !== process.env.REVALIDATE_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { bookId, issueId } = (await req.json()) as {
    bookId: string;
    issueId: string;
  };
  await revalidateReaderPages(bookId, issueId);
  revalidatePath(`/admin/${bookId}/${issueId}/review/bubbles`, "page");
  revalidatePath(`/book/${bookId}`);
  revalidatePath("/");
  return Response.json({ revalidated: true, bookId, issueId });
}
