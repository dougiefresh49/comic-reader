import { AMBIENCE_TAGS, MUSIC_MOODS, SFX_TAGS } from "~/lib/panel-tags";
import { getAudioLibraryListing } from "~/server/admin/audio-library";
import { AudioLibraryClient } from "./AudioLibraryClient";

export const dynamic = "force-dynamic";

export default async function AudioLibraryPage() {
  const listing = await getAudioLibraryListing();
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-2xl font-semibold">Audio library</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Listen to every cached file, swap the default with a fresh pick, or
          add named variants for alternate sounds (e.g.{" "}
          <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">
            sword_clang@bowstaff
          </code>
          ).
        </p>
        <AudioLibraryClient
          listing={listing}
          enums={{
            ambience: [...AMBIENCE_TAGS],
            sfx: [...SFX_TAGS],
            music: [...MUSIC_MOODS],
          }}
        />
      </div>
    </main>
  );
}
