export type MemoryV2Scope = "global" | "workspace";

export type MemoryV2ScopeInput = MemoryV2Scope | "auto";

export type MemoryV2Kind = "preference" | "fact" | "decision" | "lesson" | "state";

export type MemoryV2SemanticRole =
  | "identity"
  | "fact"
  | "preference"
  | "constraint"
  | "decision"
  | "lesson"
  | "state";

export type MemoryV2EvidenceType =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "external_file"
  | "manual"
  | "consolidation";

export interface MemoryV2EvidenceRef {
  type: MemoryV2EvidenceType;
  id?: string;
  runId?: string;
  threadId?: string;
  path?: string;
  quote?: string;
}

export type MemoryV2Status =
  | "active"
  | "archived"
  | "superseded"
  | "pending_conflict"
  | "pending_low_confidence"
  | "suspected_stale";

export type MemoryV2Confidence = "low" | "medium" | "high";

/**
 * 记忆激活开关：拆分原先被 overloaded 的 active 状态，按用途授权。
 * - recall: 召回（query/memory_read）
 * - persona: L3 Persona 注入
 * - suggestion: 主动建议
 * - analyst: 工作模式分析
 *
 * fail-open: 旧记忆无此字段时，readActivation 返回 DEFAULT_ACTIVATION（全 true）。
 */
export interface MemoryV2Activation {
  recall: boolean;
  persona: boolean;
  suggestion: boolean;
  analyst: boolean;
}

export const DEFAULT_ACTIVATION: MemoryV2Activation = {
  recall: true,
  persona: true,
  suggestion: true,
  analyst: true
};

export interface MemoryV2Source {
  type: "manual" | "micro_reflection" | "pre_compaction" | "run_completed" | "tool";
  run_id?: string;
  record_ids?: string[];
  path?: string;
}

export interface MemoryV2Claim {
  subject: string;
  predicate: string;
  object: string;
  qualifiers?: Record<string, string>;
}

export interface MemoryV2EntryFrontmatter {
  id: string;
  /** @deprecated Kept for one schema version while old files are normalized. */
  kind: MemoryV2Kind;
  semantic_role: MemoryV2SemanticRole;
  facets: string[];
  scope: MemoryV2Scope;
  status: MemoryV2Status;
  created: string;
  updated: string;
  last_confirmed_at: string;
  revision: number;
  source: MemoryV2Source;
  confidence: MemoryV2Confidence;
  pinned: boolean;
  tags: string[];
  entities: string[];
  related: string[];
  supersedes: string[];
  superseded_by: string | null;
  applies_when: Record<string, string>;
  valid_from: string | null;
  valid_to: string | null;
  claim?: MemoryV2Claim;
  /**
   * 按用途授权的激活开关。可选：旧记忆未写入时，readActivation fallback 全 true。
   * 新记忆由 writeEntry 自动写入 DEFAULT_ACTIVATION。
   */
  activation?: MemoryV2Activation;
  evidence_refs: MemoryV2EvidenceRef[];
}

export interface MemoryV2Entry {
  frontmatter: MemoryV2EntryFrontmatter;
  statement: string;
  path: string;
}

export type MemoryV2PendingType = "conflict" | "stale" | "low-confidence";

export interface MemoryV2PendingFrontmatter {
  id: string;
  type: MemoryV2PendingType;
  created: string;
  candidate: {
    kind: MemoryV2Kind;
    targetScope: MemoryV2Scope;
    statement: string;
    confidence?: MemoryV2Confidence;
    tags?: string[];
    entities?: string[];
    appliesWhen?: Record<string, string>;
    claim?: MemoryV2Claim;
  };
  existing?: {
    ids: string[];
  };
  reason: string;
  evidence?: {
    run_id?: string;
    record_ids?: string[];
  };
  status: "open" | "resolved" | "archived";
}

export interface MemoryV2PendingItem {
  frontmatter: MemoryV2PendingFrontmatter;
  body: string;
  path: string;
}

export interface MemoryV2Candidate {
  /** Compatibility hint only. The command service derives semanticRole. */
  kind?: MemoryV2Kind;
  semanticRole?: MemoryV2SemanticRole;
  targetScope: MemoryV2Scope;
  statement: string;
  confidence: MemoryV2Confidence;
  evidence?: {
    runId?: string;
    recordIds?: string[];
    sourceMessages?: string[];
    sourcePaths?: string[];
    quote?: string;
  };
  tags?: string[];
  facets?: string[];
  entities?: string[];
  appliesWhen?: Record<string, string>;
  claim?: MemoryV2Claim;
}

export type MemoryV2MutationActor =
  | "main_agent"
  | "background_extract"
  | "consolidation"
  | "user"
  | "migration";

export type MemoryV2MutationAction =
  | "created"
  | "updated"
  | "superseded"
  | "merged"
  | "archived"
  | "duplicate"
  | "pending"
  | "ignored";

export interface MemoryV2MutationReceipt {
  mutationId: string;
  actor: MemoryV2MutationActor;
  action: MemoryV2MutationAction;
  memoryIds: string[];
  runId?: string;
  threadId?: string;
  scope: MemoryV2Scope;
  revision?: number;
  summary: string;
  undoable: boolean;
  createdAt: string;
}

export type MemoryV2SmartAddAction =
  | "duplicate"
  | "related"
  | "mergeable"
  | "conflict"
  | "suspected_stale"
  | "low_confidence"
  | "new"
  | "suppressed";

export interface MemoryV2SmartAddResult {
  action: MemoryV2SmartAddAction;
  entry?: MemoryV2Entry;
  pending?: MemoryV2PendingItem;
  existingIds?: string[];
  reason: string;
}

export interface MemoryV2RecallItem {
  id: string;
  kind: MemoryV2Kind;
  scope: MemoryV2Scope;
  status: "active" | "suspected_stale";
  statement: string;
  path: string;
  citation: string;
  reason: string;
  score: number;
  pinned?: boolean;
  tags?: string[];
  claim?: MemoryV2Claim;
}
