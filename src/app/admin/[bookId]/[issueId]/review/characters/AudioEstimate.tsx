// The casting page's audio estimate (#106): what Continue's audio step would
// render now, and what the ElevenLabs account has left. Read-only; the page
// computes both on the server.
import type { AudioEstimate as Estimate } from "~/lib/audio-estimate";
import type { CharacterStatus } from "~/lib/voice-slots/elevenlabs";

export interface AudioEstimateData {
  /** Null when the estimate's read failed; `estimateError` says why. */
  estimate: Estimate | null;
  estimateError: string | null;
  /** Null when the subscription read failed; `accountError` says why. */
  account: CharacterStatus | null;
  accountError: string | null;
}

const n = (v: number) => v.toLocaleString("en-US");
const lines = (v: number) => `${n(v)} ${v === 1 ? "line" : "lines"}`;

export function AudioEstimate({ data }: { data: AudioEstimateData }) {
  const { estimate, account } = data;
  const parts: string[] = [];
  if (estimate) {
    parts.push(
      `Audio to render: ${lines(estimate.lines)}, about ${n(estimate.characters)} characters of text.`,
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
