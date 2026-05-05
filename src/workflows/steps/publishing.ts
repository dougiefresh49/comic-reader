export async function uploadAudio(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: files } = await supabase.storage
    .from("comic-audio")
    .list(`${bookId}/${issueId}`);

  const audioCount = (files ?? []).filter((f: { name: string }) =>
    f.name.endsWith(".mp3"),
  ).length;

  await supabase
    .from("issues")
    .update({ has_audio: audioCount > 0, audio_count: audioCount })
    .eq("id", issueId);

  console.log(
    `[upload-audio] ${bookId}/${issueId}: verified ${audioCount} audio files in storage`,
  );
}

export async function consolidateMusicScenes(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: panels } = await supabase
    .from("panels")
    .select("id, page_number, sort_order, audio_tags, is_new_scene")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("page_number")
    .order("sort_order");

  if (!panels || panels.length === 0) {
    console.log(`[music] ${bookId}/${issueId}: no panels, skipping`);
    return;
  }

  type PanelRow = {
    id: string;
    page_number: number;
    sort_order: number;
    audio_tags: { music_mood?: string } | null;
    is_new_scene: boolean;
  };

  interface MusicRun {
    mood: string;
    panels: PanelRow[];
  }

  const runs: MusicRun[] = [];
  let current: MusicRun | null = null;

  for (const p of panels as PanelRow[]) {
    const raw = p.audio_tags?.music_mood ?? "transition_neutral";
    const mood = raw.replace(/_[a-z]$/, "").replace(/_\d+$/, "");

    if (current && mood === current.mood && !p.is_new_scene) {
      current.panels.push(p);
    } else {
      if (current) runs.push(current);
      current = { mood, panels: [p] };
    }
  }
  if (current) runs.push(current);

  await supabase
    .from("panels")
    .update({ scene_id: null })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("scene_id", "is", null);

  await supabase
    .from("music_scenes")
    .delete()
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  for (const run of runs) {
    const first = run.panels[0]!;
    const last = run.panels[run.panels.length - 1]!;

    const { data: scene } = await supabase
      .from("music_scenes")
      .insert({
        book_id: bookId,
        issue_id: issueId,
        music_mood: run.mood,
        start_panel_id: first.id,
        end_panel_id: last.id,
      })
      .select("id")
      .single();

    if (scene) {
      const panelIds = run.panels.map((p) => p.id);
      await supabase
        .from("panels")
        .update({ scene_id: (scene as { id: string }).id })
        .in("id", panelIds);
    }
  }

  console.log(
    `[music] ${bookId}/${issueId}: ${runs.length} scenes from ${panels.length} panels`,
  );
}

export async function generateManifest(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const [pageRes, bubbleRes, audioRes] = await Promise.all([
    supabase
      .from("pages")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .not("audio_path", "is", null),
  ]);

  const pageCount = pageRes.count ?? 0;
  const bubbleCount = bubbleRes.count ?? 0;
  const audioCount = audioRes.count ?? 0;

  await supabase
    .from("issues")
    .update({
      page_count: pageCount,
      bubble_count: bubbleCount,
      audio_count: audioCount,
      has_audio: audioCount > 0,
      has_timestamps: audioCount > 0,
    })
    .eq("id", issueId);

  console.log(
    `[manifest] ${bookId}/${issueId}: ${pageCount} pages, ${bubbleCount} bubbles, ${audioCount} audio`,
  );
}
