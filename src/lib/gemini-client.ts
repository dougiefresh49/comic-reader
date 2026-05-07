import { GoogleGenAI } from "@google/genai";

let primaryClient: GoogleGenAI | null = null;
let fallbackClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!primaryClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    primaryClient = new GoogleGenAI({ apiKey });
  }
  return primaryClient;
}

export function getFallbackGeminiClient(): GoogleGenAI | null {
  if (!fallbackClient) {
    const apiKey = process.env.GEMINI_API_KEY_2;
    if (!apiKey) return null;
    fallbackClient = new GoogleGenAI({ apiKey });
  }
  return fallbackClient;
}

export async function withGeminiFallback<T>(
  fn: (client: GoogleGenAI) => Promise<T>,
): Promise<T> {
  try {
    return await fn(getGeminiClient());
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status: number }).status
        : 0;
    if (status === 429) {
      const fallback = getFallbackGeminiClient();
      if (fallback) return await fn(fallback);
    }
    throw err;
  }
}
