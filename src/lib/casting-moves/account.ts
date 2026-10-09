import type { SupabaseClient } from "@supabase/supabase-js";
import { el, failure } from "~/lib/voice-slots/elevenlabs";
import type { VoiceSlotsDeps } from "~/lib/voice-slots/types";

/** A voice on the ElevenLabs account, from the free `GET /v1/voices`. */
export interface AccountVoice {
  voice_id: string;
  name: string;
  /** `cloned`, `generated`, `professional`, `premade`, ... */
  category: string;
  description: string | null;
  labels: Record<string, string> | null;
}

/** Categories that take one of the account's voice slots. Professional voices count against their own allowance; premade ones against none. */
const SLOT_CATEGORIES: ReadonlySet<string> = new Set(["cloned", "generated"]);

export const holdsSlot = (v: AccountVoice) => SLOT_CATEGORIES.has(v.category);

/** Every non-premade voice on the account. One free GET. */
export async function readAccountVoices(
  deps: VoiceSlotsDeps,
): Promise<AccountVoice[]> {
  const r = await el(deps, "/v1/voices");
  if (!r.ok) throw await failure(r, "GET /v1/voices");
  const body = (await r.json()) as { voices?: Partial<AccountVoice>[] };
  return (body.voices ?? []).flatMap((v) =>
    v.voice_id && v.category !== "premade"
      ? [
          {
            voice_id: v.voice_id,
            name: v.name ?? "",
            category: v.category ?? "",
            description: v.description ?? null,
            labels: v.labels && typeof v.labels === "object" ? v.labels : null,
          },
        ]
      : [],
  );
}

export interface AccountVoiceOwner {
  project_name: string;
  pinned: boolean;
}

/** `account_voice_owners` by ElevenLabs id. */
export async function readAccountOwners(
  supabase: SupabaseClient,
): Promise<Map<string, AccountVoiceOwner>> {
  const { data, error } = await supabase
    .from("account_voice_owners")
    .select("elevenlabs_id, project_name, pinned");
  if (error)
    throw new Error(
      `casting moves: reading account_voice_owners: ${error.message}`,
    );
  return new Map(
    (
      (data ?? []) as {
        elevenlabs_id: string;
        project_name: string;
        pinned: boolean;
      }[]
    ).map((o) => [
      o.elevenlabs_id,
      { project_name: o.project_name, pinned: o.pinned },
    ]),
  );
}

export const OTHER_PROJECT = "Other project";

/** A `voices` row this repo uses: the comic reader or the room app. A row with neither is another project's voice registered here by an archive. */
export const isRepoVoice = (consumers: string[]) =>
  consumers.includes("comic") || consumers.includes("room");
