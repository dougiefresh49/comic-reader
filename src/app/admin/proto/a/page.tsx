// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The issue hub. Reads rows with SELECTs only; nothing on this route writes or spends.
import { notFound } from "next/navigation";
import { loadProto, readQuery } from "./data";
import { initDoc, issueFlags } from "./editor/model";
import { Hub, type Stage } from "./Hub";
import { ProtoHeader } from "./ProtoHeader";

export const dynamic = "force-dynamic";

interface HubPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const DETECT = [
  "roboflow-page-analyze",
  "extract-foreground-masks",
  "fetch-wiki-context",
  "character-lookahead",
];
const READ = ["get-context", "sort-page-elements"];
const PAGES = ["review-pages", "review-new-characters"];

/** One rule for where the run is, read from the issue row alone. */
function stageOf(step: string | null, status: string): Stage {
  if (step?.startsWith("failed:")) return "failed";
  if (step === "complete" || status === "ready") return "ready";
  if (!step || step === "pages-downloaded") return "new";
  if (DETECT.includes(step)) return "detect";
  if (step === "review-clusters") return "characters";
  if (READ.includes(step)) return "read";
  if (PAGES.includes(step)) return "pages";
  return "audio";
}

export default async function HubPage({ searchParams }: HubPageProps) {
  const query = readQuery(await searchParams);
  const data = await loadProto(query);
  if (!data) notFound();

  const flags = issueFlags(initDoc(data));
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-200">
      <ProtoHeader
        book={data.bookId}
        issue={data.issueId}
        bookName={data.bookName}
        issueName={data.issueName}
        current="hub"
      />
      <Hub
        key={`${data.bookId}/${data.issueId}`}
        book={data.bookId}
        issue={data.issueId}
        realStage={stageOf(data.run.step, data.run.status)}
        realStep={data.run.step}
        counts={{
          pages: data.pages.length,
          panels: data.panels.length,
          bubbles: data.bubbles.length,
          characters: data.cast.filter((c) => c.kind === "character").length,
          unknownFaces: data.faces.filter((f) => !f.characterId).length,
          noVoice: data.cast.filter((c) => !c.voice).length,
          needYou: flags.length,
          slotsUsed: data.slotsUsed,
          slotsTotal: data.slotsTotal,
        }}
      />
    </div>
  );
}
