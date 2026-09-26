import type { SupabaseClient } from "@supabase/supabase-js";

const SPEECH_TYPES = ["SPEECH", "NARRATION", "CAPTION"] as const;
const SKIPPED_VOICE = "__SKIPPED__";

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** Postgres unique_violation; treat as "row already exists". */
function isUniqueViolation(error: {
  code?: string;
  message?: string;
}): boolean {
  return error.code === "23505";
}

export interface CastlistCopyRow {
  character: string;
  voice_id: string;
  voice_uuid: string | null;
}

export interface CastingPlan {
  speakers: number;
  cast: number;
  unresolved: string[];
  toCopy: CastlistCopyRow[];
  toCreate: string[];
  existingPending: number;
}

export interface CreateCastingTasksResult {
  speakers: number;
  cast: number;
  created: number;
  pending: number;
  unresolved: string[];
}

/**
 * Read-only plan: which speakers resolve, which are already cast (including
 * rows that can be copied from another issue), and which need a casting_task.
 */
export async function planCastingTasks(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<CastingPlan> {
  const { data: bubbleRows, error: bubErr } = await client
    .from("bubbles")
    .select("speaker, type, ignored")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("speaker", "is", null)
    .in("type", [...SPEECH_TYPES]);

  if (bubErr) throw new Error(bubErr.message);

  const speakerSet = new Set<string>();
  for (const row of bubbleRows ?? []) {
    const r = row as {
      speaker: string | null;
      type: string;
      ignored: boolean | null;
    };
    if (!r.speaker || r.ignored) continue;
    speakerSet.add(r.speaker);
  }

  const { data: aliasRows, error: aliasErr } = await client
    .from("aliases")
    .select("alias, canonical, scope, scope_id")
    .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`);
  if (aliasErr) throw new Error(aliasErr.message);

  const aliasMap = new Map<string, string>();
  for (const row of aliasRows ?? []) {
    const r = row as { alias: string; canonical: string };
    aliasMap.set(norm(r.alias), r.canonical);
  }

  const { data: charRows, error: charErr } = await client
    .from("characters")
    .select("id, aliases");
  if (charErr) throw new Error(charErr.message);

  type CharRow = { id: string; aliases: string[] | null };
  const characters = (charRows ?? []) as CharRow[];

  function resolveCharacterId(speaker: string): string | null {
    const canonical = aliasMap.get(norm(speaker)) ?? speaker;
    const sluggedCanonical = slugify(canonical);
    const needleSpeaker = norm(speaker);
    const needleCanonical = norm(canonical);
    const needleSlug = norm(sluggedCanonical);

    for (const c of characters) {
      const idNorm = norm(c.id);
      if (
        idNorm === needleSpeaker ||
        idNorm === needleCanonical ||
        idNorm === needleSlug ||
        c.id === speaker ||
        c.id === sluggedCanonical
      ) {
        return c.id;
      }
      for (const a of c.aliases ?? []) {
        const aNorm = norm(a);
        if (
          aNorm === needleSpeaker ||
          aNorm === needleCanonical ||
          aNorm === needleSlug
        ) {
          return c.id;
        }
      }
    }
    return null;
  }

  const { data: castRows, error: castErr } = await client
    .from("castlist")
    .select("issue_id, character, voice_id, voice_uuid")
    .eq("book_id", bookId);
  if (castErr) throw new Error(castErr.message);

  type CastRow = {
    issue_id: string;
    character: string;
    voice_id: string | null;
    voice_uuid: string | null;
  };
  const castlist = (castRows ?? []) as CastRow[];

  const { data: taskRows, error: taskErr } = await client
    .from("casting_tasks")
    .select("character_id, status")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (taskErr) throw new Error(taskErr.message);

  type TaskRow = { character_id: string; status: string };
  const taskByChar = new Map(
    ((taskRows ?? []) as TaskRow[]).map((t) => [t.character_id, t]),
  );

  const unresolved: string[] = [];
  const toCopy: CastlistCopyRow[] = [];
  const toCreateSet = new Set<string>();
  const pendingSeen = new Set<string>();
  const copyKeys = new Set<string>();
  let castCount = 0;

  for (const speaker of speakerSet) {
    const characterId = resolveCharacterId(speaker);
    if (!characterId) {
      unresolved.push(speaker);
      continue;
    }

    const char = characters.find((c) => c.id === characterId);
    const canonical = aliasMap.get(norm(speaker)) ?? speaker;
    const matchNames = new Set(
      [speaker, canonical, characterId, ...(char?.aliases ?? [])].map(norm),
    );

    const nameMatches = (c: CastRow): boolean =>
      matchNames.has(norm(c.character));

    const hasVoice = (c: CastRow): boolean =>
      Boolean(c.voice_id) && c.voice_id !== SKIPPED_VOICE;

    // Any castlist row already on this issue (voice, skip, or empty) is kept.
    // Copy-forward only fills gaps; never overwrite a local decision.
    const thisIssueRow = castlist.find(
      (c) => c.issue_id === issueId && nameMatches(c),
    );
    if (thisIssueRow) {
      if (hasVoice(thisIssueRow)) {
        castCount++;
      }
      // __SKIPPED__ (and any other existing row) counts as decided: no task.
      continue;
    }

    const otherCast = castlist.find(
      (c) => c.issue_id !== issueId && nameMatches(c) && hasVoice(c),
    );
    if (otherCast?.voice_id) {
      castCount++;
      if (!copyKeys.has(otherCast.character)) {
        copyKeys.add(otherCast.character);
        toCopy.push({
          character: otherCast.character,
          voice_id: otherCast.voice_id,
          voice_uuid: otherCast.voice_uuid,
        });
      }
      continue;
    }

    const existing = taskByChar.get(characterId);
    if (existing?.status === "pending") {
      pendingSeen.add(characterId);
      continue;
    }
    if (existing) {
      continue;
    }

    toCreateSet.add(characterId);
  }

  return {
    speakers: speakerSet.size,
    cast: castCount,
    unresolved: unresolved.sort(),
    toCopy,
    toCreate: [...toCreateSet],
    existingPending: pendingSeen.size,
  };
}

/**
 * Pending count shared by the planner and the workflow wrapper: tasks the
 * plan would create, plus pending tasks already present for speakers in the
 * plan. Stale pending rows for already-cast speakers are excluded.
 */
export function pendingFromPlan(plan: CastingPlan): number {
  return plan.toCreate.length + plan.existingPending;
}

/**
 * Workflow step: apply the plan's castlist copy-forward and casting_task
 * inserts. Returns counts the casting gate uses to decide pause vs skip.
 */
export async function createCastingTasks(
  bookId: string,
  issueId: string,
): Promise<CreateCastingTasksResult> {
  "use step";

  const { createStepClient } = await import("../step-utils");
  const client = await createStepClient();
  const plan = await planCastingTasks(client, bookId, issueId);

  for (const row of plan.toCopy) {
    // ignoreDuplicates: never overwrite an existing this-issue row (e.g. SKIPPED).
    const { error } = await client.from("castlist").upsert(
      {
        book_id: bookId,
        issue_id: issueId,
        character: row.character,
        voice_id: row.voice_id,
        voice_uuid: row.voice_uuid,
      },
      { onConflict: "book_id,issue_id,character", ignoreDuplicates: true },
    );
    if (error) {
      throw new Error(
        `[casting] castlist copy ${row.character}: ${error.message}`,
      );
    }
  }

  let created = 0;
  for (const characterId of plan.toCreate) {
    const { error } = await client.from("casting_tasks").insert({
      book_id: bookId,
      issue_id: issueId,
      character_id: characterId,
      status: "pending",
    });
    if (error) {
      if (isUniqueViolation(error)) {
        // Unique on (book_id, issue_id, character_id): task already exists.
        continue;
      }
      throw new Error(
        `[casting] casting_task ${characterId}: ${error.message}`,
      );
    }
    created++;
  }

  return {
    speakers: plan.speakers,
    cast: plan.cast,
    created,
    pending: pendingFromPlan(plan),
    unresolved: plan.unresolved,
  };
}
