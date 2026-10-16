import "server-only";
import { type NextRequest } from "next/server";
import { resumeHook } from "workflow/api";
import { hookToken } from "~/lib/ingest-hooks";
import { canApproveCharacters } from "~/server/admin/characters-gate";
import { canContinueVoices } from "~/server/admin/voices-gate";
import { canResumePages } from "~/server/admin/pages-gate";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: unknown;
    issueId: unknown;
    step: unknown;
    skip?: unknown;
  };

  // Strings only: an array step would skip the checks below and still
  // stringify into a live hook token.
  if (
    typeof body.bookId !== "string" ||
    typeof body.issueId !== "string" ||
    typeof body.step !== "string" ||
    !body.bookId ||
    !body.issueId ||
    !body.step
  ) {
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

  // "Skip and finish" (#358) exists only at the voices stop: the run goes on
  // without the check below, renders what has a voice, and never comes back
  // to Voices this run.
  if (body.skip !== undefined && body.skip !== false) {
    if (body.skip !== true || body.step !== "casting") {
      return Response.json(
        { error: "skip is true or absent, and only for the casting step" },
        { status: 400 },
      );
    }
  }
  const skip = body.skip === true;

  // The voices stop (#353): the same check the screen's Continue runs.
  if (body.step === "casting" && !skip) {
    const verdict = await canContinueVoices(body.bookId, body.issueId);
    if (!verdict.ok) {
      return Response.json({ error: verdict.reason }, { status: 409 });
    }
  }

  // The pages stop (#384): the same check the editor's Approve issue runs,
  // so a direct POST cannot skip it.
  if (body.step === "page-review") {
    const verdict = await canResumePages(body.bookId, body.issueId);
    if (!verdict.ok) {
      return Response.json({ error: verdict.error }, { status: 409 });
    }
  }

  const token = hookToken(body.bookId, body.issueId, body.step);

  try {
    const result = await resumeHook(
      token,
      skip ? { approved: true, skip: true } : { approved: true },
    );
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
