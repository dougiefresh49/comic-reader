/**
 * The one module that touches ElevenLabs voice slots (#96, decisions rows
 * 23 to 25): every DELETE and every `/v1/voices/add` goes through here, from
 * the `voice-rotation` CLI today and from Vercel server actions (#102, #108)
 * next. Restore reads the hash-checked copy in `comic-voice-clips` and
 * nothing local. No ElevenLabs request is retried.
 *
 * Every function takes `VoiceSlotsDeps` first: the Supabase client to use
 * and, for a scratch run, a fake `fetch`.
 */
export { archiveRefusals, archiveVoice, ROOM_CONSUMER } from "./archive";
export type { ArchiveGuardOptions, ArchiveOptions } from "./archive";
export { noActiveVoiceClaimFilter, withVoiceOperationClaim } from "./claim";
export type { VoiceClaimOperation } from "./claim";
export { designVoice } from "./design";
export type { DesignVoiceInput } from "./design";
export {
  VOICE_CLIPS_BUCKET,
  clipObjectPath,
  manifestObjectPath,
  readManifest,
} from "./bucket";
export {
  ElevenLabsHeadroomError,
  ElevenLabsRefusedError,
  ElevenLabsTimeoutError,
  buildAddVoiceForm,
  describeForm,
  describeHeadroom,
  findUnknownVoicesNamed,
  getSlotStatus as slotStatus,
  headroomRefusals,
  md5Hex,
  metadataRefusals,
  requireHeadroom,
} from "./elevenlabs";
export type {
  ElevenLabsSample,
  ElevenLabsVoice,
  HeadroomRefusal,
  MetadataRefusal,
} from "./elevenlabs";
export { orderCandidates, planFreeSlots } from "./plan";
export type { PlanFreeSlotsOptions } from "./plan";
export {
  booksUsingVoice,
  issueNeeds,
  markRestored,
  readCastlist,
  readVoice,
  readVoices,
  registerVoice,
} from "./registry";
export type { RegisterVoiceInput } from "./registry";
export { createVoiceFromSamples, restoreVoice } from "./restore";
export { snapshotSample } from "./snapshot";
export type * from "./types";
