import { createHash } from "node:crypto";
import type { SlotStatus, VoiceSlotsDeps } from "./types";

const API_BASE = "https://api.elevenlabs.io";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ElevenLabsSample {
  sample_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  /** md5 of the uploaded bytes. */
  hash: string;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  description: string | null;
  labels: Record<string, string> | null;
  samples: ElevenLabsSample[];
}

export interface SampleFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * A request that hit the timeout. Never retried by the module: the DELETE
 * or add may have landed, so the caller checks ElevenLabs before rerunning.
 */
export class ElevenLabsTimeoutError extends Error {
  constructor(method: string, path: string, ms: number) {
    super(
      `${method} ${path} timed out after ${ms} ms; not retried, the request may have landed. Check ElevenLabs before running again.`,
    );
    this.name = "ElevenLabsTimeoutError";
  }
}

/**
 * ElevenLabs answered and said no (a non-2xx reply), or a request that never
 * creates a voice failed. Nothing was added, unlike a timeout or an
 * unreadable reply, after which the add may have landed.
 */
export class ElevenLabsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsRefusedError";
  }
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function apiKey(deps: VoiceSlotsDeps): string {
  const key = deps.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

/** One attempt, one timeout, the key header set. No retry on any path. */
export async function el(
  deps: VoiceSlotsDeps,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("xi-api-key", apiKey(deps));
  const doFetch = deps.fetch ?? globalThis.fetch;
  try {
    return await doFetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      throw new ElevenLabsTimeoutError(method, path, ms);
    throw err;
  }
}

export async function failure(r: Response, what: string): Promise<Error> {
  const text = await r.text().catch(() => "");
  return new Error(`${what} -> ${r.status}: ${text.slice(0, 200)}`);
}

export async function getSlotStatus(deps: VoiceSlotsDeps): Promise<SlotStatus> {
  const r = await el(deps, "/v1/user/subscription");
  if (!r.ok) throw await failure(r, "GET /v1/user/subscription");
  const body = (await r.json()) as Partial<SlotStatus>;
  const pick = (k: keyof SlotStatus): number => {
    const v = body[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      throw new Error(`GET /v1/user/subscription: no numeric ${k}`);
    return v;
  };
  return {
    voice_slots_used: pick("voice_slots_used"),
    voice_limit: pick("voice_limit"),
    voice_add_edit_counter: pick("voice_add_edit_counter"),
    max_voice_add_edits: pick("max_voice_add_edits"),
  };
}

/** The detail endpoint; the list endpoint leaves `samples` empty. */
export async function getVoice(
  deps: VoiceSlotsDeps,
  elevenLabsId: string,
): Promise<ElevenLabsVoice> {
  const r = await el(deps, `/v1/voices/${elevenLabsId}`);
  if (!r.ok) throw await failure(r, `GET /v1/voices/${elevenLabsId}`);
  const body = (await r.json()) as Partial<ElevenLabsVoice>;
  return {
    voice_id: body.voice_id ?? elevenLabsId,
    name: body.name ?? "",
    category: body.category ?? "",
    description: body.description ?? null,
    labels: body.labels ?? null,
    samples: body.samples ?? [],
  };
}

export async function downloadSample(
  deps: VoiceSlotsDeps,
  elevenLabsId: string,
  sampleId: string,
): Promise<Uint8Array> {
  const path = `/v1/voices/${elevenLabsId}/samples/${sampleId}/audio`;
  const r = await el(deps, path);
  if (!r.ok) throw await failure(r, `GET ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Returns `alreadyGone` on 404, which the archive treats as done. */
export async function deleteVoice(
  deps: VoiceSlotsDeps,
  elevenLabsId: string,
): Promise<{ alreadyGone: boolean }> {
  const r = await el(deps, `/v1/voices/${elevenLabsId}`, { method: "DELETE" });
  if (r.ok) return { alreadyGone: false };
  if (r.status === 404) return { alreadyGone: true };
  throw await failure(r, `DELETE /v1/voices/${elevenLabsId}`);
}

export interface AddVoiceInput {
  name: string;
  files: SampleFile[];
  description?: string | null;
  labels?: Record<string, string> | null;
}

export type MetadataRefusal = "no description" | "no labels";

/**
 * What a voice's row is missing for the add payload. Both fields go on
 * every clone, so a row with neither is refused before the request rather
 * than sent without them: a silent drop changes what the clone is for.
 */
export function metadataRefusals(meta: {
  description?: string | null;
  labels?: Record<string, string> | null;
}): MetadataRefusal[] {
  const out: MetadataRefusal[] = [];
  if (typeof meta.description !== "string" || !meta.description.trim())
    out.push("no description");
  if (
    !meta.labels ||
    Array.isArray(meta.labels) ||
    typeof meta.labels !== "object" ||
    Object.keys(meta.labels).length === 0 ||
    Object.entries(meta.labels).some(
      ([k, v]) => !k.trim() || typeof v !== "string" || !v.trim(),
    )
  )
    out.push("no labels");
  return out;
}

/**
 * The `/v1/voices/add` multipart body, voice-lab's standing shape: `name`,
 * `files`, `description`, `labels` as a JSON string, and
 * `remove_background_noise=false` (clones come from the raw reel). Both
 * metadata fields are always present, so the payload shape does not change
 * with the row.
 */
export function buildAddVoiceForm(input: AddVoiceInput): FormData {
  const form = new FormData();
  form.append("name", input.name);
  for (const f of input.files) {
    form.append(
      "files",
      new Blob([f.bytes as BlobPart], { type: f.mimeType }),
      f.filename,
    );
  }
  form.append("description", input.description ?? "");
  form.append("labels", JSON.stringify(input.labels ?? {}));
  form.append("remove_background_noise", "false");
  return form;
}

/** One line per field, so a dry run can show the payload it would send. */
export async function describeForm(form: FormData): Promise<string[]> {
  const lines: string[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      lines.push(`${name}=${JSON.stringify(value)}`);
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    lines.push(
      `${name}: file=${value.name} type=${value.type} bytes=${bytes.byteLength} md5=${md5Hex(bytes)}`,
    );
  }
  return lines;
}

export type HeadroomRefusal = "no free slot" | "no add/edit headroom";

/** Why the account cannot take `n` more adds, from `slotStatus()` numbers. */
export function headroomRefusals(
  status: SlotStatus,
  n: number,
): HeadroomRefusal[] {
  const out: HeadroomRefusal[] = [];
  if (status.voice_limit - status.voice_slots_used < n)
    out.push("no free slot");
  if (status.max_voice_add_edits - status.voice_add_edit_counter < n)
    out.push("no add/edit headroom");
  return out;
}

export function describeHeadroom(status: SlotStatus, n: number): string {
  return `${status.voice_limit - status.voice_slots_used} free slot(s) of ${status.voice_limit}, ${status.max_voice_add_edits - status.voice_add_edit_counter} add/edit(s) left of ${status.max_voice_add_edits}, ${n} add(s) planned`;
}

/** Thrown before a POST when the account cannot take the adds planned. */
export class ElevenLabsHeadroomError extends Error {
  constructor(
    public readonly refusals: HeadroomRefusal[],
    public readonly status: SlotStatus,
    public readonly planned: number,
  ) {
    super(
      `/v1/voices/add refused before sending: ${refusals.join(", ")} (${describeHeadroom(status, planned)})`,
    );
    this.name = "ElevenLabsHeadroomError";
  }
}

/**
 * Throws `ElevenLabsHeadroomError` unless the account can take `n` adds. A
 * batch calls this once with its whole size before it starts, so a batch
 * that cannot fit does not restore half its voices before it runs out.
 */
export async function requireHeadroom(
  deps: VoiceSlotsDeps,
  n: number,
): Promise<SlotStatus> {
  const status = await getSlotStatus(deps);
  const refused = headroomRefusals(status, n);
  if (refused.length > 0) throw new ElevenLabsHeadroomError(refused, status, n);
  return status;
}

/**
 * The one add path. Reads `slotStatus()` first and throws
 * `ElevenLabsHeadroomError` when there is no slot or no add/edit left, so
 * no caller can reach the POST without the check.
 */
export async function addVoice(
  deps: VoiceSlotsDeps,
  input: AddVoiceInput,
): Promise<{ voice_id: string }> {
  const refused = metadataRefusals(input);
  if (refused.length > 0)
    throw new Error(
      `/v1/voices/add refused before sending: ${refused.join(", ")}`,
    );
  await requireHeadroom(deps, 1);
  const r = await el(deps, "/v1/voices/add", {
    method: "POST",
    body: buildAddVoiceForm(input),
  });
  if (!r.ok)
    throw new ElevenLabsRefusedError(
      (await failure(r, "POST /v1/voices/add")).message,
    );
  const body = (await r.json()) as { voice_id?: string };
  if (!body.voice_id) throw new Error("POST /v1/voices/add: no voice_id");
  return { voice_id: body.voice_id };
}

/**
 * The account's voices named `name` whose id is not in `knownIds`: after an
 * add that timed out or whose reply could not be read, the voice it may have
 * made. One free GET; the caller decides what one, none or several mean.
 */
export async function findUnknownVoicesNamed(
  deps: VoiceSlotsDeps,
  name: string,
  knownIds: Set<string>,
): Promise<string[]> {
  const r = await el(deps, "/v1/voices");
  if (!r.ok) throw await failure(r, "GET /v1/voices");
  const body = (await r.json()) as {
    voices?: { voice_id?: string; name?: string }[];
  };
  return (body.voices ?? [])
    .filter((v) => v.name === name && v.voice_id && !knownIds.has(v.voice_id))
    .map((v) => v.voice_id!);
}
