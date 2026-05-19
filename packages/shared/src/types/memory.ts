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
  | "manual";

export type MemoryToolName =
  | "memory.search"
  | "memory.read"
  | "memory.remember";

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
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  citation?: string;
  score: number;
  kind?: MemoryKind;
  scope?: MemoryScope;
  source: MemorySource;
  reason?: string;
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
}

export interface UpdateMemoryRuntimeConfigInput {
  tools?: MemoryToolPolicy;
  citations?: MemoryCitationsMode;
  sources?: MemorySourceMode[];
  extraPaths?: string[];
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
}

export interface MemoryOpenSourceInput {
  workspaceSlug: string;
  path: string;
}

export const MEMORY_IPC_CHANNELS = {
  SEARCH: "memory:search",
  READ: "memory:read",
  REMEMBER: "memory:remember",
  SETTINGS_SNAPSHOT: "memory:settings-snapshot",
  OPEN_SOURCE: "memory:open-source",
  GET_RUNTIME_CONFIG: "memory:get-runtime-config",
  UPDATE_RUNTIME_CONFIG: "memory:update-runtime-config"
} as const;
