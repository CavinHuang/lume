/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/manager-search.ts
 * Adaptation:
 * - Keep Bun sqlite API style used in Lume sidecar.
 */

import { Database } from "bun:sqlite";

export interface KeywordSearchRow {
  id: string;
  path: string;
  source?: string;
  start_line: number;
  end_line: number;
  text: string;
  rank?: number;
}

export interface VectorSearchRow {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  text: string;
  dist: number;
}

export interface DenseFallbackRow {
  id: string;
  path: string;
  source?: string;
  start_line: number;
  end_line: number;
  text: string;
  embedding?: string;
}

export function searchKeywordRows(params: {
  db: Database;
  query: string;
  candidates: number;
  sourceFilter: { sql: string; params: string[] };
}): KeywordSearchRow[] {
  return params.db
    .query(
      `SELECT id, path, source, start_line, end_line, text, bm25(chunks_fts) AS rank
       FROM chunks_fts
       WHERE chunks_fts MATCH ?${params.sourceFilter.sql}
       ORDER BY rank
       LIMIT ?`
    )
    .all(params.query, ...params.sourceFilter.params, params.candidates) as KeywordSearchRow[];
}

export function searchVectorRows(params: {
  db: Database;
  queryEmbeddingBlob: Buffer;
  workspaceSlug: string;
  model: string;
  candidates: number;
  sourceFilter: { sql: string; params: string[] };
}): VectorSearchRow[] {
  return params.db
    .query(
      `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text,
              vec_distance_cosine(v.embedding, ?) AS dist
       FROM chunks_vec v
       JOIN chunks c ON c.id = v.id
       WHERE c.workspace_slug = ? AND c.model = ?${params.sourceFilter.sql}
       ORDER BY dist ASC
       LIMIT ?`
    )
    .all(
      params.queryEmbeddingBlob,
      params.workspaceSlug,
      params.model,
      ...params.sourceFilter.params,
      params.candidates
    ) as VectorSearchRow[];
}

export function searchDenseFallbackRows(params: {
  db: Database;
  workspaceSlug: string;
  candidates: number;
  sourceFilter: { sql: string; params: string[] };
}): DenseFallbackRow[] {
  return params.db
    .query(
      `SELECT id, path, source, start_line, end_line, text, embedding
       FROM chunks
       WHERE workspace_slug = ?${params.sourceFilter.sql}
       LIMIT ?`
    )
    .all(params.workspaceSlug, ...params.sourceFilter.params, params.candidates * 4) as DenseFallbackRow[];
}
