import Link from "next/link";
import { getSceneReviewData } from "~/server/admin/scene-review";
import { SceneEditorClient } from "./SceneEditorClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewScenesPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const data = await getSceneReviewData(bookId, issueId);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/admin"
              className="text-sm text-neutral-400 hover:text-neutral-200"
            >
              ← Admin
            </Link>
            <Link
              href={`/admin/${bookId}/${issueId}/review/panels`}
              className="text-sm text-neutral-400 hover:text-neutral-200"
            >
              Panels
            </Link>
          </div>
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>
        <h1 className="mb-1 text-2xl font-semibold">Scene editor</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Group panels into music scenes. Click a scene to edit, click a panel
          to reassign. Changes are local until you click <em>Save scenes</em>.
        </p>
        {data.panels.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-400">
            No panels found for this issue yet.
          </div>
        ) : (
          <SceneEditorClient data={data} />
        )}
      </div>
    </main>
  );
}
