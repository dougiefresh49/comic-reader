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

/**
 * Parses a stored `voices.voice_settings` value. Null or `{}` is no override;
 * unknown keys are ignored. A wrong type, a number outside 0 to 1, or a blank
 * `line_prefix` throws naming the key: a silent fallback would spend credits
 * on settings nobody chose. `where` names the voice in the error.
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
    if (typeof prefix !== "string" || !prefix.trim()) {
      throw new Error(
        `${where}.line_prefix must be a non-blank string, got ${JSON.stringify(prefix)}`,
      );
    }
    out.linePrefix = prefix.trim();
  }
  return out;
}

export const SKIPPED_VOICE = "__SKIPPED__";
