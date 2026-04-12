export interface MemoryChunkRecord {
  id: string;
  path: string;
  workspaceSlug: string;
  source: "memory" | "session";
  startLine: number;
  endLine: number;
  hash: string;
  model: string;
  text: string;
  updatedAt: number;
}

export interface MemorySearchInput {
  workspaceSlug: string;
  query: string;
  maxResults?: number;
  minScore?: number;
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  citation?: string;
  score: number;
  source: "memory" | "sessions";
}

export interface MemoryGetInput {
  workspaceSlug: string;
  path: string;
  from?: number;
  lines?: number;
}

export interface MemoryGetResult {
  path: string;
  from: number;
  lines: number;
  text: string;
}

export interface MemorySaveInput {
  workspaceSlug: string;
  content: string;
  /** 指定写入路径，如 "MEMORY.md" 表示 workspace 长期记忆；省略则写入 memory/YYYY-MM-DD.md */
  path?: string;
  date?: string;
}

export interface MemorySaveResult {
  path: string;
  bytes: number;
}

export interface MemoryIndexWorkspaceInput {
  workspaceSlug: string;
  force?: boolean;
}

export interface MemoryIndexFileInput {
  workspaceSlug: string;
  filePath: string;
  force?: boolean;
}

export interface MemoryStats {
  fileCount: number;
  chunkCount: number;
  workspaceSlug: string;
  ftsEnabled: boolean;
  vecEnabled: boolean;
}

export interface MemoryDistillationResult {
  workspaceSlug: string;
  updatedWorkspaceMemory: boolean;
  promotedToGlobal: string[];
}

export interface MemoryProviderStatus {
  backend?: "builtin" | "qmd";
  provider: string;
  model: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  sources?: Array<"memory" | "sessions">;
  extraPaths?: string[];
  sourceCounts?: Array<{ source: "memory" | "sessions"; files: number; chunks: number }>;
  fallback?: {
    from?: string;
    reason?: string;
  };
  ftsEnabled: boolean;
  vecEnabled: boolean;
}

export const MEMORY_IPC_CHANNELS = {
  INDEX_CORPUS: "memory:index-corpus",
  INDEX_DOCUMENT: "memory:index-document",
  SEARCH_LAYERED: "memory:search-layered",
  READ_LAYERED: "memory:read-layered",
  WRITE_WORKSPACE: "memory:write-workspace",
  STATUS_LAYERED: "memory:status-layered",
  STATS_LAYERED: "memory:stats-layered",
  DISTILL_WORKSPACE: "memory:distill-workspace"
} as const;
