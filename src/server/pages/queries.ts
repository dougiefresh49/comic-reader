import "server-only";
import { readFile } from "fs/promises";
import { join } from "path";
import type { Bubble, AudioTimestamps } from "~/types";

export interface PageData {
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
}

/**
 * Fetches page data including bubbles and audio timestamps for a given comic page
 */
export async function getPageData(
  bookId: string,
  issueId: string,
  pageNumber: string,
): Promise<PageData> {
  // Format page number with leading zero (e.g., "01", "02")
  const formattedPageNum = String(parseInt(pageNumber, 10)).padStart(2, "0");
  const pageKey = `page-${formattedPageNum}.jpg`;

  try {
    // Read context cache from public directory
    const cachePath = join(
      process.cwd(),
      "public",
      "comics",
      bookId,
      issueId,
      "bubbles.json",
    );
    const cacheData = await readFile(cachePath, "utf-8");
    const cache = JSON.parse(cacheData) as Record<string, unknown[]>;

    // Read timestamps
    const timestampsPath = join(
      process.cwd(),
      "public",
      "comics",
      bookId,
      issueId,
      "audio-timestamps.json",
    );
    let timestamps: Record<string, AudioTimestamps> = {};
    try {
      const timestampsData = await readFile(timestampsPath, "utf-8");
      timestamps = JSON.parse(timestampsData) as Record<string, AudioTimestamps>;
    } catch {
      // Timestamps file might not exist, that's okay
    }

    const bubbles = (cache[pageKey] ?? []) as Bubble[];

    return { bubbles, timestamps };
  } catch (error) {
    console.error("Error fetching page data:", error);
    return { bubbles: [], timestamps: {} };
  }
}

