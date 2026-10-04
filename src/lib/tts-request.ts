import { BASE_VOICE_SETTINGS, type VoiceOverride } from "./voice-settings";

/**
 * The one model every TTS request names. ElevenLabs defaults `model_id` to
 * `eleven_multilingual_v2` when a request leaves it out, so a call site that
 * omits it silently renders with a different model than the one the audio
 * was made with.
 */
export const TTS_MODEL = "eleven_v4";

export interface TtsRequestOptions {
  /** The bubble's `text_with_cues`, else its `ocr_text`. */
  text: string;
  /**
   * The castlist `voice_id`. Not part of the returned object: the SDK takes
   * it as the first positional argument, beside the request.
   */
  voiceId: string;
  /**
   * The voice's parsed `voices.voice_settings` (`loadVoiceOverrides`). Its
   * numbers replace the base settings and its `linePrefix` goes in front of
   * the text. Required, so a call site cannot forget the voice's settings;
   * `undefined` (a voice with no row) uses the base and the bare text.
   */
  override: VoiceOverride | undefined;
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
   * - `voice_settings.use_speaker_boost`: a boolean, server default true. It
   *   raises resemblance to the original speaker and costs latency. Every
   *   request leaves it to the server default.
   * - `model_id`: defaults to `eleven_multilingual_v2` when omitted.
   */
  withContext?: boolean;
}

/**
 * What `eleven_v4` does with `voiceSettings`, from the #213 probe
 * (2026-09-28, two with-timestamps calls on the Michelangelo voice):
 *
 * - `stability` and `similarity_boost` are the two settings v4 uses.
 *   `GET /v1/models` reports `can_use_style: false` for it.
 * - A call that also sent `style: 0.5` and `speed: 1.1` returned 200 with
 *   audio of the same length and byte count as one without them, so v4
 *   accepts both and ignores them. The builder sends neither.
 * - The alignment holds every character of the text, tag characters
 *   included, which is why a `linePrefix` tag needs no reader change:
 *   `buildWordTimings` drops anything in square brackets.
 */

/** The SDK's `BodyTextToSpeechFullWithTimestamps`, narrowed to what we send. */
export interface TtsRequest {
  modelId: string;
  text: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
  };
  previousText?: string;
  nextText?: string;
}

/**
 * The request every TTS call sends: the base settings with the voice's
 * override on top, and the voice's line prefix in front of the text. The
 * prefix is added here and nowhere else, so #106's content hash of the
 * request covers it, and it is billed, so callers record `text.length` of
 * the returned request.
 *
 * Pure: no SDK import, no env read, no I/O, so #106's content hash, #107 and
 * voice-lab's design card can call it without a client.
 */
export function buildTtsRequest({
  text,
  override,
  previousText,
  nextText,
  withContext = false,
}: TtsRequestOptions): TtsRequest {
  // An older or hand-edited `text_with_cues` can already carry the voice's
  // tag, so a text that starts with it is sent as it is, not tagged twice.
  const prefix = override?.linePrefix;
  const request: TtsRequest = {
    modelId: TTS_MODEL,
    text:
      prefix && !text.trimStart().startsWith(prefix)
        ? `${prefix} ${text}`
        : text,
    voiceSettings: {
      stability: override?.stability ?? BASE_VOICE_SETTINGS.stability,
      similarityBoost:
        override?.similarityBoost ?? BASE_VOICE_SETTINGS.similarityBoost,
    },
  };

  if (withContext) {
    request.previousText = previousText;
    request.nextText = nextText;
  }

  return request;
}
