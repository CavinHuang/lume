export const WIKI_SCHEMA_VERSION = 1 as const;

export type WikiPageType = "source" | "topic" | "decision" | "synthesis";
export type WikiPageStatus = "active" | "archived" | "trashed";
export type WikiCaptureMode = "snapshotted" | "extracted_only" | "external_only";
export type WikiSourceLifecycleState = "active" | "trashed" | "purged";
export type WikiSourceKind = "text" | "url" | "webfetch_asset" | "file" | "workspace_file" | "chat" | "reading_note" | "memory_entry";
export type WikiBlockOwner = "agent" | "user";
export type WikiDraftRisk = "low" | "high";

export interface WikiWorkspaceSnapshot {
  id: string;
  name: string;
  slug: string;
}

export interface WikiPageFrontmatter {
  schema_version: typeof WIKI_SCHEMA_VERSION;
  id: string;
  file_key: string;
  type: WikiPageType;
  title: string;
  primary_workspace_id: string | null;
  primary_workspace_snapshot: WikiWorkspaceSnapshot | null;
  associated_workspace_ids: string[];
  status: WikiPageStatus;
  aliases: string[];
  tags: string[];
  source_ids: string[];
  created: string;
  updated: string;
  revision: number;
  protected?: boolean;
}

export interface WikiPageRef {
  id: string;
  fileKey: string;
  title: string;
  type: WikiPageType;
  status: WikiPageStatus;
  primaryWorkspaceId: string | null;
  associatedWorkspaceIds: string[];
  path?: string;
}

export interface WikiCaptureScopeSnapshot {
  workspaceId?: string;
  threadId?: string;
  chatType?: "direct" | "group" | "channel";
  capturedBy: "desktop_owner" | "agent" | "im";
}

export interface WikiSourceLocator {
  url?: string;
  filePath?: string;
  workspaceId?: string;
  threadId?: string;
  messageId?: string;
  versionGroupId?: string;
  versionIndex?: number;
  externalMessageId?: string;
  readingNoteId?: string;
  memoryEntryId?: string;
}

export interface WikiSourceManifest {
  schema_version: typeof WIKI_SCHEMA_VERSION;
  id: string;
  kind: WikiSourceKind;
  title: string;
  capture_mode: WikiCaptureMode;
  capture_scope_snapshot: WikiCaptureScopeSnapshot;
  locator: WikiSourceLocator;
  blob_hash?: string;
  content_hash: string;
  byte_size: number;
  media_type: string;
  captured_at: string;
  warnings: string[];
}

export interface WikiSourceRef {
  id: string;
  kind: WikiSourceKind;
  title: string;
  captureMode: WikiCaptureMode;
  lifecycleState: WikiSourceLifecycleState;
  blobHash?: string;
  restricted?: boolean;
  warning?: string;
  /** 仅在 provenance grant 通过后返回；受限来源永不包含。 */
  content?: string;
}

export type WikiSearchScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "page"; pageId: string }
  | { kind: "inbox" }
  | { kind: "all" };

export interface WikiTrustedSubject {
  kind: "desktop_owner" | "desktop_agent" | "im";
  subjectId: string;
  workspaceIds: string[];
  allowInbox: boolean;
  allowAll: boolean;
}

export interface WikiAccessGrant {
  id: string;
  sourceId: string;
  workspaceId: string;
  action: "grant" | "revoke";
  actor: string;
  createdAt: string;
}

export interface WikiPageRecord extends WikiPageRef {
  frontmatter: WikiPageFrontmatter;
  markdown: string;
  body: string;
  hash: string;
  revision: number;
  protected: boolean;
}

export interface WikiSearchInput {
  query: string;
  scope: WikiSearchScope;
  maxResults?: number;
}

export interface WikiSearchResult {
  page: WikiPageRef;
  snippet: string;
  score: number;
  matchedBy: Array<"title" | "alias" | "lexical" | "link" | "semantic">;
}

export interface WikiReadInput {
  pageId: string;
  scope: WikiSearchScope;
}

export interface WikiReadResult {
  page: WikiPageRecord;
  sources: WikiSourceRef[];
  links: WikiPageRef[];
  backlinks: WikiPageRef[];
}

export interface WikiFollowLinksInput {
  pageId: string;
  scope: WikiSearchScope;
  depth?: number;
}

export interface WikiDiff {
  pageId: string;
  path: string;
  previousPath?: string;
  beforeHash: string | null;
  afterHash: string | null;
  preview: string;
}

export interface WikiBlockPatch {
  blockId: string;
  expectedContentHash: string;
  action: "update" | "delete";
  content?: string;
}

export type WikiContentMutation =
  | { kind: "block_patch"; patches: WikiBlockPatch[] }
  | { kind: "replace_page" };

export interface WikiDraftOperation {
  kind: "create" | "update" | "move" | "delete";
  pageId: string;
  beforeHash: string | null;
  targetRelativePath: string;
  previousRelativePath?: string;
  markdown?: string;
  contentMutation?: WikiContentMutation;
}

export interface WikiDraftCreator {
  subjectId: string;
  threadId?: string;
  profile: "owner-ui" | "ask-wiki" | "ordinary-agent" | "system";
  scope: WikiSearchScope;
  channel: "ui" | "agent" | "import" | "lifecycle" | "undo";
}

export interface WikiStagedSource {
  manifest: WikiSourceManifest;
  payloadRelativePath?: string;
  grants: string[];
}

export interface WikiChangeDraft {
  id: string;
  revision: number;
  nonce: string;
  creator: WikiDraftCreator;
  expiresAt: string;
  origin: "ui" | "import" | "agent" | "lint" | "undo";
  risk: WikiDraftRisk;
  riskReasons: string[];
  title: string;
  operations: WikiDraftOperation[];
  sources: WikiStagedSource[];
  diffs: WikiDiff[];
  pageVisibilityWorkspaceIds: string[];
  sourceGrantWorkspaceIds: string[];
  undoOfBatchId?: string;
  privacyPurgeSourceIds?: string[];
}

export type WikiPrivacySelector =
  | { kind: "source"; sourceId: string }
  | { kind: "page"; pageId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "message"; threadId: string; messageId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "content_hash"; contentHash: string };

export interface WikiPrivacyImpactPreview {
  selector: WikiPrivacySelector;
  sourceIds: string[];
  pageIds: string[];
  sharedPayloads: Array<{ blobHash: string; selectedSourceIds: string[]; retainedSourceIds: string[] }>;
  stagingDraftIds: string[];
  snapshotBatchIds: string[];
  requiresSharedPayloadConfirmation: boolean;
}

export interface WikiCreatePrivacyPurgeDraftInput {
  selector: WikiPrivacySelector;
  confirmSharedPayloads?: boolean;
}

export interface WikiProposalOperationSummaryV1 {
  kind: WikiDraftOperation["kind"];
  contentMutationKind?: WikiContentMutation["kind"];
  pageId: string;
  beforeHash: string | null;
  targetRelativePath: string;
}

export interface WikiProposalSummaryV1 {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  expiresAt: string;
  risk: WikiDraftRisk;
  reasons: string[];
  title: string;
  operationSummaries: WikiProposalOperationSummaryV1[];
  boundedDiffPreviews: Array<{ pageId: string; path: string; preview: string }>;
  diffHash: string;
}

export interface WikiBatch {
  id: string;
  draftId: string;
  state: "prepared" | "applying" | "committed" | "failed" | "undone";
  fencingToken: number;
  revision: number;
  actor: string;
  origin: WikiChangeDraft["origin"];
  risk: WikiDraftRisk;
  createdAt: string;
  committedAt?: string;
  diffs: WikiDiff[];
  affectedPageIds: string[];
  irreversible?: boolean;
  error?: string;
}

export interface WikiPendingReview {
  id: string;
  draft: WikiChangeDraft;
  createdAt: string;
  reason: string;
  /** 外部编辑冲突需要用户重新生成草案，不能直接接受旧 diff。 */
  requiresRegeneration?: boolean;
}

export interface WikiHistoryVersion {
  batchId: string;
  pageId: string;
  revision: number;
  hash: string;
  createdAt: string;
}

export type WikiLintSeverity = "info" | "warning" | "error";
export interface WikiLintFinding {
  id: string;
  rule: string;
  severity: WikiLintSeverity;
  message: string;
  pageId?: string;
  sourceId?: string;
  createdAt: string;
  generation: number;
}

export type WikiImportSource =
  | { kind: "text"; title?: string; text: string }
  | { kind: "url"; url: string; title?: string }
  | { kind: "webfetch_asset"; workspaceId: string; path: string; title?: string }
  | { kind: "file"; path: string; rootPath?: string }
  | { kind: "folder"; path: string }
  | { kind: "workspace_file"; workspaceId: string; path: string }
  | { kind: "chat"; threadId: string; messageIds: string[] }
  | { kind: "reading_note"; noteId: string }
  | { kind: "memory_entry"; workspaceId: string; entryId: string };

export interface WikiCreateImportDraftInput {
  source: WikiImportSource;
  title?: string;
  pageType?: WikiPageType;
  primaryWorkspaceId: string | null;
  associatedWorkspaceIds?: string[];
  sourceGrantWorkspaceIds?: string[];
  updatePageId?: string;
}

export interface WikiCreateEditDraftInput {
  pageId: string;
  expectedHash: string;
  title: string;
  type: WikiPageType;
  primaryWorkspaceId: string | null;
  associatedWorkspaceIds: string[];
  aliases: string[];
  tags: string[];
  body: string;
}

export interface WikiConfirmDraftInput {
  draftId: string;
  expectedRevision: number;
  nonce: string;
}

export interface WikiApplyDraftCommandInput {
  draftId: string;
  expectedRevision: number;
  diffHash: string;
}

export interface WikiResolvePendingCommandInput {
  pendingId: string;
  action: "accept" | "reject";
  expectedRevision: number;
  diffHash: string;
}

export interface WikiUndoSummaryV1 {
  schemaVersion: 1;
  batchId: string;
  expectedBatchRevision: number;
  expectedCurrentStateHash: string;
}

export interface WikiUndoBatchCommandInput extends Omit<WikiUndoSummaryV1, "schemaVersion"> {}

export interface WikiPendingReviewSummary {
  id: string;
  draft: WikiProposalSummaryV1;
  createdAt: string;
  reason: string;
  requiresRegeneration?: boolean;
}

export interface WikiDraftStatus {
  draftId: string;
  state: "pending" | "pending_review" | "applied" | "unavailable";
}

export interface WikiSnapshot {
  rootPath: string;
  pages: WikiPageRef[];
  pending: WikiPendingReviewSummary[];
  findings: WikiLintFinding[];
  generation: number;
  searchMode: "lexical-only" | "hybrid";
  recentBatches: WikiBatch[];
  semanticCheck: {
    enabled: boolean;
    lastSuccessfulAt?: string;
    status: "never" | "due" | "running" | "completed" | "unavailable" | "failed";
    message?: string;
    generation?: number;
    model?: string;
    durationMs?: number;
    findingCounts?: Record<WikiLintSeverity, number>;
  };
  capabilities: WikiCapabilityMatrix;
}

export interface WikiCapabilityMatrix {
  phase: "A" | "B";
  runtimeStatus: "idle" | "preparing" | "ready" | "unavailable";
  uiMutation: boolean;
  askWikiRead: boolean;
  askWikiProposal: boolean;
  askWikiApply: false;
  ordinaryAgentRead: boolean;
  ordinaryAgentProposal: boolean;
  protectedRootGate: boolean;
  allowedRootSandbox: boolean;
  reason: string;
}

export const WIKI_IPC_CHANNELS = {
  GET_SNAPSHOT: "wiki:get-snapshot",
  SEARCH: "wiki:search",
  READ: "wiki:read",
  FOLLOW_LINKS: "wiki:follow-links",
  CREATE_IMPORT_DRAFT: "wiki:create-import-draft",
  CREATE_EDIT_DRAFT: "wiki:create-edit-draft",
  APPLY_DRAFT: "wiki:apply-draft",
  GET_DRAFT_STATUS: "wiki:get-draft-status",
  CANCEL_DRAFT: "wiki:cancel-draft",
  LIST_PENDING: "wiki:list-pending",
  RESOLVE_PENDING: "wiki:resolve-pending",
  UNDO_BATCH: "wiki:undo-batch",
  RUN_LINT: "wiki:run-lint",
  PREVIEW_PRIVACY_PURGE: "wiki:preview-privacy-purge",
  CREATE_PRIVACY_PURGE_DRAFT: "wiki:create-privacy-purge-draft",
  ARCHIVE_WORKSPACE: "wiki:archive-workspace",
  CREATE_ASK_THREAD: "wiki:create-ask-thread",
  GET_CAPABILITIES: "wiki:get-capabilities",
  PREPARE_RUNTIME: "wiki:prepare-runtime",
  PRIVILEGED_GET_PROPOSAL_SUMMARY: "wiki:privileged-get-proposal-summary",
  PRIVILEGED_APPLY_DRAFT: "wiki:privileged-apply-draft",
  PRIVILEGED_RESOLVE_PENDING: "wiki:privileged-resolve-pending",
  PRIVILEGED_GET_UNDO_SUMMARY: "wiki:privileged-get-undo-summary",
  PRIVILEGED_UNDO_BATCH: "wiki:privileged-undo-batch"
} as const;

export const WIKI_DESKTOP_COMMANDS = {
  GET_PROPOSAL_SUMMARY: "desktop_wiki_get_proposal_summary",
  APPLY_DRAFT: "desktop_wiki_apply_draft",
  RESOLVE_PENDING: "desktop_wiki_resolve_pending",
  GET_UNDO_SUMMARY: "desktop_wiki_get_undo_summary",
  UNDO_BATCH: "desktop_wiki_undo_batch"
} as const;
