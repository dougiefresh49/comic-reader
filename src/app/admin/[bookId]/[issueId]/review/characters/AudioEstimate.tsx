// The casting page's audio estimate (#106): what Continue's audio step would
// render now, and what the ElevenLabs account has left. Read-only; the page
// computes both on the server.
import type { AudioEstimate as Estimate } from "~/lib/audio-estimate";
import { ELEVENLABS_USD_PER_CHARACTER } from "~/lib/models";
import { estimateCredits, type TtsCreditRate } from "~/lib/tts-credit-rate";
import type { CharacterStatus } from "~/lib/voice-slots/elevenlabs";

export interface AudioEstimateData {
  /** Null when the estimate's read failed; `estimateError` says why. */
  estimate: Estimate | null;
  estimateError: string | null;
  /** Null when the subscription read failed; `accountError` says why. */
  account: CharacterStatus | null;
  accountError: string | null;
  /** The billed rate of recent renders (#838); null shows characters only. */
  rate: TtsCreditRate | null;
}

const n = (v: number) => v.toLocaleString("en-US");
const lines = (v: number) => `${n(v)} ${v === 1 ? "line" : "lines"}`;

export function AudioEstimate({ data }: { data: AudioEstimateData }) {
  const { estimate, account, rate } = data;
  const parts: string[] = [];
  if (estimate) {
    // `usd_est` in `llm_calls` is credits times the same per-unit price.
    const credits = rate ? estimateCredits(estimate.characters, rate) : null;
    parts.push(
      `Audio to render: ${lines(estimate.lines)}, about ${n(estimate.characters)} characters of text${
        credits == null
          ? "."
          : `, about ${n(credits)} credits ($${(credits * ELEVENLABS_USD_PER_CHARACTER).toFixed(2)}) at the rate of the last ${rate!.renders} renders.`
      }`,
    );
    if (estimate.waiting > 0)
      parts.push(
        `${lines(estimate.waiting)} ${estimate.waiting === 1 ? "waits" : "wait"} for a voice.`,
      );
  } else {
    parts.push(`Audio estimate unavailable (${data.estimateError}).`);
  }
  parts.push(
    account
      ? `Account: ${n(Math.max(0, account.character_limit - account.character_count))} of ${n(account.character_limit)} credits left.`
      : `Account balance unavailable (${data.accountError}).`,
  );
  const text = parts.join(" ");
  return (
    <div
      role="status"
      aria-label="Audio estimate"
      className="flex shrink-0 items-center border-b border-neutral-800 bg-neutral-900/60 px-[18px] py-1 text-[12px] text-neutral-400"
    >
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
    </div>
  );
}
