# Comic Reader

Personal "Audible + Kindle for comics" app. Kids learning to read get an interactive comic viewer where tapping a speech bubble plays the character's voice and highlights words in sync (karaoke-style). Family use only — not for sale.

Currently live with TMNT × MMPR issues. Powered by a pipeline that goes from raw comic scans to a fully voiced, interactive reading experience.

## Tech Stack

- **Frontend**: Next.js 15 App Router, React 19, Tailwind CSS
- **Database**: Supabase (PostgreSQL + Storage)
- **Bubble detection**: Roboflow
- **OCR + Context**: Google Gemini
- **Voice**: ElevenLabs (PVC for main characters, Voice Design for minor)
- **Image processing**: sharp (JPEG → WebP)
- **Deployed**: Vercel

## Pipeline

Each book+issue is processed by `pnpm ingest -- --book <name> --issue <n>`:

| Step | What it does                                                                |
| ---- | --------------------------------------------------------------------------- |
| 1    | validate-inputs — check assets dir + pages exist                            |
| 2    | generate-pages-metadata — extract page dimensions                           |
| 3    | convert-pages-to-webp — JPEG → WebP                                         |
| 4    | get-context — Roboflow detection + Gemini OCR + speaker/emotion             |
| 5    | sort-bubbles-gemini — AI reading order sort                                 |
| 6    | add-bubble-styles — % coordinates for responsive overlay                    |
| 7    | generate-character-voice-descriptions — Gemini voice descriptions           |
| 8    | clean-voice-descriptions — normalize names via alias map                    |
| 9    | find-voice-sources — Gemini researches voice media appearances              |
| 10   | generate-voice-models — ElevenLabs creates voice models                     |
| 11   | generate-audio — ElevenLabs TTS for every bubble                            |
| 12   | copy-to-public — upload WebP + audio to Supabase Storage; upsert data to DB |
| 13   | generate-manifest — update issues table counts + flags                      |

## Key Commands

```bash
# Add a new comic
pnpm scrape-pages -- --url <url> --book <name> --issue <n>
pnpm ingest -- --book <name> --issue <n>

# Apply review corrections and sync to DB
pnpm apply-fixes

# Migrate existing local data to Supabase
pnpm migrate-to-db -- --book <name> --issue <n>

# Dev server
pnpm dev

# Type check
pnpm typecheck
```

## Environment Variables

```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ROBOFLOW_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
REVALIDATE_SECRET=
NEXT_PUBLIC_BASE_URL=
```

See `.env` for full variable list including optional pipeline flags.

```js
const response = await fetch(
  "https://detect.roboflow.com/infer/workflows/fresh-space/find-comic-panel-v1",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: "",
      inputs: {
        image: { type: "url", value: "IMAGE_URL" },
      },
    }),
  },
);

const result = await response.json();
console.log(result);
```

New Roboflow workflow:
`comic-page-analyzer-1777506243433`
