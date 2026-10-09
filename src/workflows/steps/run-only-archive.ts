/**
 * After an issue's audio renders, archive each "this run only" voice cast in
 * it (#790): `voices.run_only`, still active, cast by a castlist row of this
 * issue and by no castlist row of any other issue. Each goes through
 * `runMoves` as one backed-up `archive` move, with `renderedLinesVoiced` on,
 * so the planner refuses while any of the voice's lines here lacks audio
 * rendered by it. One run per voice, so one refusal leaves the others free.
 *
 * Never throws: a failed archive is logged and the pipeline goes on to
 * publishing, so the Workflow runtime never retries it.
 */
export async function archiveRunOnlyVoices(
  bookId: string,
  issueId: string,
): Promise<{
  archived: number;
  castElsewhere: number;
  refused: number;
  failed: number;
}> {
  "use step";
  const tag = `[run-only-archive] ${bookId}/${issueId}`;
  const summary = { archived: 0, castElsewhere: 0, refused: 0, failed: 0 };
  try {
    const { createTypedStepClient } = await import("../step-utils");
    const { runMoves } = await import("~/lib/casting-moves");
    const { readCastVoiceLinks } = await import("~/lib/cast");
    const { readVoices } = await import("~/lib/voice-slots");
    const supabase = await createTypedStepClient();

    // Every book's castlist rows: the ones casting a voice here, and the
    // ones that keep a candidate from being archived.
    const cast = await readCastVoiceLinks(supabase);
    const castHere = [
      ...new Set(
        cast.flatMap((c) =>
          c.book_id === bookId && c.issue_id === issueId && c.voice_uuid
            ? [c.voice_uuid]
            : [],
        ),
      ),
    ];
    if (castHere.length === 0) return summary;

    const here = new Set(castHere);
    const voices = (await readVoices(supabase)).filter(
      (v) => here.has(v.id) && v.run_only && v.status === "active",
    );

    for (const v of voices) {
      const name = `${v.display_name} (${v.id})`;
      const elsewhere = cast.filter(
        (c) =>
          c.voice_uuid === v.id &&
          !(c.book_id === bookId && c.issue_id === issueId),
      );
      if (elsewhere.length > 0) {
        summary.castElsewhere++;
        console.log(
          `${tag}: left ${name} alone, also cast in ${[...new Set(elsewhere.map((c) => `${c.book_id}/${c.issue_id}`))].join(", ")}`,
        );
        continue;
      }
      try {
        const result = await runMoves(
          { supabase },
          bookId,
          issueId,
          [
            {
              kind: "archive",
              voice_uuid: v.id,
              backup: true,
              lossy_ok: false,
            },
          ],
          { renderedLinesVoiced: true },
        );
        if (result.status === "refused") {
          summary.refused++;
          console.log(
            `${tag}: refused to archive ${name}: ${result.blockers.map((b) => `${b.code}: ${b.reason}`).join("; ")}`,
          );
        } else if (result.status === "done") {
          summary.archived++;
          console.log(`${tag}: archived ${name}, run ${result.runId}`);
        } else {
          summary.failed++;
          const reasons = result.moves.flatMap((m) =>
            m.status === "done" ? [] : [`${m.status}: ${m.reasons.join(", ")}`],
          );
          console.warn(
            `${tag}: archive of ${name} needs attention, run ${result.runId}: ${reasons.join("; ")}`,
          );
        }
      } catch (err) {
        summary.failed++;
        console.warn(
          `${tag}: archive of ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    summary.failed++;
    console.warn(
      `${tag}: run-only archive failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`${tag}: ${JSON.stringify(summary)}`);
  return summary;
}
