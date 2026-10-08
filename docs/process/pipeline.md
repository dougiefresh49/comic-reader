# Comic Processing Pipeline

The local pipeline (`pnpm ingest` and its per-step scripts) is retired ([#309](https://github.com/dougiefresh49/comic-reader/issues/309)). Ingest runs as a Vercel Workflow, started from the admin Start Pipeline button.

- The code: `src/workflows/ingest-pipeline.ts`, with its steps in `src/workflows/steps/`.
- The diagram: `docs/pipeline/index.html`.
