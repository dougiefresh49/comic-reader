import { GoogleGenAI, createPartFromText } from "@google/genai";
import { GEMINI_MEDIUM } from "~/lib/models";

function slugifyCharacterId(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

export async function generateVoiceDescriptions(
  bookId: string,
  issueId: string,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const gemini = new GoogleGenAI({ apiKey });

  const { data: rows, error } = await supabase
    .from("bubbles")
    .select("speaker, voice_description")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("voice_description", "is", null)
    .not("speaker", "is", null);

  if (error) throw new Error(error.message);

  type BubbleVoiceRow = { speaker: string; voice_description: string };
  const bySpeaker = new Map<string, string[]>();
  for (const row of (rows ?? []) as BubbleVoiceRow[]) {
    const list = bySpeaker.get(row.speaker) ?? [];
    list.push(row.voice_description);
    bySpeaker.set(row.speaker, list);
  }

  const speakers = [...bySpeaker.keys()].sort();
  if (speakers.length === 0) {
    console.log(`[voice-desc] ${bookId}/${issueId}: no bubble voice snippets`);
    return;
  }

  let processed = 0;
  for (const speaker of speakers) {
    const snippets = bySpeaker.get(speaker)!;
    const list = snippets.map((s, idx) => `${idx + 1}. ${s}`).join("\n");

    const prompt = `Consolidate these voice description snippets into a single, concise voice description suitable for ElevenLabs voice design. Focus on tone, pitch, accent, and speaking style. Keep it under 100 words.

Character: "${speaker}"

Snippets:
${list}

Return ONLY the consolidated description as plain text — no JSON, no markdown.`;

    const textPart = createPartFromText(prompt);
    const response = await gemini.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [textPart],
    });

    const text = response.text?.trim();
    if (!text) throw new Error(`No Gemini response for ${speaker}`);

    const characterId = slugifyCharacterId(speaker);

    const { error: upErr } = await supabase.from("characters").upsert(
      {
        id: characterId,
        voice_description: text,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    if (upErr) throw new Error(upErr.message);

    console.log(`[voice-desc] "${speaker}" → characters.id=${characterId}`);
    processed++;

    if (processed < speakers.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(
    `[voice-desc] ${bookId}/${issueId}: consolidated ${speakers.length} character(s)`,
  );
}

export async function cleanVoiceDescriptions(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: aliasRows, error: aliasErr } = await supabase
    .from("aliases")
    .select("alias, canonical");

  if (aliasErr) {
    console.warn(`[clean-desc] aliases query: ${aliasErr.message}`);
  }

  const aliasMap = new Map<string, string>();
  for (const row of aliasRows ?? []) {
    const r = row as { alias: string; canonical: string };
    aliasMap.set(r.alias.toLowerCase().trim(), r.canonical);
  }

  function canonicalLabel(slugOrPhrase: string): string {
    const spaced = slugOrPhrase.replace(/-/g, " ").trim();
    const lower = spaced.toLowerCase();
    return (
      aliasMap.get(lower) ?? spaced.replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  function canonicalIdFromCharacterRowId(characterId: string): string {
    const phrase = characterId.replace(/-/g, " ");
    const label = canonicalLabel(phrase);
    return slugifyCharacterId(label);
  }

  function displayNameForCanonicalId(canonicalId: string): string {
    return canonicalLabel(canonicalId.replace(/-/g, " "));
  }

  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id, speaker, character_id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("speaker", "is", null);

  const relevantIds = new Set<string>();
  for (const b of bubbles ?? []) {
    const row = b as { speaker: string; character_id: string | null };
    relevantIds.add(slugifyCharacterId(row.speaker));
    if (row.character_id) relevantIds.add(row.character_id);
  }

  const { data: chars } = await supabase
    .from("characters")
    .select("id, voice_description")
    .not("voice_description", "is", null);

  type CharRow = { id: string; voice_description: string };
  const relevantChars = ((chars ?? []) as CharRow[]).filter((c) =>
    relevantIds.has(c.id),
  );

  if (relevantChars.length === 0) {
    console.log(`[clean-desc] ${bookId}/${issueId}: nothing to normalize`);
    return;
  }

  const groups = new Map<string, { canonicalId: string; members: CharRow[] }>();

  for (const row of relevantChars) {
    const canonicalId = canonicalIdFromCharacterRowId(row.id);
    let g = groups.get(canonicalId);
    if (!g) {
      g = { canonicalId, members: [] };
      groups.set(canonicalId, g);
    }
    g.members.push(row);
  }

  let mergedGroups = 0;
  let bubblesRetargeted = 0;

  for (const g of groups.values()) {
    const needsMerge =
      g.members.length > 1 || g.members.some((m) => m.id !== g.canonicalId);

    if (!needsMerge) continue;

    const winner = [...g.members].sort(
      (a, b) => b.voice_description.length - a.voice_description.length,
    )[0]!;
    const mergedDescription = winner.voice_description;
    const resolvedDisplayName = displayNameForCanonicalId(g.canonicalId);

    const { error: upCanonErr } = await supabase.from("characters").upsert(
      {
        id: g.canonicalId,
        voice_description: mergedDescription,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (upCanonErr) throw new Error(upCanonErr.message);

    mergedGroups++;

    const loserIds = new Set(
      g.members.filter((m) => m.id !== g.canonicalId).map((m) => m.id),
    );

    if (loserIds.size === 0) continue;

    for (const bub of bubbles ?? []) {
      const row = bub as {
        id: string;
        speaker: string;
        character_id: string | null;
      };
      const slugSpeaker = slugifyCharacterId(row.speaker);
      const targetsLoser =
        (row.character_id && loserIds.has(row.character_id)) ||
        loserIds.has(slugSpeaker);

      if (!targetsLoser) continue;

      const { error: bubErr } = await supabase
        .from("bubbles")
        .update({
          speaker: resolvedDisplayName,
          character_id: g.canonicalId,
        })
        .eq("id", row.id);

      if (!bubErr) bubblesRetargeted++;
    }

    for (const loserId of loserIds) {
      const { error: delErr } = await supabase
        .from("characters")
        .delete()
        .eq("id", loserId);

      if (delErr) {
        console.warn(
          `[clean-desc] could not delete merged character ${loserId}: ${delErr.message} — clearing voice_description`,
        );
        await supabase
          .from("characters")
          .update({
            voice_description: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", loserId);
      }
    }
  }

  console.log(
    `[clean-desc] ${bookId}/${issueId}: merged ${mergedGroups} canonical group(s); retargeted ${bubblesRetargeted} bubble(s)`,
  );
}
