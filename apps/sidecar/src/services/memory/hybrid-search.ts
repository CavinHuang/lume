import {
  DEFAULT_TEXT_WEIGHT,
  DEFAULT_VECTOR_WEIGHT
} from "./constants";
import type {
  MergeHybridResultsParams,
  MergedHybridResult
} from "./types";

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .match(/[A-Za-z0-9_]+/g)
    ?.map((token) => token.trim())
    .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;

  const quoted = tokens.map((token) => `"${token.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function mergeHybridResults(params: Partial<MergeHybridResultsParams> & {
  vector: MergeHybridResultsParams["vector"];
  keyword: MergeHybridResultsParams["keyword"];
}): MergedHybridResult[] {
  const vectorWeight = params.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const textWeight = params.textWeight ?? DEFAULT_TEXT_WEIGHT;

  const byId = new Map<string, MergedHybridResult>();

  for (const result of params.vector) {
    byId.set(result.id, {
      ...result,
      vectorScore: result.score,
      textScore: 0,
      source: "vector",
      score: result.score
    });
  }

  for (const result of params.keyword) {
    const existing = byId.get(result.id);
    if (existing) {
      existing.textScore = result.score;
      existing.source = "hybrid";
      continue;
    }

    byId.set(result.id, {
      ...result,
      vectorScore: 0,
      textScore: result.score,
      source: "text",
      score: result.score
    });
  }

  const merged: MergedHybridResult[] = [];
  for (const result of byId.values()) {
    merged.push({
      ...result,
      score: vectorWeight * result.vectorScore + textWeight * result.textScore,
      source: result.vectorScore > 0 && result.textScore > 0 ? "hybrid" : result.source
    });
  }

  return merged.sort((a, b) => b.score - a.score);
}
