/**
 * One `llm_calls` row per paid provider request (#93). Every pipeline Gemini
 * `generateContent`/`embedContent` call and every ElevenLabs TTS and Voice
 * Design request goes through a wrapper here. A failed call writes a row with
 * `ok=false` and the error still reaches the caller. Recording never breaks a
 * call: an insert error is logged with `console.warn` and swallowed. Under
 * DRY_RUN the call runs and no row is written, since nothing was paid for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GoogleGenAI,
} from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDryRun } from "./fakes/dry-run";
import {
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
  /** Gemini: "standard" unless the request says otherwise (#104). */
  serviceTier?: string | null;
};

/** One `llm_calls` row. `src/types/database.ts` does not know the table yet. */
export type LlmCallRow = {
  provider: "gemini" | "elevenlabs";
  step: string;
  model: string | null;
  service_tier: string | null;
  book_id: string | null;
  issue_id: string | null;
  page_number: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_thinking: number | null;
  characters: number | null;
  usd_est: number | null;
  duration_ms: number | null;
  ok: boolean;
  error: string | null;
};

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

function baseRow(
  provider: LlmCallRow["provider"],
  model: string | null,
  meta: LlmCallMeta,
): LlmCallRow {
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
): LlmCallRow {
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
    row.usd_est = round5(
      (tokensIn * rate.input + (tokensOut + tokensThinking) * rate.output) /
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

async function insertRow(row: LlmCallRow): Promise<void> {
  if (!client) {
    const { createStepClient } = await import("~/workflows/step-utils");
    client = await createStepClient();
  }
  const { error } = await client.from("llm_calls").insert(row);
  if (error) throw new Error(error.message);
}

async function record(row: LlmCallRow): Promise<void> {
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
  toRow: (result: T | undefined) => LlmCallRow,
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
    await record(row);
    throw err;
  }
  const row = toRow(result);
  row.duration_ms = Date.now() - started;
  if (result instanceof Response && !result.ok) {
    row.ok = false;
    row.error = `HTTP ${result.status}`;
    row.usd_est = null;
  }
  await record(row);
  return result;
}

type GenerateClient = {
  models: Pick<GoogleGenAI["models"], "generateContent">;
};
type EmbedClient = { models: Pick<GoogleGenAI["models"], "embedContent"> };

export function generateContentLogged(
  gemini: GenerateClient,
  params: GenerateContentParameters,
  meta: LlmCallMeta,
): Promise<GenerateContentResponse> {
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
 * One ElevenLabs request. `characters` is what the request bills on (the TTS
 * text), or null when the per-request charge is not known (Voice Design).
 */
export function recordElevenLabsCall<T>(
  meta: LlmCallMeta,
  characters: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  return logged(fn, () => {
    const row = baseRow("elevenlabs", meta.model ?? null, meta);
    row.characters = characters;
    if (characters !== null) {
      row.usd_est = round5(characters * ELEVENLABS_USD_PER_CHARACTER);
    }
    return row;
  });
}
