export type MemoryV2Scope = "global" | "workspace";

export type MemoryV2Kind = "preference" | "fact" | "decision" | "lesson" | "state";

export type MemoryV2Status =
  | "active"
  | "archived"
  | "superseded"
  | "pending_conflict"
  | "pending_low_confidence"
  | "suspected_stale";

export type MemoryV2Confidence = "low" | "medium" | "high";

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
  kind: MemoryV2Kind;
  scope: MemoryV2Scope;
  status: MemoryV2Status;
  created: string;
  updated: string;
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
  kind: MemoryV2Kind;
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
  entities?: string[];
  appliesWhen?: Record<string, string>;
  claim?: MemoryV2Claim;
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
