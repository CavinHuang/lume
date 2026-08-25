/**
 * @codeany/open-agent-sdk
 *
 * Open-source Agent SDK by CodeAny (https://codeany.ai).
 * Runs the full agent loop in-process without spawning subprocesses.
 *
 * Features:
 * - 30+ built-in tools (file I/O, shell, web, agents, tasks, teams, etc.)
 * - Skill system (reusable prompt templates with bundled skills)
 * - MCP server integration (stdio, SSE, HTTP)
 * - Context compression (auto-compact, micro-compact)
 * - Retry with exponential backoff
 * - Git status & project context injection
 * - Multi-turn session persistence
 * - Permission system (allow/deny/bypass modes)
 * - Subagent spawning & team coordination
 * - Task management & scheduling
 * - Hook system with lifecycle integration (pre/post tool use, session, compact)
 * - Token estimation & cost tracking
 * - File state LRU caching
 * - Plan mode for structured workflows
 */

// --------------------------------------------------------------------------
// High-level Agent API
// --------------------------------------------------------------------------

export { Agent, createAgent } from './agent.js'
export { rewindCheckpoint } from './utils/file-checkpoints.js'
export type { FileCheckpoint, FileCheckpointState, FileSnapshot } from './utils/file-checkpoints.js'
export { QueryController } from './query-controller.js'
export {
  formatLumePluginReference,
  formatLumeSkillReference,
  normalizeLumeCapabilityReferences,
  parseLumeCapabilityReference,
} from './capability-references.js'
export type {
  LumeCapabilityReference,
} from './capability-references.js'

// --------------------------------------------------------------------------
// Core Engine
// --------------------------------------------------------------------------

export { QueryEngine } from './engine.js'
export { withRepeatGuardState, readRepeatGuardState } from './repeat-guard.js'
export type { RepeatGuardMeta } from './repeat-guard.js'
export { resolveShellInvocation, shellKindWithoutDiscovery, shellKindConservative, resetWindowsBashDiscoveryForTests } from './utils/shell-invocation.js'
export { analyzeBashCommand, normalizeExecutable } from './utils/bash-command-analysis.js'
export type { BashCommandAnalysis, BashCommandSegment, BashParseStatus } from './utils/bash-command-analysis.js'
export { isReadOnlyShellInput, isReadOnlyPowerShell } from './utils/shell-read-only.js'
export {
  spawnWithProcessSandbox,
} from './utils/process-sandbox.js'
export type {
} from './utils/process-sandbox.js'

// --------------------------------------------------------------------------
// LLM Provider Contract (host-injected implementations)
// --------------------------------------------------------------------------

export type {
  ApiType,
  LLMProvider,
  PromptCachePolicy,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './providers/types.js'

// --------------------------------------------------------------------------
// Tool System (30+ tools)
// --------------------------------------------------------------------------

export {
  // Registry
  filterTools,

  // Helpers
  defineTool,
  toApiTool,

  // Core file I/O & execution
  BashTool,
  FileReadTool,
  isFullReadText,
  FileWriteTool,
  FileEditTool,
  MultiEditTool,
  GlobTool,
  GrepTool,
  NotebookEditTool,

  // Web
  WebFetchTool,
  WebSearchTool,
  GuanlanSearchTool,
  GuanlanReadTool,
  GuanlanHotnewsTool,
  GuanlanResearchTool,

  // Agent & Multi-agent
  AgentTool,

  // Persistent Tasks are host-bound through createTaskTools.

  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,

  // User interaction
  AskUserQuestionTool,

  // Discovery
  ToolSearchTool,

  // Todo
  createTodoTool,

  // Skill
  SkillTool,
} from './tools/index.js'

export {
  ProcessOutputTool,
  ProcessStopTool,
  loadProcessJobs,
  markProcessJobContinuationConsumed,
  markProcessJobNotified,
  waitForProcessJobTerminal,
  type ProcessJob,
} from './tools/process-job-registry.js'

// --------------------------------------------------------------------------
// MCP Client
// --------------------------------------------------------------------------

export { McpClientManager } from './mcp/manager.js'
export type {
  McpCallResult,
  McpClientServerStatus,
  McpListResourcesResult,
  McpReadResourceResult,
  McpToolDetail,
  NormalizedMcpServerConfig,
} from './mcp/manager.js'

// --------------------------------------------------------------------------
// Skills
// --------------------------------------------------------------------------

export { loadFilesystemSkills } from './skills/fs-loader.js'

// --------------------------------------------------------------------------
// Plugin System
// --------------------------------------------------------------------------

export {
  type LumePluginManifest,
  type PluginPermissions,
} from './plugins/manifest.js'
export {
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginDiagnostic,
  type CommandToolContribution,
} from './plugins/normalized.js'
export {
  computePermissionsHash,
} from './plugins/permissions-hash.js'
export {
  buildCommandToolDefinition,
} from './plugins/loader.js'
export {
  resolveSensitiveApproval,
  isHardDeniedTool,
  computeEffectiveRuntimeState,
  type SensitiveCapabilityKey,
  type SensitiveApprovalRecord,
  type EffectiveRuntimeState,
} from './plugins/permission-gate.js'
export {
  checkToolPermission,
  checkFilesystemPermission,
  checkNetworkPermission,
  type PermissionDecision,
} from './plugins/permissions.js'

// --------------------------------------------------------------------------
// Skill System
// --------------------------------------------------------------------------

export {
  getSkill,
  analyzeSkillImprovement,
  applySkillImprovement,
  listSkillVersions,
  restoreSkillVersion,
} from './skills/index.js'
export type {
  SkillDefinition,
  SkillInvocationDescriptor,
  SkillResult,
  ApplySkillImprovementResult,
  SkillImprovementMessage,
  SkillImprovementUpdate,
  SkillModelCallInput,
  SkillVersionInfo,
} from './skills/index.js'

// --------------------------------------------------------------------------
// Hook System
// --------------------------------------------------------------------------

export type {
  HookEvent,
  HookDefinition,
  HookInput,
  HookOutput,
  HookConfig,
  HookExecutionResult,
} from './hooks.js'

// --------------------------------------------------------------------------
// Session Management
// --------------------------------------------------------------------------

export {
  saveSession,
  loadSession,
} from './session.js'
export type { SessionMetadata, SessionData } from './session.js'


// --------------------------------------------------------------------------
// Settings Utilities
// --------------------------------------------------------------------------

export type {
} from './utils/settings.js'

// --------------------------------------------------------------------------
// Message Utilities
// --------------------------------------------------------------------------


// --------------------------------------------------------------------------
// Token Estimation & Cost
// --------------------------------------------------------------------------

export {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  estimateMessagesTokens,
} from './utils/tokens.js'


// --------------------------------------------------------------------------
// Context Compression
// --------------------------------------------------------------------------

export {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  compactToolResultContent,
} from './utils/compact.js'
export type {
  AutoCompactState,
  CompactionFailureReason,
} from './utils/compact.js'

// --------------------------------------------------------------------------
// Retry Logic
// --------------------------------------------------------------------------

export {
  parseRetryAfterHeader,
  MAX_RETRY_AFTER_DELAY_MS,
} from './utils/retry.js'
export type { RetryConfig } from './utils/retry.js'

// --------------------------------------------------------------------------
// File State Cache
// --------------------------------------------------------------------------

export { FileStateCache } from './utils/fileCache.js'
export type { FileState } from './utils/fileCache.js'

// --------------------------------------------------------------------------
// Task & Team contracts (state is owned by the host)
// --------------------------------------------------------------------------

export { createTaskTools } from './tools/task-tools.js'
export type {
  Task,
  TaskStatus,
  TaskRef,
  TaskMetadata,
  TaskStoreAdapter,
  TaskStoreContext,
  TaskMutationResult,
  TaskToolName,
} from './tools/task-tools.js'

export {
  summarizeSubagentAssistantEvent,
  finalizeSubagentOutput,
  finalizeSubagentOutputFromState,
} from './tools/subagent-output.js'


export {
  setQuestionHandler,
  clearQuestionHandler,
} from './tools/ask-user.js'

export {
  createToolSearchTool,
  createExecuteTool,
} from './tools/tool-search.js'

export type { TodoItem, TodoStatus, TodoState } from './tools/todo-tool.js'

// --------------------------------------------------------------------------
// Render Client (reverse-RPC bridge to desktop renderer)
// --------------------------------------------------------------------------

export * from './tools/render-client.js'

// WebFetch internals (enhanced WebFetch assembly in sidecar needs these)
export { runWebFetch, type WebFetchInput, type WebFetchDeps } from './tools/web-fetch.js'
export { sdkFetch } from './tools/web-request.js'
export { canonicalizePath, ensureWriteContained, isFakeIpRange, isPublicIpAddress } from './utils/pathing.js'
export type { FetchImpl } from './tools/web-fetch-http.js'
export { extractArticleMarkdown } from './tools/html-to-markdown.js'
export {
  fetchIdFromUrl,
  lumeFileUrl,
  type ImageMode,
} from './tools/image-pipeline.js'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type {
  // Message types
  Message,
  UserMessage,
  AssistantMessage,
  ConversationMessage,
  MessageRole,

  // SDK message types (streaming events)
  SDKMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKToolResultMessage,
  SDKResultMessage,
  SDKPermissionDenial,
  SDKStreamEventMessage,
  /** @deprecated Use SDKStreamEventMessage */
  SDKPartialMessage,
  SDKSystemMessage,
  SDKContextCompactionStartedMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKTaskNotificationMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKToolProgressMessage,
  SDKAuthStatusMessage,
  SDKFilesPersistedMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKPromptSuggestionMessage,
  SDKApiRetryMessage,
  SDKStreamlinedTextMessage,
  SDKStreamlinedToolUseSummaryMessage,
  SDKToolUseSummaryMessage,
  SDKLocalCommandOutputMessage,
  SDKElicitationCompleteMessage,
  SDKContextCompactionProgressMessage,
  SDKMemorySavedMessage,
  SDKRunAbortedMessage,

  // Tool types
  ToolDefinition,
  ToolInputSchema,
  ToolContext,
  ToolResult,
  PersistedToolContinuation,

  // Permission types
  PermissionMode,
  CanUseToolFn,

  // Agent types
  AgentOptions,
  AgentContextController,
  AgentContextCompactionMetadata,
  AgentContextCompactionTrigger,
  AgentDefinition,
  Query,
  TokenUsage,
  ProviderCallKind,
  UsageIdentity,
  NormalizedProviderUsage,
  ContextUsageSnapshot,
  BillingUsageRecord,
  BillingUsageSummary,
  ModelUsage,
  InitializationResult,
  AskUserQuestion,
  QuestionOption,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  SessionMessage,

  // Engine types
  CompletionGuardResult,

  // Content block types
  ContentBlockParam,
  ContentBlock,

  // Sandbox types
  SandboxSettings,

  // Output format

  // Setting sources

  // Model info
  ModelInfo,

  // Slash commands & agent info
  SlashCommand,
} from './types.js'

// AbortError is a class (value + type), so it must be exported separately
export { AbortError } from './types.js'

// Interrupted-run recovery: dangling tool_use detection + continuation building
// (reused by the sidecar dangling-fallback resume path).
export { detectDanglingToolUses, buildResumeContinuations } from './interrupt-recovery.js'
export type { DanglingToolUse, ResumeToolInfo } from './interrupt-recovery.js'

// Lifecycle projector - SDKMessage stream -> lifecycle skeleton events (batch 1)
export { projectLifecycle } from './events/lifecycle-projector.js'
