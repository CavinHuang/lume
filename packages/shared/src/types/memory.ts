import type { FileRef } from "./agent";

export type MemoryScope =
  | "global"
  | "workspace";

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
  | "manual";

export type MemoryToolName =
  | "memory.search"
  | "memory.read"
  | "memory.remember";

export interface MemoryClaim {
  subject: string;
  predicate: string;
  object: string;
  qualifiers?: Record<string, string>;
}

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
  claim?: MemoryClaim;

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
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  citation?: string;
  fileRef?: FileRef;
  score: number;
  kind?: MemoryKind;
  scope?: MemoryScope;
  source: MemorySource;
  reason?: string;
  claim?: MemoryClaim;
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
  fileRef?: FileRef;
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
  claim?: MemoryClaim;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  requireReview?: boolean;
}

export interface MemoryToolWriteResult {
  id?: string;
  path?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
}

export type MemoryCitationsMode = "on" | "off" | "auto";
export type MemorySourceMode = "memory" | "sessions";

export interface MemoryToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface MemoryRuntimeConfig {
  version: number;
  tools: MemoryToolPolicy;
  citations: MemoryCitationsMode;
  sources: MemorySourceMode[];
  extraPaths: string[];
  retrieval: MemoryRetrievalConfig;
}

export interface UpdateMemoryRuntimeConfigInput {
  tools?: MemoryToolPolicy;
  citations?: MemoryCitationsMode;
  sources?: MemorySourceMode[];
  extraPaths?: string[];
  retrieval?: Partial<MemoryRetrievalConfig>;
}

export interface MemoryOrganizeHistoryInput {
  workspaceSlug: string;
  limit?: number;
}

export type MemoryOrganizeHistoryAction =
  | "duplicate"
  | "related"
  | "mergeable"
  | "conflict"
  | "suspected_stale"
  | "low_confidence"
  | "new"
  | "suppressed";

export type MemoryOrganizeHistoryActionCounts = Record<MemoryOrganizeHistoryAction, number>;

export interface MemoryOrganizeHistoryItem {
  sourcePath: string;
  sourceMessageId?: string;
  statement: string;
  scope: "global" | "workspace";
  kind: "preference" | "fact" | "decision" | "lesson" | "state";
  confidence: "low" | "medium" | "high";
  action: MemoryOrganizeHistoryAction;
  reason: string;
  entryId?: string;
  pendingId?: string;
}

export interface MemoryOrganizeHistoryResult {
  workspaceSlug: string;
  scannedSources: number;
  scannedMessages: number;
  candidateCount: number;
  actions: MemoryOrganizeHistoryActionCounts;
  items: MemoryOrganizeHistoryItem[];
}

export interface MemoryOrganizeEntriesInput {
  workspaceSlug: string;
}

export interface MemoryOrganizeEntriesItem {
  keptId: string;
  duplicateId: string;
  scope: "global" | "workspace";
  statement: string;
  duplicateStatement: string;
  action: "superseded_duplicate";
  reason: string;
}

export interface MemoryOrganizeEntriesResult {
  workspaceSlug: string;
  scannedEntries: number;
  keptEntries: number;
  supersededDuplicates: number;
  items: MemoryOrganizeEntriesItem[];
}

export type MemoryOrganizeJobKind = "history" | "entries";

export type MemoryOrganizeJobStatus = "running" | "completed" | "failed";

export interface MemoryOrganizeProgress {
  label: string;
  scannedItems: number;
  processedItems: number;
  scannedBatches?: number;
  processedBatches?: number;
  candidateCount?: number;
}

export interface MemoryStartOrganizeJobResult {
  jobId: string;
  kind: MemoryOrganizeJobKind;
  workspaceSlug: string;
  status: "running";
  startedAt: number;
}

export interface MemoryOrganizeJobInput {
  jobId: string;
}

export interface MemoryOrganizeJob {
  jobId: string;
  kind: MemoryOrganizeJobKind;
  workspaceSlug: string;
  status: MemoryOrganizeJobStatus;
  startedAt: number;
  completedAt?: number;
  progress?: MemoryOrganizeProgress;
  result?: MemoryOrganizeHistoryResult | MemoryOrganizeEntriesResult;
  error?: string;
}

export type MemoryIngestSourceInput =
  | {
    kind: "pasted_text";
    title?: string;
    content: string;
    targetScope?: "global" | "workspace";
  }
  | {
    kind: "workspace_file";
    path: string;
    targetScope?: "global" | "workspace";
  }
  | {
    kind: "local_file";
    path: string;
    targetScope?: "global" | "workspace";
  }
  | {
    kind: "local_folder";
    path: string;
    targetScope?: "global" | "workspace";
  };

export interface MemoryIngestSourcesInput {
  workspaceSlug: string;
  sources: MemoryIngestSourceInput[];
  batchMaxChars?: number;
}

export interface MemoryIngestSourcesItem {
  sourcePath: string;
  sourceId?: string;
  statement: string;
  scope?: "global" | "workspace";
  kind?: "preference" | "fact" | "decision" | "lesson" | "state";
  confidence?: "low" | "medium" | "high";
  action: MemoryOrganizeHistoryAction;
  reason: string;
  entryId?: string;
  pendingId?: string;
}

export interface MemoryIngestSourcesResult {
  workspaceSlug: string;
  scannedSources: number;
  scannedChunks: number;
  scannedBatches: number;
  candidateCount: number;
  actions: MemoryOrganizeHistoryActionCounts;
  items: MemoryIngestSourcesItem[];
}

export type MemoryIngestSourcesJobStatus = "running" | "completed" | "failed";

export interface MemoryStartIngestSourcesResult {
  jobId: string;
  workspaceSlug: string;
  status: "running";
  startedAt: number;
}

export interface MemoryIngestSourcesJobInput {
  jobId: string;
}

export interface MemoryIngestSourcesProgress {
  scannedSources: number;
  scannedChunks: number;
  scannedBatches: number;
  processedBatches: number;
  candidateCount: number;
}

export interface MemoryIngestSourcesJob {
  jobId: string;
  workspaceSlug: string;
  status: MemoryIngestSourcesJobStatus;
  startedAt: number;
  completedAt?: number;
  progress?: MemoryIngestSourcesProgress;
  result?: MemoryIngestSourcesResult;
  error?: string;
}

export type MemorySemanticMode = "auto" | "off";

export interface MemoryRetrievalConfig {
  semantic: MemorySemanticMode;
  rerankModelRef?: string;
}

export interface MemorySettingsFileSummary {
  path: string;
  label: string;
  kind: "memory" | "daily" | "run";
  scope: "global" | "workspace";
  updatedAt?: number;
}

export interface MemorySettingsEntrySummary {
  id: string;
  path: string;
  scope: "global" | "workspace";
  kind: MemoryKind;
  status: "active" | "suspected_stale" | "archived" | "superseded" | "pending_conflict" | "pending_low_confidence";
  confidence: "low" | "medium" | "high";
  statement: string;
  updated: string;
  pinned: boolean;
  tags: string[];
  claim?: MemoryClaim;
}

export interface MemorySettingsPendingCandidateSummary {
  scope: "global" | "workspace";
  kind: MemoryKind;
  confidence: "low" | "medium" | "high";
  statement: string;
  tags: string[];
  claim?: MemoryClaim;
}

export interface MemorySettingsPendingSummary {
  id: string;
  path: string;
  type: "conflict" | "stale" | "low-confidence";
  status: "open" | "resolved" | "archived";
  created: string;
  statement: string;
  reason: string;
  existingIds: string[];
  candidate: MemorySettingsPendingCandidateSummary;
  existingEntries: MemorySettingsEntrySummary[];
}

export interface MemoryUpdateEntryInput {
  workspaceSlug: string;
  scope: "global" | "workspace";
  id: string;
  statement?: string;
  kind?: MemoryKind;
  confidence?: "low" | "medium" | "high";
  tags?: string[];
}

export interface MemoryDeleteEntryInput {
  workspaceSlug: string;
  scope: "global" | "workspace";
  id: string;
}

export interface MemoryResolvePendingInput {
  workspaceSlug: string;
  path: string;
  action: "accept" | "reject" | "resolve";
  candidateOverride?: {
    statement?: string;
    kind?: MemoryKind;
    confidence?: "low" | "medium" | "high";
    tags?: string[];
  };
}

export interface MemoryMutationResult {
  ok: true;
  id: string;
  path: string;
  entryId?: string;
  entryPath?: string;
}

export interface MemoryPendingCounts {
  conflicts: number;
  stale: number;
  lowConfidence: number;
  total: number;
}

export interface MemorySettingsSnapshot {
  workspaceSlug: string;
  counts: {
    active: number;
    workspace: number;
    global: number;
    suspectedStale: number;
    pinned: number;
    daily: number;
    runs: number;
    pending: MemoryPendingCounts;
  };
  files: MemorySettingsFileSummary[];
  workspaceEntries: MemorySettingsEntrySummary[];
  globalEntries: MemorySettingsEntrySummary[];
  pending: MemorySettingsPendingSummary[];
  extraction: {
    modelRef?: string;
    source: "configured" | "disabled";
    message: string;
  };
  retrieval: MemorySettingsRetrievalStatus;
}

export const MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF = "local-onnx/Xenova/bge-small-zh-v1.5";
export const MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL = "本地 ONNX bge-small-zh";

export interface MemorySettingsRetrievalStatus {
  semantic: {
    mode: MemorySemanticMode;
    embeddingModelRef?: string;
    fallbackModelRef?: string;
    status: "disabled" | "not_configured" | "available" | "stale" | "failed";
    message: string;
    localOnnx?: {
      modelRef: string;
      label: string;
      status: "not_cached" | "cached" | "downloading" | "initializing" | "ready" | "failed";
      cacheDir: string;
      message: string;
      error?: string;
    };
  };
  rerank: {
    modelRef?: string;
    source: "explicit" | "extraction" | "disabled";
  };
}

export interface MemoryOpenSourceInput {
  workspaceSlug: string;
  path: string;
}

export interface MemorySourceFile {
  ref: FileRef;
  size?: number;
  modifiedAt?: string;
}

export interface MemoryListSourceFilesInput {
  workspaceSlug: string;
  cursor?: string;
  limit?: number;
}

export interface MemorySourceFilesPage {
  entries: MemorySourceFile[];
  nextCursor?: string;
}

export const MEMORY_IPC_CHANNELS = {
  SEARCH: "memory:search",
  READ: "memory:read",
  REMEMBER: "memory:remember",
  SETTINGS_SNAPSHOT: "memory:settings-snapshot",
  ORGANIZE_HISTORY: "memory:organize-history",
  ORGANIZE_ENTRIES: "memory:organize-entries",
  GET_ORGANIZE_JOB: "memory:get-organize-job",
  INGEST_SOURCES: "memory:ingest-sources",
  GET_INGEST_JOB: "memory:get-ingest-job",
  LIST_SOURCE_FILES: "memory:list-source-files",
  SOURCE_FILES_CHANGED: "memory:source-files-changed",
  OPEN_SOURCE: "memory:open-source",
  UPDATE_ENTRY: "memory:update-entry",
  DELETE_ENTRY: "memory:delete-entry",
  RESOLVE_PENDING: "memory:resolve-pending",
  GET_RUNTIME_CONFIG: "memory:get-runtime-config",
  UPDATE_RUNTIME_CONFIG: "memory:update-runtime-config",
  RELOAD_LOCAL_ONNX: "memory:reload-local-onnx"
} as const;
