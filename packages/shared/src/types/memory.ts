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
  INDEX_WORKSPACE: "memory:index-workspace",
  INDEX_FILE: "memory:index-file",
  SEARCH: "memory:search",
  STATS: "memory:stats",
  GET: "memory:get",
  SAVE: "memory:save",
  STATUS: "memory:status"
} as const;
