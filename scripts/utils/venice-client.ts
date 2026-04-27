import { env } from "~/env.mjs";

const VENICE_BASE = "https://api.venice.ai/api/v1";

export interface VeniceModel {
  id: string;
  type: string;
  object: string;
  owned_by: string;
}

interface ImageGenerateRequest {
  model: string;
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  format?: "png" | "jpeg" | "webp";
  hide_watermark?: boolean;
}

interface ImageGenerateResponse {
  images: string[];
}

interface RateLimitsResponse {
  data: {
    balances: {
      USD: number;
    };
  };
}

interface ModelsResponse {
  data: VeniceModel[];
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.VENICE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function generateImage(params: {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  format?: "png" | "jpeg" | "webp";
  hideWatermark?: boolean;
}): Promise<{ buffer: Buffer; balanceUsd: number | null }> {
  const body: ImageGenerateRequest = {
    model: params.model,
    prompt: params.prompt,
    format: params.format ?? "png",
    hide_watermark: params.hideWatermark ?? true,
  };

  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;

  const res = await fetch(`${VENICE_BASE}/image/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Venice /image/generate failed (${res.status}): ${text}`);
  }

  const balanceHeader = res.headers.get("X-Balance-Remaining");
  const balanceUsd = balanceHeader ? parseFloat(balanceHeader) : null;

  const data = (await res.json()) as ImageGenerateResponse;
  const b64 = data.images[0];
  if (!b64) throw new Error("Venice returned no images");

  return { buffer: Buffer.from(b64, "base64"), balanceUsd };
}

export async function getBalance(): Promise<number> {
  const res = await fetch(`${VENICE_BASE}/api_keys/rate_limits`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Venice /api_keys/rate_limits failed (${res.status}): ${text}`,
    );
  }

  const data = (await res.json()) as RateLimitsResponse;
  return data.data.balances.USD;
}

export async function listModels(
  type?: "image" | "video" | "text",
): Promise<VeniceModel[]> {
  const url = new URL(`${VENICE_BASE}/models`);
  if (type) url.searchParams.set("type", type);

  const res = await fetch(url.toString(), { headers: authHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Venice /models failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ModelsResponse;
  return data.data;
}
