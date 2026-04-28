import { supabase } from "./lib/supabase.js";

let aliasCache: Map<string, string> | null = null;

export async function initAliasMap(): Promise<void> {
  const { data, error } = await supabase
    .from("aliases")
    .select("alias, canonical, scope, scope_id");
  if (error) {
    console.warn(
      "alias-map: DB load failed, falling back to empty map:",
      error.message,
    );
    aliasCache = new Map();
    return;
  }
  aliasCache = new Map(
    (data ?? []).map((row: { alias: string; canonical: string }) => [
      row.alias.toLowerCase().trim(),
      row.canonical,
    ]),
  );
}

export function getCanonicalName(
  name: string,
  _context?: { bookId?: string; seriesId?: string },
): string {
  if (!aliasCache) {
    throw new Error("initAliasMap() must be called before getCanonicalName()");
  }
  const lower = name.toLowerCase().trim();
  // Scope resolution: book > series > global (simple lookup for now)
  return aliasCache.get(lower) ?? name;
}

// Keep the aliasMap export as a getter for backwards compat
export const aliasMap: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, key: string) {
      return aliasCache?.get(key.toLowerCase()) ?? undefined;
    },
  },
);
