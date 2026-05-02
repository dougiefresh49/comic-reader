import pLimit from "p-limit";

const CLIP_EMBED_URL = "https://infer.roboflow.com/clip/embed_image";

export type Embedding = number[];

export async function embedFaceCrops(
  crops: Buffer[],
  apiKey: string,
  opts?: { concurrency?: number; delayMs?: number },
): Promise<Embedding[]> {
  const limit = pLimit(opts?.concurrency ?? 3);
  const delay = opts?.delayMs ?? 200;
  const embeddings: Array<{ index: number; embedding: Embedding }> = [];

  await Promise.all(
    crops.map((buf, idx) =>
      limit(async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));

        const b64 = buf.toString("base64");
        const url = `${CLIP_EMBED_URL}?api_key=${apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: { type: "base64", value: b64 },
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          console.warn(
            `   ⚠ CLIP embed failed for crop ${idx}: ${res.status} ${text.slice(0, 120)}`,
          );
          embeddings.push({ index: idx, embedding: [] });
          return;
        }

        const data = (await res.json()) as {
          embeddings?: Embedding[];
        };
        const emb = data.embeddings?.[0] ?? [];
        embeddings.push({ index: idx, embedding: emb });
      }),
    ),
  );

  embeddings.sort((a, b) => a.index - b.index);
  return embeddings.map((e) => e.embedding);
}
