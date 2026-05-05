export interface PageMeta {
  pageNumber: number;
  width: number;
  height: number;
}

export type BoundingBoxJson = { x: number; y: number; w: number; h: number };

export async function updatePipelineStep(
  bookId: string,
  issueId: string,
  step: string,
  paused = false,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const pauseUrl = paused ? getPauseUrl(bookId, issueId, step) : null;

  await supabase
    .from("issues")
    .update({
      pipeline_step: step,
      pipeline_paused: paused,
      pipeline_paused_at: paused ? step : null,
      pipeline_paused_url: pauseUrl,
    })
    .eq("id", issueId);
}

function getPauseUrl(bookId: string, issueId: string, step: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  switch (step) {
    case "review-clusters":
      return `${base}/admin/${bookId}/${issueId}/review/clusters`;
    case "review-pages":
      return `${base}/book/${bookId}/${issueId}/review?mode=pipeline`;
    case "review-new-characters":
      return `${base}/admin/${bookId}/${issueId}/review/new-characters`;
    case "casting":
      return `${base}/admin/characters/casting?book=${bookId}&issue=${issueId}`;
    default:
      return `${base}/admin`;
  }
}

export async function getPageList(
  bookId: string,
  issueId: string,
): Promise<PageMeta[]> {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { data: files } = await supabase.storage
    .from("comic-pages")
    .list(`${bookId}/${issueId}/pages`);

  if (!files) return [];

  const pages = files
    .filter((f) => /^page-\d+\.webp$/i.test(f.name))
    .map((f) => {
      const match = /page-(\d+)\.webp$/i.exec(f.name);
      return {
        pageNumber: match ? parseInt(match[1]!, 10) : 0,
        width: 0,
        height: 0,
        filename: f.name,
      };
    })
    .sort((a, b) => a.pageNumber - b.pageNumber);

  const { data: metaData } = await supabase.storage
    .from("comic-pages")
    .download(`${bookId}/${issueId}/pages.json`);

  if (metaData) {
    try {
      const meta = JSON.parse(await metaData.text()) as PageMeta[];
      const metaMap = new Map(meta.map((m) => [m.pageNumber, m]));
      for (const page of pages) {
        const m = metaMap.get(page.pageNumber);
        if (m) {
          page.width = m.width;
          page.height = m.height;
        }
      }
    } catch {
      // metadata parse failed, continue with zero dimensions
    }
  }

  return pages;
}

export async function markIssueReady(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  await supabase
    .from("issues")
    .update({
      pipeline_step: "complete",
      status: "ready",
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("id", issueId);
}

export function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

export function rdpSimplify(
  points: Array<{ x: number; y: number }>,
  epsilon: number,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i]!;
    const dist = perpendicularDist(pt, first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpendicularDist(
  pt: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number },
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = pt.x - lineStart.x;
    const ey = pt.y - lineStart.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const num = Math.abs(
    dy * pt.x - dx * pt.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x,
  );
  return num / Math.sqrt(lenSq);
}
