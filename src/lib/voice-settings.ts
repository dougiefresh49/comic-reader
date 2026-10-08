/** The two settings eleven_v4 uses. It accepts `style` and `speed` and ignores them (#213 probe). */
export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
}

/**
 * Every take's settings unless its voice overrides them: the values the owner
 * heard working on eleven_v4 in the 2026-10-03 tag test (#412). Tags carry the
 * emotion, so the settings no longer vary per bubble.
 */
export const BASE_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.17,
  similarityBoost: 0.81,
};

/** One voice's `voices.voice_settings`, parsed. Every field is optional. */
export interface VoiceOverride {
  stability?: number;
  similarityBoost?: number;
  /** Put in front of every line the voice speaks, e.g. "[strong Japanese accent]". */
  linePrefix?: string;
}

/** Keys `parseVoiceOverride` reads. */
const READ_KEYS = ["stability", "similarity_boost", "line_prefix"];
/**
 * ElevenLabs settings another consumer of the `voices` table may store.
 * They are accepted and not sent; the #213 probe found eleven_v4 ignores
 * `style` and `speed`.
 */
const IGNORED_KEYS = ["style", "speed", "use_speaker_boost"];

/**
 * Whether a line prefix is one audio tag, e.g. "[strong Japanese accent]". An
 * unclosed bracket would leave the reader with no highlighted words, and a
 * prefix with no brackets would be spoken aloud, and a blank or multi-line tag
 * is no tag at all.
 */
export function isAudioTag(prefix: string): boolean {
  return (
    !/[\r\n]/.test(prefix) && /^\[[^[\]]*[^[\]\s][^[\]]*\]$/.test(prefix.trim())
  );
}

/**
 * Parses a stored `voices.voice_settings` value. Null or `{}` is no override.
 * `stability`, `similarity_boost` and `line_prefix` are read; `style`, `speed`
 * and `use_speaker_boost` are accepted and not sent (eleven_v4 ignores `style`
 * and `speed`). Any other key throws naming it, so a misspelled `similarityBoost`
 * cannot render at the base in silence. A wrong type, a number outside 0 to 1,
 * or a `line_prefix` that is not one audio tag (`isAudioTag`) throws naming
 * the key: a silent fallback would spend credits on settings nobody chose.
 * `where` names the voice in the error.
 */
export function parseVoiceOverride(
  stored: unknown,
  where = "voice_settings",
): VoiceOverride {
  if (stored === null || stored === undefined) return {};
  if (typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(
      `${where} must be a JSON object, got ${JSON.stringify(stored)}`,
    );
  }
  const raw = stored as Record<string, unknown>;
  const out: VoiceOverride = {};

  for (const key of Object.keys(raw)) {
    if (!READ_KEYS.includes(key) && !IGNORED_KEYS.includes(key)) {
      throw new Error(
        `${where}.${key} is not a voice setting. Read: ${READ_KEYS.join(", ")}; ignored: ${IGNORED_KEYS.join(", ")}.`,
      );
    }
  }

  const unit = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(
        `${where}.${key} must be a number from 0 to 1, got ${JSON.stringify(v)}`,
      );
    }
    return v;
  };
  const stability = unit("stability");
  if (stability !== undefined) out.stability = stability;
  const similarityBoost = unit("similarity_boost");
  if (similarityBoost !== undefined) out.similarityBoost = similarityBoost;

  const prefix = raw.line_prefix;
  if (prefix !== undefined && prefix !== null) {
    if (typeof prefix !== "string" || !isAudioTag(prefix)) {
      throw new Error(
        `${where}.line_prefix must be one audio tag like "[strong Japanese accent]", got ${JSON.stringify(prefix)}`,
      );
    }
    out.linePrefix = prefix.trim();
  }
  return out;
}
