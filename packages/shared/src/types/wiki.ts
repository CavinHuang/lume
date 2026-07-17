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
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  preview: string;
}

export interface WikiDraftOperation {
  kind: "create" | "update" | "move" | "delete";
  pageId: string;
  beforeHash: string | null;
  targetRelativePath: string;
  previousRelativePath?: string;
  markdown?: string;
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
}

export interface WikiBatch {
  id: string;
  draftId: string;
  state: "prepared" | "applying" | "committed" | "failed" | "undone";
  fencingToken: number;
  actor: string;
  origin: WikiChangeDraft["origin"];
  risk: WikiDraftRisk;
  createdAt: string;
  committedAt?: string;
  diffs: WikiDiff[];
  affectedPageIds: string[];
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

export interface WikiSnapshot {
  rootPath: string;
  pages: WikiPageRef[];
  pending: WikiPendingReview[];
  findings: WikiLintFinding[];
  generation: number;
  recentBatches: WikiBatch[];
  semanticCheck: {
    enabled: boolean;
    lastSuccessfulAt?: string;
    status: "never" | "due" | "running" | "completed" | "unavailable" | "failed";
    message?: string;
  };
  capabilities: WikiCapabilityMatrix;
}

export interface WikiCapabilityMatrix {
  phase: "A" | "B";
  uiMutation: boolean;
  askWikiReadOnly: boolean;
  ordinaryAgentRead: boolean;
  agentProposals: boolean;
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
  CANCEL_DRAFT: "wiki:cancel-draft",
  LIST_PENDING: "wiki:list-pending",
  RESOLVE_PENDING: "wiki:resolve-pending",
  UNDO_BATCH: "wiki:undo-batch",
  RUN_LINT: "wiki:run-lint",
  ARCHIVE_WORKSPACE: "wiki:archive-workspace",
  CREATE_ASK_THREAD: "wiki:create-ask-thread",
  GET_CAPABILITIES: "wiki:get-capabilities"
} as const;
