import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-revalidate-secret");
  if (secret !== process.env.REVALIDATE_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { bookId, issueId } = (await req.json()) as {
    bookId: string;
    issueId: string;
  };
  revalidatePath(`/book/${bookId}/${issueId}`, "page");
  revalidatePath(`/book/${bookId}/${issueId}/review`, "page");
  revalidatePath(`/book/${bookId}`, "page");
  revalidatePath("/", "page");
  return Response.json({ revalidated: true, bookId, issueId });
}
