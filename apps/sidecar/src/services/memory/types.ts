export interface ChunkingConfig {
  tokens: number;
  overlap: number;
  model: string;
}

export interface MemoryChunk {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  hash: string;
  model: string;
}

export interface HybridSearchResult {
  id: string;
  score: number;
  path?: string;
  text?: string;
  startLine?: number;
  endLine?: number;
}

export interface MergeHybridResultsParams {
  vector: HybridSearchResult[];
  keyword: HybridSearchResult[];
  vectorWeight: number;
  textWeight: number;
}

export interface MergedHybridResult extends HybridSearchResult {
  vectorScore: number;
  textScore: number;
  source: "vector" | "text" | "hybrid";
}
