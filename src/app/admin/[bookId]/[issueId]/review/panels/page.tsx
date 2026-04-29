import Link from "next/link";
import { getPanelReviewData } from "~/server/admin/panel-review";
import {
  AMBIENCE_TAGS,
  EFFECT_TAGS,
  MUSIC_MOODS,
  SFX_TAGS,
} from "~/lib/panel-tags";
import { PanelsReviewClient } from "./PanelsReviewClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewPanelsPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const data = await getPanelReviewData(bookId, issueId);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            ← Admin
          </Link>
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>
        <h1 className="mb-1 text-2xl font-semibold">Review panels</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Drag panel edges to resize. Click a bubble to reassign. All edits stay
          local until you click <em>Apply</em>.
        </p>
        {data.pages.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-400">
            No pages found for this issue yet.
          </div>
        ) : (
          <PanelsReviewClient
            data={data}
            tagEnums={{
              effect: [...EFFECT_TAGS],
              ambience: [...AMBIENCE_TAGS],
              sfx: [...SFX_TAGS],
              music: [...MUSIC_MOODS],
            }}
          />
        )}
      </div>
    </main>
  );
}
