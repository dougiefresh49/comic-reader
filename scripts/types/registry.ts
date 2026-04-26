export interface VoiceEntry {
  voiceId: string;
  voiceType: "ivc" | "voice_design";
  status: "needs_clips" | "needs_model" | "ready";
  createdAt: string;
  voiceDescription?: string | null;
}

export type MediaType =
  | "animated_series"
  | "movie"
  | "video_game"
  | "live_action"
  | "voice_design";

export interface AppearanceEntry {
  id: string;
  mediaTitle: string | null;
  year: number | null;
  voiceActor: string | null;
  mediaType: MediaType;
  youtubeSearchTerms: string[];
  notes: string | null;
  voice: VoiceEntry | null;
}

export interface CharacterRegistryEntry {
  franchise: string;
  aliases: string[];
  appearances: AppearanceEntry[];
}

export type CharacterRegistry = Record<string, CharacterRegistryEntry>;

export interface CastSelection {
  appearanceId: string;
  voiceId: string;
}

export type CastSelections = Record<string, CastSelection>;
