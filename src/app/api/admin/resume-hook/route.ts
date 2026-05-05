import "server-only";
import { type NextRequest } from "next/server";
import { resumeHook } from "workflow/api";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    step: string;
  };

  if (!body.bookId || !body.issueId || !body.step) {
    return Response.json(
      { error: "missing bookId, issueId, or step" },
      { status: 400 },
    );
  }

  const token = `ingest:${body.bookId}/${body.issueId}/${body.step}`;

  try {
    const result = await resumeHook(token, { approved: true });
    return Response.json({
      ok: true,
      runId: result.runId,
    });
  } catch {
    return Response.json(
      { error: "Hook not found or already resumed" },
      { status: 404 },
    );
  }
}
