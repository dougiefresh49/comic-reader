import type { Embedding } from "./clip-embeddings.js";

export interface Cluster {
  id: number;
  memberIndices: number[];
}

export function cosineDistance(a: Embedding, b: Embedding): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

export function distanceStats(embeddings: Embedding[]): {
  min: number;
  max: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
} {
  const dists: number[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      dists.push(cosineDistance(embeddings[i]!, embeddings[j]!));
    }
  }
  dists.sort((a, b) => a - b);
  const pct = (p: number) => dists[Math.floor(dists.length * p)] ?? 0;
  return {
    min: dists[0] ?? 0,
    max: dists[dists.length - 1] ?? 0,
    median: pct(0.5),
    p10: pct(0.1),
    p25: pct(0.25),
    p75: pct(0.75),
    p90: pct(0.9),
  };
}

export function dbscan(
  embeddings: Embedding[],
  eps: number = 0.3,
  minPts: number = 2,
): { clusters: Cluster[]; noise: number[] } {
  const n = embeddings.length;
  const labels = new Int32Array(n).fill(-1); // -1 = unvisited
  const NOISE = -2;
  let clusterId = 0;

  const distMatrix: number[][] = [];
  for (let i = 0; i < n; i++) {
    distMatrix[i] = [];
    for (let j = 0; j < n; j++) {
      distMatrix[i]![j] =
        i === j ? 0 : cosineDistance(embeddings[i]!, embeddings[j]!);
    }
  }

  function regionQuery(idx: number): number[] {
    const neighbors: number[] = [];
    for (let j = 0; j < n; j++) {
      if (distMatrix[idx]![j]! <= eps) neighbors.push(j);
    }
    return neighbors;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;

    const neighbors = regionQuery(i);
    if (neighbors.length < minPts) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = clusterId;
    const seed = new Set(neighbors);
    seed.delete(i);
    const queue = [...seed];

    while (queue.length > 0) {
      const q = queue.shift()!;
      if (labels[q] === NOISE) {
        labels[q] = clusterId;
      }
      if (labels[q] !== -1) continue;
      labels[q] = clusterId;

      const qNeighbors = regionQuery(q);
      if (qNeighbors.length >= minPts) {
        for (const nb of qNeighbors) {
          if (!seed.has(nb)) {
            seed.add(nb);
            queue.push(nb);
          }
        }
      }
    }

    clusterId++;
  }

  const clusters: Cluster[] = [];
  const noise: number[] = [];
  const clusterMap = new Map<number, number[]>();

  for (let i = 0; i < n; i++) {
    const label = labels[i]!;
    if (label === NOISE) {
      noise.push(i);
    } else {
      if (!clusterMap.has(label)) clusterMap.set(label, []);
      clusterMap.get(label)!.push(i);
    }
  }

  for (const [id, members] of clusterMap) {
    clusters.push({ id, memberIndices: members });
  }

  clusters.sort((a, b) => b.memberIndices.length - a.memberIndices.length);

  return { clusters, noise };
}
