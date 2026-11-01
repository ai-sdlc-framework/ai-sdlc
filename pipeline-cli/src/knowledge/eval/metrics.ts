/** Ranking metrics for the RFC-0053 evaluation corpus (OQ-5). Relevance is graded: id -> grade (> 0). */
export type Judgments = ReadonlyMap<string, number>;

export function recallAtK(ranked: string[], rel: Judgments, k: number): number {
  if (rel.size === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const id of rel.keys()) if (top.has(id)) hit++;
  return hit / rel.size;
}

/** Reciprocal rank of the first relevant result, 0 when none is returned. */
export function reciprocalRank(ranked: string[], rel: Judgments): number {
  const i = ranked.findIndex((id) => rel.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function ndcgAtK(ranked: string[], rel: Judgments, k: number): number {
  const dcg = (grades: number[]): number => grades.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const gain = ranked.slice(0, k).map((id) => rel.get(id) ?? 0);
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(gain) / idcg;
}
