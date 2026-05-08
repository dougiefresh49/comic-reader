import Link from "next/link";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ClusterReviewClient } from "./ClusterReviewClient";
import type { CharacterCluster, ClusterFace } from "./ClusterReviewClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

interface DetectionRow {
  id: string;
  character_id: string | null;
  suggested_name: string | null;
  panel_id: string;
  face_bbox: { x: number; y: number; w: number; h: number };
  identification_confidence: number;
  human_verified: boolean;
}

interface ExemplarRow {
  id: string;
  character_id: string | null;
  suggested_name: string | null;
  page_number: number;
  crop_path: string;
  confidence: number;
  is_confirmed: boolean;
}

interface PanelRow {
  id: string;
  page_number: number;
}

async function getClusterData(bookId: string, issueId: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  const [panelsRes, exemplarsRes, charsRes] = await Promise.all([
    supabaseAdmin
      .from("panels")
      .select("id, page_number")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabaseAdmin
      .from("character_face_exemplars")
      .select(
        "id, character_id, suggested_name, page_number, crop_path, confidence, is_confirmed",
      )
      .eq("book_id", bookId)
      .eq("source_issue", issueId),
    supabaseAdmin
      .from("characters")
      .select("id, name")
      .eq("book_id", bookId)
      .order("id"),
  ]);

  const panels = (panelsRes.data ?? []) as PanelRow[];
  const panelIds = panels.map((p) => p.id);
  const panelPageMap = new Map(panels.map((p) => [p.id, p.page_number]));

  let detections: DetectionRow[] = [];
  if (panelIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, character_id, suggested_name, panel_id, face_bbox, identification_confidence, human_verified",
      )
      .in("panel_id", panelIds);
    detections = (data ?? []) as DetectionRow[];
  }

  const exemplars = (exemplarsRes.data ?? []) as ExemplarRow[];
  const knownCharacters = (charsRes.data ?? []) as {
    id: string;
    name: string;
  }[];

  const exemplarsByKey = new Map<string, ExemplarRow[]>();
  for (const e of exemplars) {
    const key = e.character_id ?? `_:${e.suggested_name}`;
    const arr = exemplarsByKey.get(key) ?? [];
    arr.push(e);
    exemplarsByKey.set(key, arr);
  }

  const clusterMap = new Map<
    string,
    { charId: string | null; suggested: string | null; faces: ClusterFace[] }
  >();

  for (const d of detections) {
    const clusterKey =
      d.character_id ?? `unresolved:${d.suggested_name ?? "unknown"}`;
    const pageNumber = panelPageMap.get(d.panel_id) ?? 0;

    const matchKey = d.character_id ?? `_:${d.suggested_name}`;
    const candidateExemplars = exemplarsByKey.get(matchKey) ?? [];
    const matchedExemplar =
      candidateExemplars.find((e) => e.page_number === pageNumber) ??
      candidateExemplars[0] ??
      null;

    const face: ClusterFace = {
      detectionId: d.id,
      exemplarId: matchedExemplar?.id ?? null,
      cropUrl: matchedExemplar
        ? `${supabaseUrl}/storage/v1/object/public/face-exemplars/${matchedExemplar.crop_path}`
        : null,
      confidence: d.identification_confidence,
      humanVerified: d.human_verified,
      isConfirmed: matchedExemplar?.is_confirmed ?? false,
      pageNumber,
      panelId: d.panel_id,
      faceBbox: d.face_bbox,
    };

    if (!clusterMap.has(clusterKey)) {
      clusterMap.set(clusterKey, {
        charId: d.character_id,
        suggested: d.suggested_name,
        faces: [],
      });
    }
    clusterMap.get(clusterKey)!.faces.push(face);
  }

  // Also include exemplars that have no matching detection (orphaned exemplars)
  for (const e of exemplars) {
    const clusterKey =
      e.character_id ?? `unresolved:${e.suggested_name ?? "unknown"}`;
    const existing = clusterMap.get(clusterKey);
    const alreadyLinked = existing?.faces.some((f) => f.exemplarId === e.id);
    if (!alreadyLinked) {
      const face: ClusterFace = {
        detectionId: `exemplar-only:${e.id}`,
        exemplarId: e.id,
        cropUrl: `${supabaseUrl}/storage/v1/object/public/face-exemplars/${e.crop_path}`,
        confidence: e.confidence,
        humanVerified: false,
        isConfirmed: e.is_confirmed,
        pageNumber: e.page_number,
        panelId: "",
        faceBbox: { x: 0, y: 0, w: 0, h: 0 },
      };
      if (!clusterMap.has(clusterKey)) {
        clusterMap.set(clusterKey, {
          charId: e.character_id,
          suggested: e.suggested_name,
          faces: [],
        });
      }
      clusterMap.get(clusterKey)!.faces.push(face);
    }
  }

  const clusters: CharacterCluster[] = [];
  for (const [key, val] of clusterMap) {
    val.faces.sort((a, b) => a.pageNumber - b.pageNumber);
    clusters.push({
      key,
      characterId: val.charId,
      suggestedName: val.suggested,
      label: val.charId ?? val.suggested ?? "Unknown",
      faces: val.faces,
      isResolved: val.charId !== null,
    });
  }

  clusters.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    return a.label.localeCompare(b.label);
  });

  return { clusters, knownCharacters };
}

export default async function ReviewClustersPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const { clusters, knownCharacters } = await getClusterData(bookId, issueId);

  const totalFaces = clusters.reduce((s, c) => s + c.faces.length, 0);

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            &larr; Admin
          </Link>
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>

        <h1 className="mb-2 text-2xl font-semibold">
          Review character clusters
        </h1>
        <p className="mb-8 text-sm text-neutral-400">
          Confirm, rename, merge, or reject face detections from character
          lookahead. Assign all unresolved faces before approving.
        </p>

        {totalFaces === 0 ? (
          <>
            <div className="rounded-lg border border-dashed border-neutral-700 bg-neutral-900/40 p-8 text-center text-sm text-neutral-500">
              No face detections found for this issue. The character lookahead
              step may not have run yet, or no faces were detected above the
              confidence threshold.
            </div>
            <div className="mt-8 flex items-center justify-between">
              <Link
                href={`/admin/${bookId}/${issueId}/review/pipeline`}
                className="text-sm text-cyan-400 hover:text-cyan-300"
              >
                &larr; Back to pipeline review
              </Link>
            </div>
          </>
        ) : (
          <ClusterReviewClient
            bookId={bookId}
            issueId={issueId}
            initialClusters={clusters}
            knownCharacters={knownCharacters}
          />
        )}
      </div>
    </main>
  );
}
