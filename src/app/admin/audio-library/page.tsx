import { AMBIENCE_TAGS, MUSIC_MOODS, SFX_TAGS } from "~/lib/panel-tags";
import { audioLibraryUrl } from "~/lib/audio-library";

export const dynamic = "force-dynamic";

export default function AudioLibraryPage() {
  const sections = [
    { layer: "ambience" as const, tags: [...AMBIENCE_TAGS] },
    { layer: "sfx" as const, tags: [...SFX_TAGS] },
    { layer: "music" as const, tags: [...MUSIC_MOODS] },
  ];
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-2xl font-semibold">Audio library</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Listen to every tag&apos;s current cached file. Empty/missing files
          show the player but won&apos;t play. Run{" "}
          <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">
            pnpm bootstrap-audio-library -- --tag &lt;tag&gt;
          </code>{" "}
          to (re)source one entry.
        </p>
        {sections.map((s) => (
          <section key={s.layer} className="mb-8">
            <h2 className="mb-3 text-lg font-medium capitalize">{s.layer}</h2>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {s.tags.map((tag) => (
                <div
                  key={tag}
                  className="flex items-center gap-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2"
                >
                  <span className="w-48 font-mono text-xs text-neutral-300">
                    {tag}
                  </span>
                  <audio
                    src={audioLibraryUrl(s.layer, tag)}
                    controls
                    preload="none"
                    className="flex-1"
                  />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
