import { GoogleGenAI, createPartFromBase64 } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 768;

let primaryClient: GoogleGenAI | null = null;
let fallbackClient: GoogleGenAI | null = null;

function getPrimaryClient(): GoogleGenAI {
  if (!primaryClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    primaryClient = new GoogleGenAI({ apiKey });
  }
  return primaryClient;
}

function getFallbackClient(): GoogleGenAI | null {
  if (!fallbackClient) {
    const apiKey = process.env.GEMINI_API_KEY_2;
    if (!apiKey) return null;
    fallbackClient = new GoogleGenAI({ apiKey });
  }
  return fallbackClient;
}

async function embedWithRetry(
  fn: (client: GoogleGenAI) => Promise<number[]>,
): Promise<number[]> {
  try {
    return await fn(getPrimaryClient());
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status: number }).status
        : 0;
    if (status === 429) {
      const fallback = getFallbackClient();
      if (fallback) return await fn(fallback);
    }
    throw err;
  }
}

export async function embedImage(
  imageBase64: string,
  mimeType = "image/jpeg",
): Promise<number[]> {
  return embedWithRetry(async (client) => {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: [createPartFromBase64(imageBase64, mimeType)],
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    return result.embeddings?.[0]?.values ?? [];
  });
}

export async function embedText(text: string): Promise<number[]> {
  if (!text.trim()) return new Array(EMBEDDING_DIMENSIONS).fill(0) as number[];
  return embedWithRetry(async (client) => {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    return result.embeddings?.[0]?.values ?? [];
  });
}
