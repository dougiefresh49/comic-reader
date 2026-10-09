import { getSlotStatus } from "~/lib/voice-slots/elevenlabs";
import { readVoices } from "~/lib/voice-slots/registry";
import {
  isProtectedVoice,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots/types";
import { ROOM_CONSUMER } from "~/lib/voice-slots/archive";
import {
  OTHER_PROJECT,
  holdsSlot,
  isRepoVoice,
  readAccountOwners,
  readAccountVoices,
  type AccountVoice,
  type AccountVoiceOwner,
} from "./account";
import { blank, labelsMissing } from "./labels";
import type { Roster, RosterSlot, SlotHolder, SlotLock } from "./types";

/** Why a voice cannot be moved out of its slot, the hard refusals first. */
export function slotLock(
  row: VoiceRow | null,
  owner: AccountVoiceOwner | undefined,
): SlotLock {
  if (row && isProtectedVoice(row)) return "protected";
  if (owner?.pinned) return "pinned";
  if (row?.consumers.includes(ROOM_CONSUMER)) return "room";
  if (row?.keep_active) return "keep_active";
  return "movable";
}

/** The cheap read of what an archive could keep: no bucket download. */
function backupState(
  row: VoiceRow | null,
  account: AccountVoice,
): RosterSlot["backup"] {
  const description = row ? row.description : account.description;
  if (blank(description)) return "lossy";
  if (
    row?.source_clip_path &&
    row.source_clip_md5 &&
    !labelsMissing(row.labels)
  )
    return "ready";
  return "at confirm";
}

/**
 * The account's voice slots (#786): this repo's active voices, every other
 * voice on the account (the free `GET /v1/voices`), `account_voice_owners`
 * for the other projects' names and pins, and the free count from the free
 * `GET /v1/user/subscription`. Reads only. Each slot says who holds it and
 * whether it can move.
 *
 * A voice that holds no slot (a professional voice, which counts against
 * its own allowance) is listed under `unslotted`, not as a slot, so the
 * slots total the account's limit: holders plus free.
 */
export async function accountRoster(deps: VoiceSlotsDeps): Promise<Roster> {
  const [status, account, voices, owners] = await Promise.all([
    getSlotStatus(deps),
    readAccountVoices(deps),
    readVoices(deps.supabase),
    readAccountOwners(deps.supabase),
  ]);
  const byElevenLabsId = new Map<string, VoiceRow>();
  for (const v of voices)
    if (v.status === "active" && v.current_elevenlabs_id)
      byElevenLabsId.set(v.current_elevenlabs_id, v);

  const held: {
    holder: SlotHolder;
    lock: SlotLock;
    backup: RosterSlot["backup"];
  }[] = [];
  const unslotted: Roster["unslotted"] = [];
  for (const a of account) {
    const row = byElevenLabsId.get(a.voice_id) ?? null;
    const owner = owners.get(a.voice_id);
    const ownerName = owner?.project_name ?? OTHER_PROJECT;
    if (!holdsSlot(a)) {
      unslotted.push({
        elevenLabsId: a.voice_id,
        name: row?.display_name ?? a.name,
        category: a.category,
        owner: row && isRepoVoice(row.consumers) ? "comic-reader" : ownerName,
      });
      continue;
    }
    const holder: SlotHolder =
      row && isRepoVoice(row.consumers)
        ? {
            kind: "repo",
            voiceUuid: row.id,
            name: row.display_name,
            characterId: row.character_id,
            elevenLabsId: a.voice_id,
          }
        : {
            kind: "outside",
            elevenLabsId: a.voice_id,
            name: row?.display_name ?? a.name,
            owner: ownerName,
            voiceUuid: row?.id ?? null,
          };
    const lock = slotLock(row, owner);
    held.push({
      holder,
      lock,
      backup: lock === "movable" ? backupState(row, a) : null,
    });
  }
  held.sort((x, y) => {
    if (x.holder.kind !== y.holder.kind)
      return x.holder.kind === "repo" ? -1 : 1;
    const ox = x.holder.kind === "outside" ? x.holder.owner : "";
    const oy = y.holder.kind === "outside" ? y.holder.owner : "";
    if (ox !== oy) return ox.localeCompare(oy);
    const nx = x.holder.kind === "free" ? "" : x.holder.name;
    const ny = y.holder.kind === "free" ? "" : y.holder.name;
    return nx.localeCompare(ny);
  });

  const free = Math.max(0, status.voice_limit - status.voice_slots_used);
  const slots: RosterSlot[] = [
    ...held,
    ...Array.from({ length: free }, () => ({
      holder: { kind: "free" } as const,
      lock: "free" as const,
      backup: null,
    })),
  ].map((s, i) => ({ index: i + 1, ...s }));

  const warnings: string[] = [];
  if (held.length !== status.voice_slots_used)
    warnings.push(
      `the account lists ${held.length} voice(s) in slots, and the subscription says ${status.voice_slots_used} used`,
    );
  const onAccount = new Set(account.map((a) => a.voice_id));
  for (const v of byElevenLabsId.values())
    if (!onAccount.has(v.current_elevenlabs_id!))
      warnings.push(
        `${v.display_name} is active here, but ${v.current_elevenlabs_id} is not on the account`,
      );

  return {
    limit: status.voice_limit,
    used: status.voice_slots_used,
    free,
    slots,
    unslotted,
    warnings,
  };
}
