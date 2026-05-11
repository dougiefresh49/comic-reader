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
  bounding_box: { x: number; y: number; w: number; h: number } | null;
}

async function getClusterData(bookId: string, issueId: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  const [panelsRes, exemplarsRes, charsRes] = await Promise.all([
    supabaseAdmin
      .from("panels")
      .select("id, page_number, bounding_box")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabaseAdmin
      .from("character_face_exemplars")
      .select(
        "id, character_id, suggested_name, page_number, crop_path, confidence, is_confirmed",
      )
      .eq("book_id", bookId)
      .eq("source_issue", issueId),
    supabaseAdmin.from("books").select("franchises").eq("id", bookId).single(),
  ]);

  const panels = (panelsRes.data ?? []) as PanelRow[];
  const panelIds = panels.map((p) => p.id);
  const panelPageMap = new Map(panels.map((p) => [p.id, p.page_number]));
  const panelBboxMap = new Map(panels.map((p) => [p.id, p.bounding_box]));

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

  const franchises = (charsRes.data?.franchises as string[] | null) ?? [];
  let charsQuery = supabaseAdmin
    .from("characters")
    .select("id, aliases")
    .order("id");
  if (franchises.length > 0) {
    const filter = franchises.map((f) => `franchise.eq.${f}`).join(",");
    charsQuery = charsQuery.or(`${filter},franchise.is.null`);
  }
  const { data: charRows } = await charsQuery;
  const knownCharacters = (
    (charRows ?? []) as { id: string; aliases: string[] | null }[]
  ).map((c) => ({
    id: c.id,
    name: c.aliases?.[0] ?? c.id.replace(/-/g, " "),
  }));

  // Build a map of detection IDs per (character_id or suggested_name) + page
  const detectionsByCluster = new Map<
    string,
    {
      ids: string[];
      pages: Set<number>;
      totalConfidence: number;
      count: number;
      anyVerified: boolean;
    }
  >();
  for (const d of detections) {
    const clusterKey =
      d.character_id ?? `unresolved:${d.suggested_name ?? "unknown"}`;
    if (!detectionsByCluster.has(clusterKey)) {
      detectionsByCluster.set(clusterKey, {
        ids: [],
        pages: new Set(),
        totalConfidence: 0,
        count: 0,
        anyVerified: false,
      });
    }
    const entry = detectionsByCluster.get(clusterKey)!;
    entry.ids.push(d.id);
    entry.pages.add(panelPageMap.get(d.panel_id) ?? 0);
    entry.totalConfidence += d.identification_confidence;
    entry.count++;
    if (d.human_verified) entry.anyVerified = true;
  }

  // Build faces from exemplars (each exemplar = one unique crop)
  const clusterMap = new Map<
    string,
    { charId: string | null; suggested: string | null; faces: ClusterFace[] }
  >();

  for (const e of exemplars) {
    const clusterKey =
      e.character_id ?? `unresolved:${e.suggested_name ?? "unknown"}`;

    // Find detection on same page for face_bbox + panel_id
    const matchingDetection = detections.find((d) => {
      const dKey =
        d.character_id ?? `unresolved:${d.suggested_name ?? "unknown"}`;
      return (
        dKey === clusterKey &&
        (panelPageMap.get(d.panel_id) ?? 0) === e.page_number
      );
    });

    const pageUrl = `${supabaseUrl}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${String(e.page_number).padStart(2, "0")}.webp`;

    const panelBbox = matchingDetection
      ? panelBboxMap.get(matchingDetection.panel_id)
      : null;
    const localBbox = matchingDetection?.face_bbox ?? {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
    const pageBbox =
      panelBbox && localBbox.w > 0
        ? {
            x: panelBbox.x + localBbox.x * panelBbox.w,
            y: panelBbox.y + localBbox.y * panelBbox.h,
            w: localBbox.w * panelBbox.w,
            h: localBbox.h * panelBbox.h,
          }
        : localBbox;

    const face: ClusterFace = {
      detectionId: matchingDetection?.id ?? `exemplar-only:${e.id}`,
      exemplarId: e.id,
      cropUrl: `${supabaseUrl}/storage/v1/object/public/face-exemplars/${e.crop_path}`,
      confidence: e.confidence,
      humanVerified: matchingDetection?.human_verified ?? false,
      isConfirmed: e.is_confirmed,
      pageNumber: e.page_number,
      panelId: matchingDetection?.panel_id ?? "",
      faceBbox: pageBbox,
      pageImageUrl: pageUrl,
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

  // For clusters that have detections but no exemplars, add a placeholder
  for (const [clusterKey, info] of detectionsByCluster) {
    if (!clusterMap.has(clusterKey)) {
      const d = detections.find((det) => {
        const k =
          det.character_id ?? `unresolved:${det.suggested_name ?? "unknown"}`;
        return k === clusterKey;
      })!;
      const pageNum = panelPageMap.get(d.panel_id) ?? 0;
      const pageUrl = `${supabaseUrl}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${String(pageNum).padStart(2, "0")}.webp`;
      const pBbox = panelBboxMap.get(d.panel_id);
      const lBbox = d.face_bbox;
      const pPageBbox =
        pBbox && lBbox.w > 0
          ? {
              x: pBbox.x + lBbox.x * pBbox.w,
              y: pBbox.y + lBbox.y * pBbox.h,
              w: lBbox.w * pBbox.w,
              h: lBbox.h * pBbox.h,
            }
          : lBbox;
      clusterMap.set(clusterKey, {
        charId: d.character_id,
        suggested: d.suggested_name,
        faces: [
          {
            detectionId: d.id,
            exemplarId: null,
            cropUrl: null,
            confidence: info.totalConfidence / info.count,
            humanVerified: info.anyVerified,
            isConfirmed: false,
            pageNumber: pageNum,
            panelId: d.panel_id,
            faceBbox: pPageBbox,
            pageImageUrl: pageUrl,
          },
        ],
      });
    }
  }

  // Attach detection counts and all detection IDs to each cluster
  for (const [key, val] of clusterMap) {
    const detInfo = detectionsByCluster.get(key);
    (val as unknown as Record<string, unknown>).detectionCount =
      detInfo?.count ?? val.faces.length;
    (val as unknown as Record<string, unknown>).allDetectionIds =
      detInfo?.ids ?? val.faces.map((f) => f.detectionId);
    (val as unknown as Record<string, unknown>).pageNumbers = detInfo
      ? [...detInfo.pages].sort((a, b) => a - b)
      : val.faces.map((f) => f.pageNumber);
  }

  const clusters: CharacterCluster[] = [];
  for (const [key, val] of clusterMap) {
    val.faces.sort((a, b) => a.pageNumber - b.pageNumber);
    const extra = val as unknown as Record<string, unknown>;
    clusters.push({
      key,
      characterId: val.charId,
      suggestedName: val.suggested,
      label: val.charId ?? val.suggested ?? "Unknown",
      faces: val.faces,
      isResolved: val.charId !== null,
      detectionCount: (extra.detectionCount as number) ?? val.faces.length,
      allDetectionIds:
        (extra.allDetectionIds as string[]) ??
        val.faces.map((f) => f.detectionId),
      pageNumbers:
        (extra.pageNumbers as number[]) ?? val.faces.map((f) => f.pageNumber),
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
      <div className="mx-auto max-w-7xl">
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
