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

export type MemoryScope =
  | "global"
  | "workspace"
  | "agent"
  | "session";

export type MemoryKind =
  | "raw"
  | "summary"
  | "fact"
  | "preference"
  | "decision"
  | "episode"
  | "lesson"
  | "milestone"
  | "artifact";

export type MemorySource =
  | "memory"
  | "sessions"
  | "session"
  | "file"
  | "tool"
  | "manual"
  | "flush"
  | "distillation"
  | "promotion";

export type MemorySearchStrategy =
  | "hybrid"
  | "keyword"
  | "vector"
  | "recent";

export type MemoryToolName =
  | "memory.search"
  | "memory.read"
  | "memory.remember"
  | "memory.update"
  | "memory.invalidate"
  | "memory.forget"
  | "memory.writeEpisode"
  | "memory.flush"
  | "memory.distillWorkspace"
  | "memory.summarizeWorkspace"
  | "memory.searchGlobal"
  | "memory.listGlobalCandidates"
  | "memory.promoteGlobal"
  | "memory.rejectGlobalCandidate"
  | "memory.status"
  | "memory.indexWorkspace"
  | "memory.indexDocument"
  | "memory.audit"
  | "memory.findConflicts";

export interface MemoryItem {
  id: string;
  workspaceSlug: string;

  scope: MemoryScope;
  kind: MemoryKind;
  source: MemorySource;

  title?: string;
  content: string;
  summary?: string;

  sourcePath?: string;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceToolCallId?: string;

  tags?: string[];
  entities?: string[];
  topics?: string[];

  importance: 1 | 2 | 3 | 4 | 5;
  confidence: number;

  validFrom?: number;
  validTo?: number;
  supersedes?: string;
  supersededBy?: string;
  promotedFrom?: {
    workspaceSlug: string;
    memoryIds: string[];
    reason: string;
  };

  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchInput {
  workspaceSlug: string;
  query: string;
  maxResults?: number;
  minScore?: number;
  scopes?: MemoryScope[];
  kinds?: MemoryKind[];
  sources?: MemorySource[];
  includeGlobal?: boolean;
  includeRecent?: boolean;
  includeLongTerm?: boolean;
  includeWorkspaceBrief?: boolean;
  includeSessions?: boolean;
  strategy?: MemorySearchStrategy;
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  citation?: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  recencyScore?: number;
  importanceScore?: number;
  kind?: MemoryKind;
  scope?: MemoryScope;
  source: MemorySource;
  reason?: string;
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

export interface MemoryReadToolInput {
  workspaceSlug: string;
  id?: string;
  path?: string;
  from?: number;
  lines?: number;
}

export interface MemoryReadToolResult {
  id?: string;
  path?: string;
  text: string;
  metadata?: Partial<MemoryItem>;
  citation?: string;
}

export interface MemorySaveInput {
  workspaceSlug: string;
  content: string;
  /** 指定写入路径，如 "MEMORY.md" 表示 workspace 长期记忆；省略则写入 memory/YYYY-MM-DD.md */
  path?: string;
  date?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  source?: MemorySource;
  title?: string;
  summary?: string;
  tags?: string[];
  entities?: string[];
  topics?: string[];
  importance?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceToolCallId?: string;
  writeMode?: "append" | "upsert" | "replace-section";
  requireReview?: boolean;
}

export interface MemorySaveResult {
  path: string;
  bytes: number;
  itemId?: string;
}

export interface MemorySearchToolInput extends MemorySearchInput {
  includeWorkspace?: boolean;
  sessionType?: "main" | "subagent" | "group" | "channel";
}

export interface MemoryRememberToolInput {
  workspaceSlug: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  title?: string;
  importance?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  tags?: string[];
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  requireReview?: boolean;
}

export interface MemoryWriteEpisodeInput {
  workspaceSlug: string;
  sessionId: string;
  title: string;
  summary: string;
  outcomes?: string[];
  decisions?: string[];
  preferences?: string[];
  lessons?: string[];
  nextSteps?: string[];
  sourceMessageIds?: string[];
}

export interface MemoryFlushToolInput {
  workspaceSlug: string;
  sessionId: string;
  entries: Array<{
    kind: "episode" | "decision" | "preference" | "fact" | "lesson";
    title?: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
    tags?: string[];
    sourceMessageIds?: string[];
  }>;
}

export interface MemoryToolWriteResult {
  id?: string;
  path?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
}

export interface MemoryWriteEpisodeResult {
  savedCount: number;
  skippedCount: number;
  itemIds: string[];
}

export interface MemoryDistillWorkspaceToolInput {
  workspaceSlug: string;
  days?: number;
  dryRun?: boolean;
  updateWorkspaceBrief?: boolean;
  generateGlobalCandidates?: boolean;
}

export interface MemorySearchGlobalToolInput {
  query: string;
  maxResults?: number;
}

export interface MemoryListGlobalCandidatesToolInput {
  status?: GlobalMemoryCandidate["status"];
}

export interface MemoryRejectGlobalCandidateToolInput {
  candidateId: string;
}

export interface MemoryIndexDocumentToolInput {
  workspaceSlug: string;
  filePath: string;
  force?: boolean;
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
  createdItems?: number;
  updatedItems?: number;
  skippedItems?: number;
  invalidatedItems?: number;
  updatedWorkspaceBrief?: boolean;
  scannedFiles?: number;
  candidateItems?: number;
  globalCandidateCount?: number;
  preview?: string;
}

export interface MemoryDistillInput {
  workspaceSlug: string;
  days?: number;
  dryRun?: boolean;
  updateWorkspaceBrief?: boolean;
  generateGlobalCandidates?: boolean;
}

export interface GlobalMemoryCandidate {
  id: string;
  workspaceSlug: string;
  memoryIds: string[];
  kind: MemoryKind;
  title?: string;
  content: string;
  reason: string;
  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;
  status: "pending" | "approved" | "rejected" | "ignored";
  createdAt: number;
  updatedAt: number;
}

export interface PromoteGlobalMemoryInput {
  candidateId: string;
  approve: boolean;
  editedContent?: string;
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
  DISTILL_WORKSPACE: "memory:distill-workspace",
  LIST_GLOBAL_CANDIDATES: "memory:list-global-candidates",
  PROMOTE_GLOBAL: "memory:promote-global",
  REJECT_GLOBAL_CANDIDATE: "memory:reject-global-candidate",
  SEARCH_GLOBAL: "memory:search-global",
  STATUS_GLOBAL: "memory:status-global"
} as const;
