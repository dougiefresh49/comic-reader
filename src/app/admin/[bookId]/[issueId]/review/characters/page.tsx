import { notFound } from "next/navigation";
import { estimateIssueAudio } from "~/lib/audio-estimate";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { getCharacterStatus } from "~/lib/voice-slots/elevenlabs";
import type { AudioEstimateData } from "./AudioEstimate";
import { loadCharacters } from "./load";
import { CastingScreen } from "./CastingScreen";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The casting page (#787): the characters stop and the voices stop on one page. */
export default async function CastingPage({ params }: Params) {
  const { bookId, issueId } = await params;
  // Both reads are free (SELECTs and `GET /v1/user/subscription`); a failed
  // one shows its error on the estimate line, never fails the page.
  const [data, estimate, account] = await Promise.all([
    loadCharacters(bookId, issueId),
    estimateIssueAudio(supabaseAdmin, bookId, issueId).then(
      (v) => ({ v, e: null }),
      (e: unknown) => ({ v: null, e: why(e) }),
    ),
    getCharacterStatus({ supabase: supabaseAdmin }).then(
      (v) => ({ v, e: null }),
      (e: unknown) => ({ v: null, e: why(e) }),
    ),
  ]);
  if (!data) notFound();
  const audioEstimate: AudioEstimateData = {
    estimate: estimate.v,
    estimateError: estimate.e,
    account: account.v,
    accountError: account.e,
  };
  return <CastingScreen data={data} audioEstimate={audioEstimate} />;
}
