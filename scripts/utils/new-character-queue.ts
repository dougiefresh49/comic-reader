/**
 * Shared logic for "review new characters" (browser UI + ingest --db).
 * Used by scripts/utils from ingest scripts and src/server/admin/new-characters.ts.
 */

import fs from "fs-extra";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";

export const NEW_CHARACTER_SPEECH_TYPES = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
] as const;

export interface NewCharacterReview {
  /** Representative raw speaker string from bubbles */
  originalName: string;
  /** Alias-resolved name, used as the grouping key */
  resolvedName: string;
  classification: "named" | "generic";
  pageNumbers: number[];
  bubbleCount: number;
  sampleText: string | null;
  status: "pending" | "kept_as_new" | "aliased";
  resolvedTo: string | null;
  /** All distinct raw `speaker` values that map to this resolved name */
  speakerVariants: string[];
  /** Why this row sits in the auto-resolved list */
  autoReason?: "registry" | "castlist" | "narrator" | "kept_as_new";
}

export interface NewCharacterQueueResult {
  autoResolved: NewCharacterReview[];
  queue: NewCharacterReview[];
  pendingCount: number;
}

type BubbleRow = {
  speaker: string | null;
  page_number: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  type: string;
  ignored: boolean | null;
};

function resolveAlias(raw: string, aliasMap: Map<string, string>): string {
  const key = raw.toLowerCase().trim();
  return aliasMap.get(key) ?? raw;
}

async function loadNamedMapFromNewCharactersJson(
  projectRoot: string,
  bookId: string,
  issueId: string,
): Promise<Map<string, boolean>> {
  const path = join(
    projectRoot,
    "assets",
    "comics",
    bookId,
    issueId,
    "new-characters.json",
  );
  const map = new Map<string, boolean>();
  if (!(await fs.pathExists(path))) return map;
  try {
    const data = (await fs.readJson(path)) as Record<
      string,
      string | { description: string; named?: boolean }
    >;
    for (const [name, entry] of Object.entries(data)) {
      const named = typeof entry === "string" ? true : entry.named !== false;
      map.set(name, named);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function matchesCharacterRow(
  resolvedName: string,
  rows: Array<{ id: string; aliases: string[] | null }>,
): boolean {
  const lower = resolvedName.toLowerCase().trim();
  const slug = slugify(resolvedName);
  for (const row of rows) {
    if (row.id === slug || row.id.toLowerCase() === lower) return true;
    for (const alias of row.aliases ?? []) {
      if (alias.toLowerCase().trim() === lower) return true;
    }
  }
  return false;
}

export async function analyzeNewCharacterQueue(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  options?: { projectRoot?: string },
): Promise<NewCharacterQueueResult> {
  const projectRoot = options?.projectRoot;

  const [
    { data: bubbleRows, error: bErr },
    { data: aliasRows, error: aliasErr },
    { data: caRows, error: caErr },
    { data: charRows, error: charErr },
  ] = await Promise.all([
    client
      .from("bubbles")
      .select("speaker, page_number, ocr_text, text_with_cues, type, ignored")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("type", [...NEW_CHARACTER_SPEECH_TYPES])
      .not("speaker", "is", null),
    client
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    client
      .from("character_appearances")
      .select("character_id, voice_status, voice_model_status"),
    client.from("characters").select("id, aliases"),
  ]);

  // A failed read must throw: an empty result reads as "nothing pending"
  // and would skip the new-characters gate.
  const fail = (table: string, message: string): never => {
    throw new Error(
      `analyzeNewCharacterQueue ${table} ${bookId}/${issueId}: ${message}`,
    );
  };
  if (bErr) fail("bubbles", bErr.message);
  if (aliasErr) fail("aliases", aliasErr.message);
  if (caErr) fail("character_appearances", caErr.message);
  if (charErr) fail("characters", charErr.message);

  const { data: castRows, error: castErr } = await client
    .from("castlist")
    .select("character")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (castErr) fail("castlist", castErr.message);

  const aliasMap = new Map<string, string>();
  for (const r of (aliasRows ?? []) as Array<{
    alias: string;
    canonical: string;
  }>) {
    aliasMap.set(r.alias.toLowerCase().trim(), r.canonical);
  }

  const readyCharacters = new Set<string>();
  for (const r of (caRows ?? []) as Array<{
    character_id: string;
    voice_status: string | null;
    voice_model_status: string | null;
  }>) {
    if (r.voice_status === "ready" || r.voice_model_status === "ready") {
      readyCharacters.add(r.character_id);
    }
  }

  const castedCharacters = new Set<string>();
  for (const r of (castRows ?? []) as Array<{ character: string }>) {
    castedCharacters.add(r.character);
  }

  const characterRows = (charRows ?? []) as Array<{
    id: string;
    aliases: string[] | null;
  }>;

  let namedFromJson = new Map<string, boolean>();
  if (projectRoot) {
    namedFromJson = await loadNamedMapFromNewCharactersJson(
      projectRoot,
      bookId,
      issueId,
    );
  }

  type Agg = {
    variants: Set<string>;
    pageNumbers: Set<number>;
    bubbleCount: number;
    sampleText: string | null;
  };
  const byResolved = new Map<string, Agg>();

  for (const row of (bubbleRows ?? []) as BubbleRow[]) {
    if (row.ignored) continue;
    const raw = row.speaker?.trim();
    if (!raw) continue;

    const resolved = resolveAlias(raw, aliasMap);

    const agg =
      byResolved.get(resolved) ??
      ({
        variants: new Set<string>(),
        pageNumbers: new Set<number>(),
        bubbleCount: 0,
        sampleText: null,
      } satisfies Agg);

    agg.variants.add(raw);
    agg.pageNumbers.add(row.page_number);
    agg.bubbleCount += 1;
    if (!agg.sampleText) {
      const text = row.text_with_cues ?? row.ocr_text ?? "";
      if (text.trim()) agg.sampleText = text.slice(0, 160);
    }
    byResolved.set(resolved, agg);
  }

  const autoResolved: NewCharacterReview[] = [];
  const queue: NewCharacterReview[] = [];

  for (const [resolvedName, agg] of byResolved) {
    const variants = Array.from(agg.variants).sort();
    const originalName = variants[0] ?? resolvedName;
    const pageNumbers = Array.from(agg.pageNumbers).sort((a, b) => a - b);

    const namedFromFile = namedFromJson.get(resolvedName);
    const classification: "named" | "generic" =
      namedFromFile === undefined
        ? "named"
        : namedFromFile
          ? "named"
          : "generic";

    const isNarrator = resolvedName.trim().toLowerCase() === "narrator";
    const inRegistry =
      readyCharacters.has(resolvedName) ||
      matchesCharacterRow(resolvedName, characterRows);
    const inCast = castedCharacters.has(resolvedName);

    const base: Omit<NewCharacterReview, "status" | "autoReason"> = {
      originalName,
      resolvedName,
      classification,
      pageNumbers,
      bubbleCount: agg.bubbleCount,
      sampleText: agg.sampleText,
      resolvedTo: null,
      speakerVariants: variants,
    };

    if (isNarrator) {
      autoResolved.push({
        ...base,
        status: "aliased",
        resolvedTo: null,
        autoReason: "narrator",
      });
      continue;
    }
    if (inRegistry) {
      autoResolved.push({
        ...base,
        status: "aliased",
        resolvedTo: null,
        autoReason: "registry",
      });
      continue;
    }
    if (inCast) {
      autoResolved.push({
        ...base,
        status: "aliased",
        resolvedTo: null,
        autoReason: "castlist",
      });
      continue;
    }

    queue.push({
      ...base,
      status: "pending",
    });
  }

  autoResolved.sort((a, b) => a.resolvedName.localeCompare(b.resolvedName));
  queue.sort((a, b) => a.resolvedName.localeCompare(b.resolvedName));

  return {
    autoResolved,
    queue,
    pendingCount: queue.length,
  };
}
