import { recordElevenLabsCall, type LlmCallMeta } from "~/lib/llm-usage";
import {
  ElevenLabsRefusedError,
  OP_LABEL,
  el,
  failure,
  requireHeadroom,
} from "./elevenlabs";
import type { VoiceSlotsDeps } from "./types";

export interface DesignVoiceInput {
  /** The ElevenLabs voice name; the lookup after an unread reply matches on it. */
  name: string;
  description: string;
  /** Minted per add; sent as the `OP_LABEL` label so a lost reply can be matched. */
  opToken?: string;
  /** Where the `llm_calls` rows say the two requests came from. */
  meta: LlmCallMeta;
}

/** One Voice Design take: an unsaved voice that can say its preview text only. */
export interface DesignPreview {
  /** What `createFromPreview` turns into a voice. */
  generated_voice_id: string;
  /** The take's audio, base64. */
  audio_base_64: string;
  media_type: string;
  duration_secs: number | null;
}

export interface DesignPreviewsResult {
  previews: DesignPreview[];
  /** The text the takes say: the preview text sent, or the one ElevenLabs wrote. */
  text: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const DESIGN_MODEL = "eleven_ttv_v3";

/**
 * Voice Design's previews: `POST /v1/text-to-voice/design`, three takes from
 * one description. Takes no slot; charges credits for the preview text,
 * logged to `llm_calls`. `previewText` null lets ElevenLabs write the text.
 * Any failure throws `ElevenLabsRefusedError`: a preview is not a voice, so
 * nothing holds a slot whatever happened.
 */
export async function designPreviews(
  deps: VoiceSlotsDeps,
  description: string,
  previewText: string | null,
  opts: { seed?: number; meta?: LlmCallMeta } = {},
): Promise<DesignPreviewsResult> {
  try {
    const r = await recordElevenLabsCall(
      { ...(opts.meta ?? { step: "design-previews" }), model: DESIGN_MODEL },
      null,
      () =>
        el(deps, "/v1/text-to-voice/design", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            voice_description: description,
            model_id: DESIGN_MODEL,
            ...(previewText
              ? { text: previewText }
              : { auto_generate_text: true }),
            ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          }),
        }),
    );
    if (!r.ok) throw await failure(r, "POST /v1/text-to-voice/design");
    const body = (await r.json()) as {
      previews?: Partial<DesignPreview>[];
      text?: string;
    };
    const previews = (body.previews ?? []).flatMap((p) =>
      p.generated_voice_id
        ? [
            {
              generated_voice_id: p.generated_voice_id,
              audio_base_64: p.audio_base_64 ?? "",
              media_type: p.media_type ?? "audio/mpeg",
              duration_secs: p.duration_secs ?? null,
            },
          ]
        : [],
    );
    if (previews.length === 0) throw new Error("no preview returned");
    return { previews, text: body.text ?? previewText ?? "" };
  } catch (err) {
    throw new ElevenLabsRefusedError(
      `Voice Design preview failed, no voice created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Saves one Voice Design take as a voice: `POST /v1/text-to-voice`, which
 * takes a slot. The headroom check runs first. No retry. A non-2xx reply
 * throws `ElevenLabsRefusedError`; a timeout or a reply without a
 * `voice_id` throws anything else, and the voice may exist (`opToken` is
 * sent as the `OP_LABEL` label so a lost reply can be matched).
 */
export async function createFromPreview(
  deps: VoiceSlotsDeps,
  generatedVoiceId: string,
  name: string,
  description: string,
  opts: { opToken?: string; meta?: LlmCallMeta } = {},
): Promise<{ voice_id: string }> {
  await requireHeadroom(deps, 1);
  const created = await recordElevenLabsCall(
    {
      ...(opts.meta ?? { step: "create-from-preview" }),
      model: "text-to-voice",
    },
    null,
    () =>
      el(deps, "/v1/text-to-voice", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          voice_name: name,
          voice_description: description,
          generated_voice_id: generatedVoiceId,
          ...(opts.opToken ? { labels: { [OP_LABEL]: opts.opToken } } : {}),
        }),
      }),
  );
  if (!created.ok)
    throw new ElevenLabsRefusedError(
      (await failure(created, "POST /v1/text-to-voice")).message,
      created.status,
    );
  const body = (await created.json()) as { voice_id?: string };
  if (!body.voice_id) throw new Error("POST /v1/text-to-voice: no voice_id");
  return { voice_id: body.voice_id };
}

/**
 * A new Voice Design voice in one go, the voices stop's design: the headroom
 * check, `designPreviews` with text ElevenLabs writes, then
 * `createFromPreview` on the first take. Errors as those two throw them.
 */
export async function designVoice(
  deps: VoiceSlotsDeps,
  input: DesignVoiceInput,
): Promise<{ voice_id: string }> {
  await requireHeadroom(deps, 1);
  const { previews } = await designPreviews(deps, input.description, null, {
    meta: input.meta,
  });
  return createFromPreview(
    deps,
    previews[0]!.generated_voice_id,
    input.name,
    input.description,
    { opToken: input.opToken, meta: input.meta },
  );
}
