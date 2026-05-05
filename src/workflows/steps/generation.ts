export async function getCharactersNeedingVoices(
  bookId: string,
  issueId: string,
): Promise<string[]> {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: chars } = await supabase
    .from("characters")
    .select("id")
    .eq("book_id", bookId)
    .is("voice_id", null)
    .not("voice_description", "is", null);

  if (!chars || chars.length === 0) return [];

  const { data: issueBubbles } = await supabase
    .from("bubbles")
    .select("speaker")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  const issueSpeakers = new Set(
    (issueBubbles ?? []).map((b: { speaker: string }) => b.speaker),
  );

  const needed = (chars as { id: string }[])
    .filter((c) => issueSpeakers.has(c.id))
    .map((c) => c.id);

  console.log(
    `[get-chars] ${bookId}/${issueId}: ${needed.length} characters need voices`,
  );
  return needed;
}

export async function generateVoiceModel(
  bookId: string,
  issueId: string,
  characterId: string,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const { data: char } = await supabase
    .from("characters")
    .select("id, name, voice_description")
    .eq("id", characterId)
    .single();

  if (
    !char ||
    !(char as { voice_description: string | null }).voice_description
  ) {
    console.log(`[voice-model] ${characterId}: no voice description, skipping`);
    return;
  }

  const { name, voice_description } = char as {
    name: string;
    voice_description: string;
  };

  const designRes = await globalThis.fetch(
    "https://api.elevenlabs.io/v1/text-to-voice/design",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_description,
        model_id: "eleven_ttv_v3",
        auto_generate_text: true,
      }),
    },
  );

  if (!designRes.ok) {
    const err = await designRes.text();
    throw new Error(
      `Voice design failed for ${name}: ${designRes.status} ${err.slice(0, 200)}`,
    );
  }

  const designData = (await designRes.json()) as {
    previews: { generated_voice_id: string }[];
  };
  const generatedVoiceId = designData.previews[0]?.generated_voice_id;
  if (!generatedVoiceId) throw new Error(`No preview returned for ${name}`);

  const createRes = await globalThis.fetch(
    "https://api.elevenlabs.io/v1/text-to-voice",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_name: name,
        voice_description,
        generated_voice_id: generatedVoiceId,
      }),
    },
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(
      `Voice create failed for ${name}: ${createRes.status} ${err.slice(0, 200)}`,
    );
  }

  const { voice_id } = (await createRes.json()) as { voice_id: string };

  await supabase.from("characters").update({ voice_id }).eq("id", characterId);

  await supabase.from("castlist").upsert(
    {
      book_id: bookId,
      character_id: characterId,
      voice_id,
      issue_id: issueId,
    },
    { onConflict: "book_id,character_id" },
  );

  console.log(`[voice-model] ${name}: created voice ${voice_id}`);
}

export async function voiceRotationCheckout(bookId: string, _issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log("[voice-checkout] ELEVENLABS_API_KEY not set, skipping");
    return;
  }

  const [{ data: voices }, { data: castlist }] = await Promise.all([
    supabase
      .from("voices")
      .select("id, display_name, status, source_clip_path"),
    supabase.from("castlist").select("voice_uuid, book_id"),
  ]);

  const neededUuids = new Set(
    ((castlist ?? []) as { voice_uuid: string | null; book_id: string }[])
      .filter((c) => c.book_id === bookId && c.voice_uuid)
      .map((c) => c.voice_uuid!),
  );

  type VoiceRow = {
    id: string;
    display_name: string;
    status: string;
    source_clip_path: string | null;
  };

  const archived = ((voices ?? []) as VoiceRow[]).filter(
    (v) => neededUuids.has(v.id) && v.status === "archived",
  );

  if (archived.length === 0) {
    console.log(`[voice-checkout] ${bookId}: all needed voices already active`);
    return;
  }

  let restored = 0;
  for (const v of archived) {
    if (!v.source_clip_path) continue;

    const [maybeBucket, ...rest] = v.source_clip_path.split("/");
    const bucket = rest.length > 0 ? maybeBucket! : "comic-voice-clips";
    const objectPath = rest.length > 0 ? rest.join("/") : v.source_clip_path;
    const { data: clipData } = await supabase.storage
      .from(bucket)
      .download(objectPath);
    if (!clipData) continue;

    const clipBytes = await clipData.arrayBuffer();
    const filename = v.source_clip_path.split("/").pop() ?? `${v.id}.mp3`;

    const form = new FormData();
    form.append("name", v.display_name);
    form.append(
      "files",
      new Blob([clipBytes], { type: "audio/mpeg" }),
      filename,
    );

    const r = await globalThis.fetch(
      "https://api.elevenlabs.io/v1/voices/add",
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
      },
    );
    if (!r.ok) continue;

    const { voice_id } = (await r.json()) as { voice_id: string };

    await supabase
      .from("voices")
      .update({
        status: "active",
        current_elevenlabs_id: voice_id,
        archived_at: null,
      })
      .eq("id", v.id);

    await supabase.from("castlist").update({ voice_id }).eq("voice_uuid", v.id);

    restored++;
  }

  console.log(
    `[voice-checkout] ${bookId}: restored ${restored}/${archived.length} voices`,
  );
}

export async function getBubbleIdsForAudio(
  bookId: string,
  issueId: string,
): Promise<string[]> {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .is("audio_path", null)
    .not("text", "is", null)
    .order("page_number")
    .order("sort_order");

  const ids = (bubbles ?? []).map((b: { id: string }) => b.id);
  console.log(
    `[get-bubbles] ${bookId}/${issueId}: ${ids.length} bubbles need audio`,
  );
  return ids;
}

export async function generateAudioBatch(
  bookId: string,
  issueId: string,
  bubbleIds: string[],
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const client = new ElevenLabsClient({ apiKey });

  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id, speaker, text, emotion")
    .in("id", bubbleIds);

  if (!bubbles || bubbles.length === 0) return;

  const { data: castRows } = await supabase
    .from("castlist")
    .select("character_id, voice_id")
    .eq("book_id", bookId);

  const castMap = new Map(
    ((castRows ?? []) as { character_id: string; voice_id: string }[]).map(
      (c) => [c.character_id, c.voice_id],
    ),
  );

  const narratorVoice = castMap.get("Narrator") ?? castMap.get("narrator");

  type BubbleRow = {
    id: string;
    speaker: string | null;
    text: string;
    emotion: string | null;
  };

  let generated = 0;
  for (const bubble of bubbles as BubbleRow[]) {
    const voiceId = castMap.get(bubble.speaker ?? "") ?? narratorVoice;
    if (!voiceId || !bubble.text) continue;

    const stability =
      bubble.emotion === "angry" || bubble.emotion === "scared"
        ? 0.3
        : bubble.emotion === "excited" || bubble.emotion === "happy"
          ? 0.4
          : 0.5;

    const response = await client.textToSpeech.convertWithTimestamps(voiceId, {
      modelId: "eleven_v3",
      text: bubble.text,
      voiceSettings: { stability, similarityBoost: 0.75, style: 0.4 },
    });

    const audioBuffer = Buffer.from(response.audioBase64, "base64");

    const audioPath = `${bookId}/${issueId}/${bubble.id}.mp3`;
    await supabase.storage.from("comic-audio").upload(audioPath, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });

    const alignment = response.normalizedAlignment as {
      characters?: string[];
      characterStartTimesSeconds?: number[];
      characterEndTimesSeconds?: number[];
    } | null;

    await supabase
      .from("bubbles")
      .update({
        audio_path: audioPath,
        audio_timestamps: alignment ?? null,
      })
      .eq("id", bubble.id);

    generated++;
  }

  console.log(
    `[audio] ${bookId}/${issueId}: generated ${generated}/${bubbleIds.length} audio files`,
  );
}
