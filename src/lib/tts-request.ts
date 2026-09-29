import { getVoiceSettingsFromEmotion } from "./voice-settings";

/**
 * The one model every TTS request names. ElevenLabs defaults `model_id` to
 * `eleven_multilingual_v2` when a request leaves it out, so a call site that
 * omits it silently renders with a different model than the one the audio
 * was made with.
 */
export const TTS_MODEL = "eleven_v3";

export interface TtsRequestOptions {
  /** The bubble's `text_with_cues`, else its `ocr_text`. */
  text: string;
  /** The bubble's `emotion`. Null and undefined both read as "neutral". */
  emotion?: string | null;
  /**
   * The castlist `voice_id`. Not part of the returned object: the SDK takes
   * it as the first positional argument, beside the request.
   */
  voiceId: string;
  /** The adjacent bubble's text, in reading order. Only sent with `withContext`. */
  previousText?: string;
  /** The adjacent bubble's text, in reading order. Only sent with `withContext`. */
  nextText?: string;
  /**
   * Whether to send `previous_text` and `next_text` to ElevenLabs. Off by
   * default, so every call site sends the same request for the same bubble
   * until #107 and #111 decide otherwise.
   *
   * What the API reference says (read 2026-09-29, no call made):
   *
   * - `previous_text`: "The text that came before the text of the current
   *   request. Can be used to improve the speech's continuity when
   *   concatenating together multiple generations or to influence the
   *   speech's continuity in the current generation."
   * - `next_text`: the same, for the text after. Sending both is what
   *   `scripts/generate-audio.ts` had commented out.
   * - `voice_settings.speed`: "A value of 1.0 is the default speed, while
   *   values less than 1.0 slow down the speech, and values greater than
   *   1.0 speed it up."
   * - `voice_settings.similarity_boost`: how closely the AI adheres to the
   *   original voice. Default 0.75, which is what `getVoiceSettingsFromEmotion`
   *   returns for every emotion.
   * - `voice_settings.use_speaker_boost`: a boolean, server default true. It
   *   raises resemblance to the original speaker and costs latency. The
   *   reference documents no `eleven_v3` behaviour that overrides this, and
   *   the voice-settings table has no field for it, so every request leaves
   *   it to the server default.
   * - `model_id`: defaults to `eleven_multilingual_v2` when omitted.
   *
   * The reference carries nothing model-specific about which voice settings
   * `eleven_v3` honours or ignores, so nothing here says v3 drops any of
   * them. Confirming it needs a live call, which this lane does not spend.
   */
  withContext?: boolean;
}

/** The SDK's `BodyTextToSpeechFullWithTimestamps`, narrowed to what we send. */
export interface TtsRequest {
  modelId: string;
  text: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    speed: number;
  };
  previousText?: string;
  nextText?: string;
}

/**
 * The request every TTS call sends, built from one table.
 *
 * Pure: no SDK import, no env read, no I/O, so #106's content hash, #107 and
 * voice-lab's design card can call it without a client.
 */
export function buildTtsRequest({
  text,
  emotion,
  previousText,
  nextText,
  withContext = false,
}: TtsRequestOptions): TtsRequest {
  const { stability, similarityBoost, style, speed } =
    getVoiceSettingsFromEmotion(emotion ?? "neutral");

  const request: TtsRequest = {
    modelId: TTS_MODEL,
    text,
    voiceSettings: { stability, similarityBoost, style, speed },
  };

  if (withContext) {
    request.previousText = previousText;
    request.nextText = nextText;
  }

  return request;
}
