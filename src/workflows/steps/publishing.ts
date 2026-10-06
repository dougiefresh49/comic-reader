import { getWorkflowMetadata } from "workflow";
import { updateIssue } from "~/lib/issue-queries";
import { bubbleNeedsAudio } from "./audio-plan";
import { updateRunSteps } from "./pipeline-runs";

export async function generateManifest(bookId: string, issueId: string) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const [pageRes, bubbleRes, audioRes, tsRes] = await Promise.all([
    supabase
      .from("pages")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .not("audio_storage_path", "is", null),
    supabase
      .from("audio_timestamps")
      .select("bubble_id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  if (pageRes.error) throw new Error(pageRes.error.message);
  if (bubbleRes.error) throw new Error(bubbleRes.error.message);
  if (audioRes.error) throw new Error(audioRes.error.message);
  if (tsRes.error) throw new Error(tsRes.error.message);

  const pageCount = pageRes.count ?? 0;
  const bubbleCount = bubbleRes.count ?? 0;
  const audioCount = audioRes.count ?? 0;
  const timestampCount = tsRes.count ?? 0;
  // Spoken bubbles (text and a speaker) with no audio: the ones a resumed
  // casting gate accepted as silent, plus any other audio skip. Speakerless
  // bubbles such as SFX are never voiced, so they are not counted. The text
  // test is bubbleNeedsAudio, which a head count cannot express, so this
  // pages through the candidates until a page comes back empty (a short
  // page does not end it: max_rows may be under the page size).
  let silentBubbles = 0;
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .from("bubbles")
      .select(
        "id, speaker, ignored, silent, audio_storage_path, text_with_cues, ocr_text",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .is("audio_storage_path", null)
      .not("speaker", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (data.length === 0) break;
    silentBubbles += data.filter(
      (b) => bubbleNeedsAudio(b) && !!b.speaker?.trim(),
    ).length;
    from += data.length;
  }

  const { error: upErr } = await updateIssue(supabase, bookId, issueId, {
    page_count: pageCount,
    bubble_count: bubbleCount,
    audio_count: audioCount,
    has_audio: audioCount > 0,
    has_timestamps: timestampCount > 0,
  });

  if (upErr) throw new Error(upErr.message);

  console.log(
    `[manifest] ${bookId}/${issueId}: ${pageCount} pages, ${bubbleCount} bubbles, ${audioCount} audio, ${timestampCount} timestamps, ${silentBubbles} silent`,
  );

  // Record silentBubbles on this run's pipeline_runs row. Logged, not
  // thrown, like the other run writes.
  await updateRunSteps(
    supabase,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => ({ ...steps, silentBubbles }),
    "manifest",
  );
}
