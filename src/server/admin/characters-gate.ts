/**
 * The one check behind the characters stop (#349): the screen's Approve and
 * the resume endpoint both ask it before the `cluster-review` hook resumes,
 * so the dashboard's Resume cannot skip the stop.
 *
 * Also the one home of "unknown face group": detections with no
 * `character_id` that share a `cluster_id` or a `suggested_name`; a row with
 * neither is a group of its own. The screen's loader groups with the same
 * function, so what it shows is what the gate counts.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { seedCast } from "~/lib/cast";
import { slugify } from "~/lib/character-id";

export interface UnknownDetection {
  id: string;
  cluster_id: number | null;
  suggested_name: string | null;
}

export interface UnknownGroup<T extends UnknownDetection> {
  /** Stable across reads while the group exists: its lowest cluster id, else its first suggested name, else its lowest detection id. */
  key: string;
  clusterIds: number[];
  /** Distinct `suggested_name` texts, as stored. */
  suggestedNames: string[];
  detections: T[];
}

/**
 * Groups unnamed detections: two rows are in one group when they share a
 * `cluster_id` or a `suggested_name` (compared slugified), directly or
 * through other rows. Rows with neither stand alone.
 */
export function unknownFaceGroups<T extends UnknownDetection>(
  rows: T[],
): UnknownGroup<T>[] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const firstByKey = new Map<string, number>();
  rows.forEach((row, i) => {
    const keys: string[] = [];
    if (row.cluster_id !== null) keys.push(`cluster:${row.cluster_id}`);
    const name = row.suggested_name ? slugify(row.suggested_name) : "";
    if (name) keys.push(`name:${name}`);
    for (const key of keys) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, i);
      else union(i, first);
    }
  });

  const groups = new Map<number, UnknownGroup<T>>();
  rows.forEach((row, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { key: row.id, clusterIds: [], suggestedNames: [], detections: [] };
      groups.set(root, g);
    }
    g.detections.push(row);
    if (row.cluster_id !== null && !g.clusterIds.includes(row.cluster_id))
      g.clusterIds.push(row.cluster_id);
    const text = row.suggested_name?.trim();
    if (text && !g.suggestedNames.some((n) => slugify(n) === slugify(text)))
      g.suggestedNames.push(text);
  });
  return [...groups.values()].map((g) => {
    const name =
      g.suggestedNames.length > 0 ? slugify(g.suggestedNames[0]!) : "";
    return {
      ...g,
      key:
        g.clusterIds.length > 0
          ? `cluster:${Math.min(...g.clusterIds)}`
          : name
            ? `name:${name}`
            : `face:${[...g.detections.map((d) => d.id)].sort()[0]}`,
    };
  });
}

/** The issue's detections with no `character_id`, each with its panel's page. */
export async function readUnknownDetections(
  bookId: string,
  issueId: string,
): Promise<(UnknownDetection & { page: number })[]> {
  const { data, error } = await supabaseAdmin
    .from("panel_character_detections")
    .select("id, cluster_id, suggested_name, panels!inner(page_number)")
    .eq("panels.book_id", bookId)
    .eq("panels.issue_id", issueId)
    .is("character_id", null);
  if (error)
    throw new Error(`characters gate: reading unnamed faces: ${error.message}`);
  return (
    (data ?? []) as unknown as {
      id: string;
      cluster_id: number | null;
      suggested_name: string | null;
      panels: { page_number: number } | null;
    }[]
  ).map((d) => ({
    id: d.id,
    cluster_id: d.cluster_id,
    suggested_name: d.suggested_name,
    page: d.panels?.page_number ?? 0,
  }));
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Seeds the cast (the row-242 union, idempotent), then refuses on an empty
 * cast or while any unknown face group is neither named nor rejected.
 * Unmatched wiki names never block.
 */
export async function canApproveCharacters(
  bookId: string,
  issueId: string,
): Promise<GateVerdict> {
  await seedCast(supabaseAdmin, bookId, issueId);

  const [cast, unnamed] = await Promise.all([
    supabaseAdmin
      .from("castlist")
      .select("character", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("in_issue", true),
    readUnknownDetections(bookId, issueId),
  ]);
  if (cast.error)
    throw new Error(`characters gate: reading the cast: ${cast.error.message}`);

  if (!cast.count) {
    return {
      ok: false,
      reason: "The cast is empty: add at least one character.",
    };
  }
  const groups = unknownFaceGroups(unnamed);
  if (groups.length > 0) {
    const faces = unnamed.length;
    return {
      ok: false,
      reason: `${groups.length} unknown face ${groups.length === 1 ? "group" : "groups"} (${faces} ${faces === 1 ? "face" : "faces"}) still ${groups.length === 1 ? "needs" : "need"} a name, or "Not a character".`,
    };
  }
  return { ok: true };
}
