import "server-only";
import { type NextRequest } from "next/server";
import { start } from "workflow/api";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ingestPipeline } from "~/workflows/ingest-pipeline";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    fromStep?: string;
  };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  const { data: issue } = (await selectIssue(
    supabaseAdmin as SupabaseClient<Database>,
    body.bookId,
    body.issueId,
    "id, pipeline_step",
  ).single()) as {
    data: { id: string; pipeline_step: string | null } | null;
  };

  if (!issue) {
    return Response.json({ error: "issue not found" }, { status: 404 });
  }

  const pipelineStep = body.fromStep ?? "roboflow-page-analyze";

  const { error } = await updateIssue(
    supabaseAdmin as SupabaseClient<Database>,
    body.bookId,
    body.issueId,
    {
      pipeline_step: pipelineStep,
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    },
  );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const run = await start(ingestPipeline, [
    {
      bookId: body.bookId,
      issueId: body.issueId,
      fromStep: body.fromStep,
    },
  ]);

  const { error: runError } = await supabaseAdmin.from("pipeline_runs").insert({
    book_id: body.bookId,
    issue_id: body.issueId,
    status: "running",
    steps: {
      runId: run.runId,
      fromStep: body.fromStep ?? null,
      skipped: [],
    },
  });

  if (runError) {
    console.error("pipeline_runs insert failed after start():", runError);
    return Response.json({
      ok: true,
      bookId: body.bookId,
      issueId: body.issueId,
      fromStep: body.fromStep ?? null,
      runId: run.runId,
      status: "started",
      warning: runError.message,
    });
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    fromStep: body.fromStep ?? null,
    runId: run.runId,
    status: "started",
  });
}
