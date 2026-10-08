/**
 * One `llm_calls` row per paid provider request (#93). Every pipeline Gemini
 * `generateContent`/`embedContent` call and every ElevenLabs TTS and Voice
 * Design request goes through a wrapper here. A failed call writes a row with
 * `ok=false` and the error still reaches the caller. Recording never breaks a
 * call: an insert error is logged with `console.warn` and swallowed. Under
 * DRY_RUN the call runs and no row is written, since nothing was paid for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type GoogleGenAI,
  ServiceTier,
} from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TablesInsert } from "~/types/database";
import { isDryRun } from "./fakes/dry-run";
import {
  ELEVENLABS_CREDITS_PER_CHARACTER,
  ELEVENLABS_USD_PER_CHARACTER,
  GEMINI_EMBEDDING_USD_PER_IMAGE,
  GEMINI_USD_PER_1M_TOKENS,
} from "./models";

/** Where a call came from. `step` is the pipeline step or review action. */
export type LlmCallMeta = {
  step: string;
  bookId?: string | null;
  issueId?: string | null;
  pageNumber?: number | null;
  /** ElevenLabs only; a Gemini row takes the model from the request. */
  model?: string | null;
  /**
   * Gemini: "standard" unless the request says otherwise. `"flex"` on
   * `generateContentLogged` asks for the Flex tier with backoff (#104).
   */
  serviceTier?: "standard" | "flex" | null;
};

/**
 * The insert payload for one `llm_calls` row. `id` and `created_at` are defaults.
 */
type LlmCallInsert = TablesInsert<"llm_calls">;

const ambient = new AsyncLocalStorage<LlmCallMeta>();

/**
 * Runs `fn` with `meta` as the ambient call meta, for library code that makes
 * a paid call without knowing the book or issue (embeddings via the exemplar
 * store, face identification).
 */
export function withLlmMeta<T>(meta: LlmCallMeta, fn: () => Promise<T>) {
  return ambient.run(meta, fn);
}

/** The ambient meta from `withLlmMeta`, else `{ step: fallbackStep }`. */
export function ambientLlmMeta(fallbackStep: string): LlmCallMeta {
  return ambient.getStore() ?? { step: fallbackStep };
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Flex bills half the standard rate for every model in the map (#104). */
export const GEMINI_FLEX_PRICE_MULTIPLIER = 0.5;

/** Flex retry policy (#104): full-jitter backoff, retries on 429, 503, timeout. */
const FLEX_MAX_ATTEMPTS = 4;
const FLEX_BACKOFF_BASE_MS = 1_000;
const FLEX_BACKOFF_CAP_MS = 30_000;
/** Client timeout per Flex attempt; Flex's latency target is 1 to 15 min. */
const FLEX_ATTEMPT_TIMEOUT_MS = 240_000;
/**
 * Total Flex time per call, after which the one standard attempt starts.
 * Workflow steps deploy with `maxDuration: 'max'` (`@workflow/next`
 * builder, `.well-known/workflow/v1/config.json` `steps.maxDuration`),
 * which is 300 s on the Vercel Hobby plan (decisions row 195). 180 s of
 * Flex leaves 120 s for the standard attempt (the slowest standard sort call
 * in `llm_calls` took 52.5 s) and the rest of the step. Under `pnpm dev` a
 * step has no limit, and the deadline still holds.
 */
export const FLEX_DEADLINE_MS = 180_000;
/** A Flex attempt shorter than this is not worth starting. */
const FLEX_MIN_ATTEMPT_MS = 30_000;

function baseRow(
  provider: "gemini" | "elevenlabs",
  model: string | null,
  meta: LlmCallMeta,
): LlmCallInsert {
  return {
    provider,
    step: meta.step,
    model,
    service_tier:
      provider === "gemini" ? (meta.serviceTier ?? "standard") : null,
    book_id: meta.bookId ?? null,
    issue_id: meta.issueId ?? null,
    page_number: meta.pageNumber ?? null,
    tokens_in: null,
    tokens_out: null,
    tokens_thinking: null,
    characters: null,
    usd_est: null,
    credits: null,
    duration_ms: null,
    ok: true,
    error: null,
  };
}

/** Pure: a Gemini row from `response.usageMetadata`. Thinking bills as output. */
export function usageToRow(
  usage: GenerateContentResponseUsageMetadata | undefined,
  model: string,
  meta: LlmCallMeta,
): LlmCallInsert {
  const row = baseRow("gemini", model, meta);
  if (!usage) return row;
  const tokensIn = usage.promptTokenCount ?? 0;
  const tokensOut = usage.candidatesTokenCount ?? 0;
  const tokensThinking = usage.thoughtsTokenCount ?? 0;
  row.tokens_in = tokensIn;
  row.tokens_out = tokensOut;
  row.tokens_thinking = tokensThinking;
  const rate = GEMINI_USD_PER_1M_TOKENS[model];
  if (rate) {
    const tier = row.service_tier === "flex" ? GEMINI_FLEX_PRICE_MULTIPLIER : 1;
    row.usd_est = round5(
      (tier *
        (tokensIn * rate.input + (tokensOut + tokensThinking) * rate.output)) /
        1e6,
    );
  }
  return row;
}

function errorText(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  const text = typeof status === "number" ? `${status} ${message}` : message;
  return text.slice(0, 500);
}

let client: SupabaseClient | undefined;

/** A stalled insert must not hold a step after the paid call returned. */
const INSERT_TIMEOUT_MS = 5000;

async function insertRow(row: LlmCallInsert): Promise<void> {
  if (!client) {
    const { createStepClient } = await import("~/workflows/step-utils");
    client = await createStepClient();
  }
  const { error } = await client
    .from("llm_calls")
    .insert(row)
    .abortSignal(AbortSignal.timeout(INSERT_TIMEOUT_MS));
  if (error) throw new Error(error.message);
}

async function record(row: LlmCallInsert): Promise<void> {
  try {
    await insertRow(row);
  } catch (err) {
    console.warn(
      `[llm_calls] insert failed for ${row.step} ${row.model ?? ""}: ${errorText(err)}`,
    );
  }
}

/**
 * Times `call`, writes one row (`ok=false` and the error when it throws, or
 * when it resolves to a non-2xx `Response`), then returns or rethrows.
 */
async function logged<T>(
  call: () => Promise<T>,
  toRow: (result: T | undefined) => LlmCallInsert,
): Promise<T> {
  if (isDryRun()) return call();
  const started = Date.now();
  let result: T;
  try {
    result = await call();
  } catch (err) {
    const row = toRow(undefined);
    row.duration_ms = Date.now() - started;
    row.ok = false;
    row.error = errorText(err);
    row.usd_est = null;
    // A failed call's charge is unknown.
    row.credits = null;
    await record(row);
    throw err;
  }
  const row = toRow(result);
  row.duration_ms = Date.now() - started;
  if (result instanceof Response && !result.ok) {
    row.ok = false;
    row.error = `HTTP ${result.status}`;
    // A rejected request has no usable charge recorded here.
    row.usd_est = null;
    row.credits = null;
  }
  await record(row);
  return result;
}

type GenerateClient = {
  models: Pick<GoogleGenAI["models"], "generateContent">;
};
type EmbedClient = { models: Pick<GoogleGenAI["models"], "embedContent"> };

/**
 * Pure: milliseconds from a `Retry-After` value (delay seconds or an HTTP
 * date), or null when it is missing or unreadable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** What failed on one Flex attempt. `status` is the SDK `ApiError` status. */
export type FlexFailure = {
  status?: number;
  timedOut?: boolean;
  retryAfter?: string | null;
};

/**
 * Pure: what follows failed Flex attempt `attempt` (1-based). A number is
 * the wait in ms before the next Flex attempt; "standard" ends Flex and makes
 * the one standard attempt; "throw" rethrows. Only 429, 503 and a client
 * timeout retry. The wait is full jitter on base 1 s, cap 30 s, or the
 * `Retry-After` delay when there is one. Flex ends after 4 attempts, or when
 * the wait would leave less than 30 s before the Flex deadline.
 */
export function flexRetryWait(
  failure: FlexFailure,
  attempt: number,
  remainingMs: number,
  random: () => number = Math.random,
  now = Date.now(),
): number | "standard" | "throw" {
  const retryable =
    failure.timedOut === true ||
    failure.status === 429 ||
    failure.status === 503;
  if (!retryable) return "throw";
  if (attempt >= FLEX_MAX_ATTEMPTS) return "standard";
  const backoff =
    random() *
    Math.min(FLEX_BACKOFF_CAP_MS, FLEX_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const wait = Math.round(parseRetryAfter(failure.retryAfter, now) ?? backoff);
  return remainingMs - wait < FLEX_MIN_ATTEMPT_MS ? "standard" : wait;
}

/**
 * The SDK's `ApiError` carries `status` and the error body as its message,
 * not the response headers, so `Retry-After` is out of reach. A Gemini 429
 * body may carry `google.rpc.RetryInfo` with `retryDelay: "17s"`; that delay
 * stands in for it, in seconds.
 */
function flexFailure(err: unknown): FlexFailure {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : "";
  return {
    status: typeof status === "number" ? status : undefined,
    // The SDK aborts the fetch at `httpOptions.timeout`, and nothing else here
    // aborts it.
    timedOut: err instanceof Error && err.name === "AbortError",
    retryAfter: /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1],
  };
}

/**
 * Flex attempts with backoff, then one standard attempt. Each attempt is a
 * paid request with its own row. The SDK retries only when the client was
 * built with `httpOptions.retryOptions` (`ApiClient.apiCall`), which ours
 * are not, so nothing stacks on this loop.
 */
async function generateFlex(
  gemini: GenerateClient,
  params: GenerateContentParameters,
  meta: LlmCallMeta,
): Promise<GenerateContentResponse> {
  const flexMeta: LlmCallMeta = { ...meta, serviceTier: "flex" };
  const deadline = Date.now() + FLEX_DEADLINE_MS;
  for (let attempt = 1; ; attempt++) {
    const timeout = Math.min(FLEX_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
    const flexParams: GenerateContentParameters = {
      ...params,
      config: {
        ...params.config,
        serviceTier: ServiceTier.SERVICE_TIER_FLEX,
        httpOptions: { ...params.config?.httpOptions, timeout },
      },
    };
    try {
      return await logged(
        () => gemini.models.generateContent(flexParams),
        (res) => usageToRow(res?.usageMetadata, params.model, flexMeta),
      );
    } catch (err) {
      const next = flexRetryWait(
        flexFailure(err),
        attempt,
        deadline - Date.now(),
      );
      if (next === "throw") throw err;
      console.warn(
        `[gemini] ${meta.step} Flex attempt ${attempt} failed (${errorText(err).slice(0, 120)}); ` +
          (next === "standard"
            ? "one standard attempt"
            : `retry in ${next} ms`),
      );
      if (next === "standard") break;
      await new Promise((r) => setTimeout(r, next));
    }
  }
  const standardMeta: LlmCallMeta = { ...meta, serviceTier: "standard" };
  return logged(
    () => gemini.models.generateContent(params),
    (res) => usageToRow(res?.usageMetadata, params.model, standardMeta),
  );
}

/**
 * One logged `generateContent`. `meta.serviceTier: "flex"` asks for Flex with
 * backoff and a standard fallback (`generateFlex`); anything else is one
 * standard request.
 */
export function generateContentLogged(
  gemini: GenerateClient,
  params: GenerateContentParameters,
  meta: LlmCallMeta,
): Promise<GenerateContentResponse> {
  if (meta.serviceTier === "flex") return generateFlex(gemini, params, meta);
  return logged(
    () => gemini.models.generateContent(params),
    (res) => usageToRow(res?.usageMetadata, params.model, meta),
  );
}

/** Image parts in an embed request; each bills at the per-image rate. */
function countImages(contents: EmbedContentParameters["contents"]): number {
  const items = Array.isArray(contents) ? contents : [contents];
  let images = 0;
  for (const item of items) {
    if (typeof item === "string") continue;
    const parts = "parts" in item && item.parts ? item.parts : [item];
    for (const part of parts) {
      if ("inlineData" in part && part.inlineData) images++;
    }
  }
  return images;
}

export function embedContentLogged(
  gemini: EmbedClient,
  params: EmbedContentParameters,
  meta: LlmCallMeta,
): Promise<EmbedContentResponse> {
  return logged(
    () => gemini.models.embedContent(params),
    () => {
      const row = baseRow("gemini", params.model, meta);
      const images = countImages(params.contents);
      // Text embeddings have no rate yet, so their usd_est stays null.
      if (images > 0)
        row.usd_est = round5(images * GEMINI_EMBEDDING_USD_PER_IMAGE);
      return row;
    },
  );
}

/**
 * Prefer the documented `character-cost` header (#251):
 * https://elevenlabs.io/docs/api-reference/introduction
 * Missing or invalid headers fall back to the model's character rate.
 */
function creditsFor(
  headers: Headers | undefined,
  characters: number | null,
  model: string | null,
): number | null {
  const header = headers?.get("character-cost");
  if (header?.trim()) {
    const parsed = Number(header);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (characters === null) return null;
  const rate = model ? ELEVENLABS_CREDITS_PER_CHARACTER[model] : undefined;
  return rate ? round5(characters * rate) : null;
}

/** Pure: an ElevenLabs row from the result and the billed character count. */
export function elevenLabsUsageToRow<T>(
  result: T | undefined,
  characters: number | null,
  meta: LlmCallMeta,
  headers = result instanceof Response ? result.headers : undefined,
): LlmCallInsert {
  const row = baseRow("elevenlabs", meta.model ?? null, meta);
  row.characters = characters;
  row.credits = creditsFor(headers, characters, meta.model ?? null);
  const billedCharacters = row.credits ?? characters;
  if (billedCharacters !== null) {
    row.usd_est = round5(billedCharacters * ELEVENLABS_USD_PER_CHARACTER);
  }
  return row;
}

/**
 * One ElevenLabs request. Keep the parsed SDK result for audio callers, and
 * use `.withRawResponse()` before awaiting so its charge header survives.
 * Voice Design bills returned preview text once, not once per preview.
 */
export function recordElevenLabsCall<T>(
  meta: LlmCallMeta,
  characters: number | null,
  fn: () => Promise<T> & {
    withRawResponse?: () => Promise<{
      data: T;
      rawResponse: { headers: Headers };
    }>;
  },
): Promise<T> {
  let responseHeaders: Headers | undefined;
  let billedCharacters = characters;
  return logged(
    async () => {
      const request = fn();
      let result: T;
      if (request.withRawResponse) {
        const raw = await request.withRawResponse();
        responseHeaders = raw.rawResponse.headers;
        result = raw.data;
      } else {
        result = await request;
      }
      if (
        result instanceof Response &&
        result.ok &&
        meta.model === "eleven_ttv_v3"
      ) {
        // Clone so the existing caller can still consume the response body.
        try {
          const data = (await result.clone().json()) as { text?: unknown };
          if (typeof data.text === "string")
            billedCharacters = data.text.length;
        } catch {
          // No usable preview text: the header still applies, else credits stay unknown.
        }
      }
      return result;
    },
    (result) =>
      elevenLabsUsageToRow(
        result,
        billedCharacters,
        meta,
        responseHeaders ??
          (result instanceof Response ? result.headers : undefined),
      ),
  );
}
