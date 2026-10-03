import "server-only";
import { type NextRequest } from "next/server";
import { resumeHook } from "workflow/api";
import { canApproveCharacters } from "~/server/admin/characters-gate";
import { canContinueVoices } from "~/server/admin/voices-gate";

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

  // The characters stop (#349): the same check the screen's Approve runs,
  // so the dashboard's Resume cannot skip it.
  if (body.step === "cluster-review") {
    const verdict = await canApproveCharacters(body.bookId, body.issueId);
    if (!verdict.ok) {
      return Response.json({ error: verdict.reason }, { status: 409 });
    }
  }

  // The voices stop (#353): the same check the screen's Continue runs.
  if (body.step === "casting") {
    const verdict = await canContinueVoices(body.bookId, body.issueId);
    if (!verdict.ok) {
      return Response.json({ error: verdict.reason }, { status: 409 });
    }
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
