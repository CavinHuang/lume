import type { AgentBrowserAttachment, AgentCapabilityReferenceView, AgentDiffCommentAttachment, AgentMessageAttachmentInput, AgentUserMessagePart, FileRef, FileReferenceBinding, FileReferenceProtocolVersion } from "./agent";
import type { DesktopActionKind, DesktopActionStatus } from "./computer-use";
import type { ImPeerKind, ImProvider } from "./im";
import type { MemoryClaim } from "./memory";

export type RuntimeEventType =
  | "run.started"
  | "run.completed"
  | "coding.report.updated"
  | "run.turn_limited"
  | "run.failed"
  | "run.cancelled"
  | "message.user.submitted"
  | "assistant.delta"
  | "assistant.thinking_delta"
  | "assistant.final"
  | "model.retry"
  | "model.retry_cleared"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "tool.permission_timeout"
  | "desktop.action_visual"
  | "guidance.delivered"
  | "plan.preview"
  | "todo.state_updated"
  | "task.progress"
  | "background.task.completed"
  | "im.delivery"
  | "permission.requested"
  | "permission.resolved"
  | "ask_user.requested"
  | "memory.context.used"
  | "memory.changed"
  | "memory.job.progress"
  | "memory.job.completed"
  | "context.compaction.started"
  | "context.compaction.progress"
  | "context.compaction.completed"
  | "lsp.diagnostics.updated"
  | "advisor.reviewed"
  | "usage.updated";

export interface RuntimeEventBase {
  id: string;
  type: RuntimeEventType;
  threadId: string;
  runId: string;
  createdAt: string;
  sequence?: number;
  subagentRunId?: string;
  parentToolUseId?: string;
  /** Frozen once for the logical reply and propagated to every runtime projection. */
  fileReferenceBinding?: FileReferenceBinding;
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion;
}

export interface ContextBudgetRuntimeSnapshot {
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  sections: {
    system?: number;
    memory?: number;
    session?: number;
    toolSchemas?: number;
    reservedOutput?: number;
  };
}

export interface RunStartedRuntimeEvent extends RuntimeEventBase {
  type: "run.started";
  workspaceId?: string;
  workspaceSlug?: string;
  model?: {
    provider: string;
    modelId: string;
    modelRef?: string;
    channelId?: string;
    contextWindow?: number;
  };
}

export interface UserMessageSubmittedRuntimeEvent extends RuntimeEventBase {
  type: "message.user.submitted";
  text: string;
  attachments?: AgentMessageAttachmentInput[];
  commentAttachments?: AgentDiffCommentAttachment[];
  browserAttachments?: AgentBrowserAttachment[];
  messageId?: string;
  versionGroupId?: string;
  versionIndex?: number;
  versionCount?: number;
  messageParts?: AgentUserMessagePart[];
  capabilityReferences?: AgentCapabilityReferenceView[];
}

export interface AssistantDeltaRuntimeEvent extends RuntimeEventBase {
  type: "assistant.delta";
  delta: string;
  messageId?: string;
}

export interface AssistantThinkingDeltaRuntimeEvent extends RuntimeEventBase {
  type: "assistant.thinking_delta";
  delta: string;
  messageId?: string;
}

export interface AssistantFinalRuntimeEvent extends RuntimeEventBase {
  type: "assistant.final";
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
  >;
}

export interface ToolStartedRuntimeEvent extends RuntimeEventBase {
  type: "tool.started";
  toolCallId: string;
  toolName: string;
  inputPreview?: unknown;
  riskLevel?: "low" | "medium" | "high";
}

export interface ToolCompletedRuntimeEvent extends RuntimeEventBase {
  type: "tool.completed";
  toolCallId: string;
  toolName?: string;
  resultPreview?: string;
  resultRef?: FileResultRef;
  execution?: ToolExecutionMetadata;
}

export interface ModelRetryRuntimeEvent extends RuntimeEventBase {
  type: "model.retry";
  phase: "waiting" | "retrying";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
}

export interface ModelRetryClearedRuntimeEvent extends RuntimeEventBase {
  type: "model.retry_cleared";
}

export interface ToolFailedRuntimeEvent extends RuntimeEventBase {
  type: "tool.failed";
  toolCallId: string;
  toolName?: string;
  error: {
    code: string;
    message: string;
  };
  resultRef?: ToolExecutionMetadata["resultRef"];
  execution?: ToolExecutionMetadata;
}

export interface ToolPermissionTimeoutRuntimeEvent extends RuntimeEventBase {
  type: "tool.permission_timeout";
  toolCallId: string;
  requestId: string;
  toolName: string;
  message: string;
}

export interface DesktopActionVisualRuntimeEvent extends RuntimeEventBase {
  type: "desktop.action_visual";
  phase: "started" | "completed" | "failed";
  toolCallId: string;
  action: DesktopActionKind;
  app: {
    id: string;
    name: string;
  };
  targetLabel?: string;
  point?: {
    x: number;
    y: number;
  };
  path?: Array<{
    x: number;
    y: number;
  }>;
  status?: DesktopActionStatus;
}

export interface GuidanceDeliveredRuntimeEvent extends RuntimeEventBase {
  type: "guidance.delivered";
  guidanceIds: string[];
  text: string;
}

export interface ToolPermissionResolvedRuntimeEvent extends RuntimeEventBase {
  type: "permission.resolved";
  toolCallId?: string;
  requestId: string;
  toolName?: string;
  decision: "allow_once" | "allow_always" | "deny";
  source: "ui" | "im";
}

export interface PlanPreviewRuntimeEvent extends RuntimeEventBase {
  type: "plan.preview";
  contractId: string;
  title: string;
  summary: string;
  markdown: string;
  planFilePath?: string;
  planVerified?: boolean;
  stepCount: number;
}

export interface TodoStateUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "todo.state_updated";
  todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
  currentActiveForm: string | null;
}

export type TaskProgressRuntimeStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskProgressRuntimeTaskStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface TaskProgressRuntimeTask {
  id: string;
  subject?: string;
  title?: string;
  description?: string;
  expectedTools?: string[];
  expectedFiles?: string[];
  status: TaskProgressRuntimeTaskStatus;
  attemptCount?: number;
  result?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
}

export interface TaskProgressRuntimeEvent extends RuntimeEventBase {
  type: "task.progress";
  /** New Task list identity. Legacy taskRunId/contractId remain optional for replay compatibility only. */
  taskListId?: string;
  origin?: "agent" | "system" | "recovery";
  taskRunId?: string;
  contractId?: string;
  status: TaskProgressRuntimeStatus;
  currentTaskId?: string;
  tasks: TaskProgressRuntimeTask[];
  message?: string;
}

export interface ImDeliveryRuntimeEvent extends RuntimeEventBase {
  type: "im.delivery";
  messageId?: string;
  provider: ImProvider;
  accountId: string;
  peerKind: ImPeerKind;
  peerId: string;
  status: "pending" | "sent" | "failed";
  error?: {
    code: string;
    message: string;
  };
}

export interface RunCompletedRuntimeEvent extends RuntimeEventBase {
  type: "run.completed";
  finalOutput?: string;
  finalMessageId?: string;
  verificationStatus?: "not_required" | "unverified" | "verified" | "failed";
  codingReport?: RuntimeCodingReport;
}

export interface CodingReportUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "coding.report.updated";
  codingReport: RuntimeCodingReport;
}

export interface RuntimeCodingReport {
  /** Lume Run identity used by the review/rewind actions. */
  runId?: string;
  /** Stable visible Coding Turn identity. */
  turnId?: string;
  /** Persisted user message that started the Coding Turn. */
  userMessageId?: string;
  /** Visible assistant message created for this Turn, when available. */
  assistantMessageId?: string;
  phase?: CodingTurnPhase;
  checkpointId?: string;
  baselineCommit?: string;
  rewindState?:
    | "active"
    | "available"
    | "unavailable"
    | "partial"
    | "conflict"
    | "committed_boundary";
  /** Whether the Run has a persisted pre-edit file checkpoint. */
  canRewind?: boolean;
  status: "not_required" | "unverified" | "verified" | "failed";
  workspaceChanged: boolean;
  changedFiles: string[];
  changeSet?: RuntimeCodingChangeSet;
  fileChanges?: RuntimeCodingFileChange[];
  totalAddedLines?: number;
  totalRemovedLines?: number;
  externalChangedFiles: string[];
  pendingBackground: boolean;
  verificationRepairAttempts?: number;
  verificationNoEvidenceAttempts?: number;
  approvalRequestCount?: number;
  terminationReason?: string;
  routeReason?: string;
  toolSelectionReason?: string;
  nonRewindableFiles?: string[];
  message?: string;
  baselineFailure?: {
    command: string;
    signature: string;
  };
  /** Verification commands observed or selected by the runtime for this Turn. */
  verificationRecords?: CodingVerificationRecord[];
  recommendedVerificationCommands?: string[];
  lspDiagnostics?: {
    files: string[];
    total: number;
    errors: number;
    warnings: number;
    updatedAt: string;
  };
  gitActions?: CodingGitAction[];
  review?: CodingReviewSummary;
}

export type CodingTurnPhase =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "ready_for_review"
  | "completed"
  | "failed"
  | "rewind_conflict";

export interface CodingVerificationRecord {
  command: string;
  status: "running" | "passed" | "failed" | "inconclusive";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
}

export type BackgroundTaskCompletedRuntimeStatus = "completed" | "failed" | "stopped" | "cancelled";

export interface BackgroundTaskCompletedRuntimeEvent extends RuntimeEventBase {
  type: "background.task.completed";
  taskId: string;
  status: BackgroundTaskCompletedRuntimeStatus;
  summary?: string;
  message?: string;
  outputFile?: string;
  toolUseId?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  execution?: ToolExecutionMetadata;
}

export interface CodingGitAction {
  kind: "commit" | "push" | "merge" | "rebase" | "reset" | "clean" | "checkout" | "restore" | "other";
  command: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export interface CodingReviewFinding {
  severity: "blocker" | "concern" | "suggestion" | "question";
  path: string;
  line?: number;
  summary: string;
  evidence?: string;
  recommendation?: string;
}

export interface CodingReviewSummary {
  status: "pending" | "complete";
  findings: CodingReviewFinding[];
}

export type CodingVerificationStatus =
  | "not_run"
  | "passed"
  | "failed"
  | "baseline_failed"
  | "exhausted";

export type CodingRewindState =
  | "active"
  | "available"
  | "unavailable"
  | "partial"
  | "conflict"
  | "committed_boundary";

export type CodingChangedFileState =
  | "normal"
  | "committed"
  | "external_modified"
  | "conflict"
  | "unpreviewable";

export interface RuntimeCodingFileChange {
  /** Stable root identity for multi-root/multi-repository reviews. */
  rootId?: string;
  path: string;
  status?: "added" | "modified" | "deleted" | "renamed" | "untracked";
  addedLines?: number;
  removedLines?: number;
  source?: "git" | "snapshot" | "tool" | "bash" | "subagent" | "external";
  canUndo?: boolean;
  oldContentAvailable?: boolean;
  newContentAvailable?: boolean;
  state?: CodingChangedFileState;
  previousPath?: string;
}

export type CodingReviewStageFilter = "uncommitted" | "unstaged" | "staged";

export type CodingReviewSource =
  | { kind: CodingReviewStageFilter }
  | { kind: "branch"; baseRef: string }
  | { kind: "commit"; commitSha: string };

export interface CodingReviewCommit {
  sha: string
  subject: string
  authoredAt: string
}

export interface CodingReviewSourcesResult {
  available: boolean
  rootId?: string
  currentBranch?: string
  defaultBaseRef?: string
  branches: string[]
  commits: CodingReviewCommit[]
  reason?: string
}

export interface CodingReviewSearchFile {
  path: string
  rootId?: string
}

export interface CodingReviewSearchMatch {
  path: string
  rootId?: string
  kind: 'path' | 'line'
  side?: 'additions' | 'deletions' | 'context'
  lineNumber?: number
  preview: string
  matchStart: number
  matchLength: number
}

export interface CodingReviewSearchInput {
  threadId: string
  runId?: string
  reviewSource?: CodingReviewSource
  files: CodingReviewSearchFile[]
  query: string
  limit?: number
}

export interface CodingReviewSearchResult {
  matches: CodingReviewSearchMatch[]
  truncated: boolean
}

export interface CodingDiffActions {
  isGit: boolean
  staged: boolean
  unstaged: boolean
  canStage: boolean
  canUnstage: boolean
  unavailableReason?: string
}

export interface CodingTextDiffPayload {
  kind: 'text'
  rootId?: string
  path: string
  status: RuntimeCodingFileChange['status']
  oldContent: string
  newContent: string
  patch: string
  diffHash: string
  addedLines: number
  removedLines: number
  actions: CodingDiffActions
}

export interface CodingMediaDiffPayload {
  kind: 'media'
  mediaKind: 'markdown' | 'image' | 'svg' | 'pdf'
  rootId?: string
  path: string
  status: RuntimeCodingFileChange['status']
  diffHash: string
  addedLines: number
  removedLines: number
  beforeAvailable: boolean
  afterAvailable: boolean
  actions: CodingDiffActions
}

export interface CodingBinaryDiffPayload {
  kind: 'binary'
  rootId?: string
  path: string
  status: RuntimeCodingFileChange['status']
  diffHash: string
  addedLines: number
  removedLines: number
  actions: CodingDiffActions
}

export type CodingDiffPayload = CodingTextDiffPayload | CodingMediaDiffPayload | CodingBinaryDiffPayload

interface CodingDiffActionBase {
  threadId: string
  runId?: string
  rootId?: string
  stageFilter?: CodingReviewStageFilter
  action: 'stage' | 'unstage'
}

export interface CodingFileDiffActionInput extends CodingDiffActionBase {
  path: string
  scope: 'file' | 'hunk'
  hunkIndex?: number
  expectedDiffHash: string
}

export interface CodingSectionDiffActionInput extends CodingDiffActionBase {
  scope: 'section'
  files: Array<{
    path: string
    expectedDiffHash: string
  }>
}

export type CodingDiffActionInput = CodingFileDiffActionInput | CodingSectionDiffActionInput

export interface CodingDiffActionResult {
  ok: true
  diff?: CodingDiffPayload
}

export interface CodingDiffMediaInput {
  threadId: string
  runId?: string
  rootId?: string
  reviewSource?: CodingReviewSource
  path: string
  side: 'before' | 'after'
}

export interface CodingDiffMediaResult {
  mediaType: string
  size: number
  dataBase64: string
}

export interface CodingBlameLine {
  lineNumber: number
  commit: string
  author: string
  authorTime?: string
  summary?: string
  committed: boolean
  commitUrl?: string
}

export interface CodingBlameResult {
  available: boolean
  lines: CodingBlameLine[]
}

export interface CodingFileOpenTargets {
  absolutePath?: string
  remoteFileUrl?: string
  remoteProvider?: 'github' | 'gitlab'
  revision?: string
}

export type CodingRepositoryPublishState =
  | {
      available: false
      reason: string
    }
  | {
      available: true
      rootId: string
      rootLabel: string
      branch: string
      upstream?: string
      head: string
      indexHash: string
      worktreeHash: string
      stagedCount: number
      unstagedCount: number
      untrackedCount: number
      ahead: number
      behind: number
      canCommit: boolean
      canPush: boolean
    }

interface CodingRepositoryPublishActionBase {
  threadId: string
  runId?: string
  rootId?: string
  expectedBranch: string
  expectedHead: string
}

export interface CodingRepositoryCommitInput extends CodingRepositoryPublishActionBase {
  action: 'commit' | 'commit_and_push'
  message: string
  expectedIndexHash: string
  includeUnstagedChanges?: boolean
  expectedWorktreeHash?: string
}

export interface CodingRepositoryPushInput extends CodingRepositoryPublishActionBase {
  action: 'push'
}

export type CodingRepositoryPublishActionInput =
  | CodingRepositoryCommitInput
  | CodingRepositoryPushInput

export interface CodingRepositoryPublishActionResult {
  state: CodingRepositoryPublishState
  commitHash?: string
  pushCompleted: boolean
  error?: string
}

export interface RuntimeCodingChangeSet {
  turnId?: string;
  repositories?: RuntimeCodingRepository[];
  branch?: {
    name: string;
    upstream?: string;
  };
  base: "turn_checkpoint" | "git:HEAD" | "git_head" | "workspace_snapshot";
  isGitRepo: boolean;
  files: RuntimeCodingFileChange[];
  totalAddedLines: number;
  totalRemovedLines: number;
  generatedAt: string;
  pendingRewind?: {
    operationId: string;
    status: "prepared" | "files_applying" | "files_applied" | "transcript_applying" | "partial";
    restoredFiles: string[];
    conflicts: string[];
    nonRewindableFiles: string[];
    error?: string;
  };
}

export interface RuntimeCodingRepository {
  rootId: string;
  rootLabel: string;
  kind: "git" | "snapshot";
  base: string;
  branch?: {
    name: string;
    upstream?: string;
  };
}

export interface CodingTurnRecord {
  turnId: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId?: string;
  phase?: CodingTurnPhase;
  runIds: string[];
  startedAt: string;
  finishedAt?: string;
  baselineCommit?: string;
  checkpointId?: string;
  changedFiles: RuntimeCodingFileChange[];
  verificationStatus: CodingVerificationStatus;
  verificationRepairAttempts: number;
  approvalRequestCount: number;
  rewindState: CodingRewindState;
  routeReason?: string;
  toolSelectionReason?: string;
  terminationReason?: string;
  verificationRecords?: CodingVerificationRecord[];
  gitActions?: CodingGitAction[];
  review?: CodingReviewSummary;
}

export interface RunTurnLimitedRuntimeEvent extends RuntimeEventBase {
  type: "run.turn_limited";
  reason?: string;
  verificationStatus?: "not_required" | "unverified" | "verified" | "failed";
  codingReport?: RuntimeCodingReport;
}

export interface RunFailedRuntimeEvent extends RuntimeEventBase {
  type: "run.failed";
  error: {
    code: string;
    message: string;
    stack?: string;
    retryable?: boolean;
  };
  verificationStatus?: "not_required" | "unverified" | "verified" | "failed";
  codingReport?: RuntimeCodingReport;
}

export interface RunCancelledRuntimeEvent extends RuntimeEventBase {
  type: "run.cancelled";
  reason?: string;
}

export interface ContextCompactionStartedRuntimeEvent extends RuntimeEventBase {
  type: "context.compaction.started";
  trigger: "auto" | "manual" | "prompt_too_long" | string;
  preTokens: number;
  contextWindow?: number;
  budget?: ContextBudgetRuntimeSnapshot;
  policy: string;
  source: string;
}

export interface ContextCompactionProgressRuntimeEvent extends RuntimeEventBase {
  type: "context.compaction.progress";
  trigger: "auto" | "manual" | "prompt_too_long" | string;
  preTokens: number;
  contextWindow?: number;
  budget?: ContextBudgetRuntimeSnapshot;
  policy: string;
  source: string;
  stage: string;
  progress: number;
  message?: string;
}

export interface MemoryContextUsedRuntimeEvent extends RuntimeEventBase {
  type: "memory.context.used";
  messageId?: string;
  items: Array<{
    id: string;
    kind: "preference" | "fact" | "decision" | "lesson" | "state";
    scope: "global" | "workspace";
    status: "active" | "suspected_stale";
    citation: string;
    fileRef?: FileRef;
    reason: string;
    claim?: MemoryClaim;
  }>;
  hidden?: boolean;
}

export interface MemoryChangedRuntimeEvent extends RuntimeEventBase {
  type: "memory.changed";
  actor: "main_agent" | "background_extract" | "consolidation" | "user" | "migration";
  workspaceSlug: string;
  mutationIds: string[];
  memoryIds: string[];
  summary: string;
  details: Array<{
    mutationId: string;
    action: string;
    scope: "global" | "workspace";
    memoryIds: string[];
    summary: string;
    undoable: boolean;
    entryPaths?: string[];
    sourcePaths?: string[];
  }>;
}

export interface MemoryJobProgressRuntimeEvent extends RuntimeEventBase {
  type: "memory.job.progress";
  jobId: string;
  jobKind: string;
  phase: string;
  scannedItems: number;
  processedItems: number;
  changedItems: number;
}

export interface MemoryJobCompletedRuntimeEvent extends RuntimeEventBase {
  type: "memory.job.completed";
  jobId: string;
  jobKind: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  summary: string;
  changedItems: number;
}

export interface ContextCompactionCompletedRuntimeEvent extends RuntimeEventBase {
  type: "context.compaction.completed";
  trigger: "auto" | "manual" | "prompt_too_long" | string;
  preTokens: number;
  postTokens?: number;
  contextWindow?: number;
  budget?: ContextBudgetRuntimeSnapshot;
  policy: string;
  source: string;
  summary?: string;
  outcome?: "succeeded" | "failed";
  failureReason?: string;
  retainedTokens?: number;
  retainedMessageCount?: number;
}

export interface RuntimeNormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Backward-compatible alias for cacheReadInputTokens. */
  cachedTokens: number;
  totalTokens: number;
}

export interface RuntimeUsageContextSnapshot extends RuntimeNormalizedUsage {
  source: "provider" | "estimated";
  estimatedTailTokens: number;
  sections?: {
    systemTokens?: number;
    memoryTokens?: number;
    toolSchemaTokens?: number;
    messageTokens?: number;
  };
  contextWindow: number;
  contextWindowSource: "model" | "provider" | "fallback";
}

export interface RuntimeUsageIdentity {
  threadId: string;
  runId?: string;
  parentThreadId?: string;
  parentRunId?: string;
  subagentRunId?: string;
  responseId?: string;
  turn?: number;
  callerKind: "conversation" | "compaction" | "subagent" | "title" | "memory" | "classifier" | "side_query" | string;
  callerLabel?: string;
}

export interface RuntimeBillingUsageRecord extends RuntimeNormalizedUsage {
  callerLabel: string;
  callerKind: RuntimeUsageIdentity["callerKind"];
  usageIdentity?: RuntimeUsageIdentity;
  model?: string;
  turn?: number;
  threadId?: string;
  runId?: string;
  parentThreadId?: string;
  parentRunId?: string;
  subagentRunId?: string;
  responseId?: string;
  costUSD?: number;
  ttftMs?: number;
}

export interface RuntimeBillingUsageSummary {
  cumulative: RuntimeNormalizedUsage;
  latestRecord?: RuntimeBillingUsageRecord;
  records: RuntimeBillingUsageRecord[];
  totalCostUSD: number;
}

export interface UsageUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "usage.updated";
  scope: "main" | "subagent" | "background";
  context: RuntimeUsageContextSnapshot;
  billing: RuntimeBillingUsageSummary;
  progress?: RuntimeNormalizedUsage;
}

export interface FileResultRef {
  kind: "file";
  path: string;
  size: number;
  mimeType?: string;
  /** Renderer-safe identity when the result belongs to the current session artifact scope. */
  fileRef?: FileRef;
}

export interface ToolExecutionMetadataV1 {
  version: 1;
  exitCode?: number | null;
  stdoutPreview?: string;
  stderrPreview?: string;
  timedOut?: boolean;
  aborted?: boolean;
  outputLimitReached?: boolean;
  durationMs: number;
  command: string;
  shell?: "bash" | "powershell";
  semanticOutcome?: "no_matches" | "condition_false" | "files_differ";
  purpose?: string;
  workspaceChanged?: boolean;
  resultRef?: FileResultRef;
  terminationReason: "completed" | "nonzero" | "timeout" | "aborted" | "output_limit" | "spawn_error" | "running";
}

export interface ToolExecutionMetadataV2 {
  version: 2;
  outcome: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
  exitCode?: number | null;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutRef?: FileResultRef;
  stderrRef?: FileResultRef;
  timedOut?: boolean;
  aborted?: boolean;
  outputLimitReached?: boolean;
  durationMs: number;
  command: string;
  shell: "bash" | "powershell";
  semanticOutcome?: "no_matches" | "condition_false" | "files_differ";
  purpose?: string;
  workspaceChanged?: boolean;
  resultRef?: FileResultRef;
  terminationReason: "completed" | "nonzero" | "timeout" | "aborted" | "output_limit" | "spawn_error" | "running" | "interrupted";
}

export type ToolExecutionMetadata = ToolExecutionMetadataV1 | ToolExecutionMetadataV2;

export interface AdvisorReviewedRuntimeEvent extends RuntimeEventBase {
  type: "advisor.reviewed";
  severity: "clear" | "suggestion" | "concern" | "blocker";
  summary: string;
  details?: string;
  modelRef: string;
  durationMs?: number;
}

export interface LspDiagnosticsUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "lsp.diagnostics.updated";
  toolUseId?: string;
  filePath: string;
  mutationVersion: number;
  sha256: string;
  delayed: boolean;
  diagnostics: {
    servers: string[];
    total: number;
    errors: number;
    warnings: number;
    truncated: boolean;
    items: Array<{
      server?: string;
      source?: string;
      severity?: 1 | 2 | 3 | 4;
      code?: string | number;
      message: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>;
    artifact?: FileResultRef;
  };
}

export type LumeRuntimeEvent =
  | RunStartedRuntimeEvent
  | UserMessageSubmittedRuntimeEvent
  | AssistantDeltaRuntimeEvent
  | AssistantThinkingDeltaRuntimeEvent
  | AssistantFinalRuntimeEvent
  | ModelRetryRuntimeEvent
  | ModelRetryClearedRuntimeEvent
  | ToolStartedRuntimeEvent
  | ToolCompletedRuntimeEvent
  | ToolFailedRuntimeEvent
  | ToolPermissionTimeoutRuntimeEvent
  | DesktopActionVisualRuntimeEvent
  | GuidanceDeliveredRuntimeEvent
  | ToolPermissionResolvedRuntimeEvent
  | PlanPreviewRuntimeEvent
  | TodoStateUpdatedRuntimeEvent
  | TaskProgressRuntimeEvent
  | BackgroundTaskCompletedRuntimeEvent
  | ImDeliveryRuntimeEvent
  | RunCompletedRuntimeEvent
  | CodingReportUpdatedRuntimeEvent
  | RunTurnLimitedRuntimeEvent
  | RunFailedRuntimeEvent
  | RunCancelledRuntimeEvent
  | MemoryContextUsedRuntimeEvent
  | MemoryChangedRuntimeEvent
  | MemoryJobProgressRuntimeEvent
  | MemoryJobCompletedRuntimeEvent
  | ContextCompactionStartedRuntimeEvent
  | ContextCompactionProgressRuntimeEvent
  | ContextCompactionCompletedRuntimeEvent
  | LspDiagnosticsUpdatedRuntimeEvent
  | AdvisorReviewedRuntimeEvent
  | UsageUpdatedRuntimeEvent;
