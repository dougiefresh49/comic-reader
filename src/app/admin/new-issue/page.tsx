import { NewIssueUploader } from "./NewIssueUploader";

export const dynamic = "force-dynamic";

export default function NewIssuePage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-2 text-2xl font-semibold">New Issue</h1>
        <p className="mb-8 text-sm text-neutral-400">
          Upload raw page JPEGs to the <code>comic-pages-raw</code> bucket. Once
          complete, run{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs">
            pnpm ingest -- --book &lt;name&gt; --issue &lt;n&gt;
          </code>{" "}
          locally to start the pipeline.
        </p>
        <NewIssueUploader />
      </div>
    </main>
  );
}
