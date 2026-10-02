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

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * A new Voice Design voice: the headroom check, then the preview request
 * and the create that takes the slot, each logged to `llm_calls`. No retry.
 * A failed preview creates nothing, so it throws `ElevenLabsRefusedError`,
 * as does a non-2xx create; a create that times out or answers without a
 * `voice_id` throws anything else, and the voice may exist.
 */
export async function designVoice(
  deps: VoiceSlotsDeps,
  input: DesignVoiceInput,
): Promise<{ voice_id: string }> {
  await requireHeadroom(deps, 1);

  let generatedId: string | undefined;
  try {
    const preview = await recordElevenLabsCall(
      { ...input.meta, model: "eleven_ttv_v3" },
      null,
      () =>
        el(deps, "/v1/text-to-voice/design", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            voice_description: input.description,
            model_id: "eleven_ttv_v3",
            auto_generate_text: true,
          }),
        }),
    );
    if (!preview.ok)
      throw await failure(preview, "POST /v1/text-to-voice/design");
    const body = (await preview.json()) as {
      previews?: { generated_voice_id?: string }[];
    };
    generatedId = body.previews?.[0]?.generated_voice_id;
    if (!generatedId) throw new Error("no preview returned");
  } catch (err) {
    // A preview is not a voice: nothing holds a slot yet.
    throw new ElevenLabsRefusedError(
      `Voice Design preview failed, no voice created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const created = await recordElevenLabsCall(
    { ...input.meta, model: "text-to-voice" },
    null,
    () =>
      el(deps, "/v1/text-to-voice", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          voice_name: input.name,
          voice_description: input.description,
          generated_voice_id: generatedId,
          ...(input.opToken ? { labels: { [OP_LABEL]: input.opToken } } : {}),
        }),
      }),
  );
  if (!created.ok)
    throw new ElevenLabsRefusedError(
      (await failure(created, "POST /v1/text-to-voice")).message,
    );
  const body = (await created.json()) as { voice_id?: string };
  if (!body.voice_id) throw new Error("POST /v1/text-to-voice: no voice_id");
  return { voice_id: body.voice_id };
}
