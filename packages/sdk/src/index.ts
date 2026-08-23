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

export { loadFilesystemSkills } from './skills/fs-loader.js'

// --------------------------------------------------------------------------
// Plugin System
// --------------------------------------------------------------------------

export {
  parseManifest,
  validateManifest,
  inferDefaults,
  validatePluginPath,
  validatePluginName,
  validateSemver,
  type LumePluginManifest,
  type PluginPermissions,
} from './plugins/manifest.js'
export {
  adaptCodexPlugin,
  CODEX_EVENT_MAP,
} from './plugins/codex-adapter.js'
export {
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginManifestCapabilities,
  type PluginDiagnostic,
  type CommandToolContribution,
  type PluginSkillContribution,
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
  type SensitiveDecision,
  type EffectiveRuntimeState,
  type EffectiveRuntimeStateInput,
} from './plugins/permission-gate.js'
export {
  checkToolPermission,
  checkFilesystemPermission,
  checkNetworkPermission,
  matchPathGlob,
  type PermissionDecision,
} from './plugins/permissions.js'

// --------------------------------------------------------------------------
// Skill System
// --------------------------------------------------------------------------

export {
  SkillRegistry,
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  getModelInvocableSkills,
  hasSkill,
  unregisterSkill,
  clearSkills,
  formatSkillsForPrompt,
  initBundledSkills,
  analyzeSkillImprovement,
  applySkillImprovement,
  listSkillVersions,
  recordSkillUsage,
  restoreSkillVersion,
} from './skills/index.js'
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillInvocationDescriptor,
  SkillResult,
  ApplySkillImprovementResult,
  SkillImprovementMessage,
  SkillImprovementUpdate,
  SkillModelCallInput,
  SkillUsageInput,
  SkillVersionInfo,
} from './skills/index.js'

// --------------------------------------------------------------------------
// Hook System
// --------------------------------------------------------------------------

export {
  HookRegistry,
  createHookRegistry,
  HOOK_EVENTS,
} from './hooks.js'
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
  listSessions,
  forkSession,
} from './session.js'
export type { SessionMetadata, SessionData } from './session.js'

// --------------------------------------------------------------------------
// Settings Utilities
// --------------------------------------------------------------------------

export {
  loadSettingsFromSources,
  mergeAgentOptions,
} from './utils/settings.js'
export type {
  LoadedSettingsSource,
} from './utils/settings.js'

// --------------------------------------------------------------------------
// Message Utilities
// --------------------------------------------------------------------------

export {
  createUserMessage,
  createAssistantMessage,
  normalizeMessagesForAPI,
  stripImagesFromMessages,
  extractTextFromContent,
  createCompactBoundaryMessage,
} from './utils/messages.js'

// --------------------------------------------------------------------------
// Token Estimation & Cost
// --------------------------------------------------------------------------

export {
  estimateTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  getTokenCountFromUsage,
  getContextWindowSize,
  getAutoCompactThreshold,
  estimateCost,
  MODEL_PRICING,
  AUTOCOMPACT_BUFFER_TOKENS,
} from './utils/tokens.js'

export {
  normalizeProviderUsage,
  getCachedTokens,
  calculateAutoCompactThreshold,
  createAgentProgressTracker,
  createEstimatedContextUsage,
  createContextUsageSnapshot,
} from './utils/usage.js'

// --------------------------------------------------------------------------
// Context Compression
// --------------------------------------------------------------------------

export {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
  prepareCompaction,
  findCompactionCutPoint,
  serializeConversation,
} from './utils/compact.js'
export type {
  AutoCompactState,
  CompactConversationOptions,
  CompactConversationResult,
  CompactionFailureReason,
  CompactionPreparation,
} from './utils/compact.js'

// --------------------------------------------------------------------------
// Retry Logic
// --------------------------------------------------------------------------

export {
  withRetry,
  isRetryableError,
  isPromptTooLongError,
  isAuthError,
  isRateLimitError,
  formatApiError,
  getRetryDelay,
  computeRetryDelay,
  parseRetryAfterHeader,
  MAX_RETRY_AFTER_DELAY_MS,
  DEFAULT_RETRY_CONFIG,
} from './utils/retry.js'
export type { RetryConfig } from './utils/retry.js'

// --------------------------------------------------------------------------
// File State Cache
// --------------------------------------------------------------------------

export {
  FileStateCache,
  createFileStateCache,
} from './utils/fileCache.js'
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
  annotateSubagentStreamingEvent,
} from './tools/agent-tool-events.js'

export {
  setQuestionHandler,
  clearQuestionHandler,
} from './tools/ask-user.js'

export {
  setDeferredTools,
  getDeferredTools,
  createToolSearchTool,
  createExecuteTool,
  getToolSearchMode,
  getDeferredToolTokenCount,
  shouldEnableAutomaticToolSearch,
  isToolSearchEnabled,
} from './tools/tool-search.js'

export type { TodoItem, TodoStatus, TodoState } from './tools/todo-tool.js'

// --------------------------------------------------------------------------
// Render Client (reverse-RPC bridge to desktop renderer)
// --------------------------------------------------------------------------

export * from './tools/render-client.js'

// WebFetch internals (enhanced WebFetch assembly in sidecar needs these)
export { runWebFetch, type WebFetchInput, type WebFetchDeps } from './tools/web-fetch.js'
export { sdkFetch } from './tools/web-request.js'
export { isFakeIpRange, isPublicIpAddress } from './utils/pathing.js'
export type { FetchImpl } from './tools/web-fetch-http.js'
export { extractArticleMarkdown } from './tools/html-to-markdown.js'
export {
  fetchIdFromUrl,
  lumeFileUrl,
  downloadAndLocalizeImages,
  type ImageMode,
  type LocalizeResult,
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
  SDKPostTurnSummaryMessage,
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
  PermissionBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
  PermissionRuleValue,
  CanUseToolMetadata,
  CanUseToolFn,
  CanUseToolResult,

  // Agent types
  AgentOptions,
  AgentContextController,
  AgentContextCompactionBoundary,
  AgentContextCompactionMetadata,
  AgentContextCompactionTrigger,
  AgentDefinition,
  Query,
  QueryResult,
  ThinkingConfig,
  TokenUsage,
  ProviderCallKind,
  UsageIdentity,
  NormalizedProviderUsage,
  ContextUsageSnapshot,
  BillingUsageRecord,
  BillingUsageSummary,
  AgentProgressUsage,
  ModelUsage,
  InitializationResult,
  ContextUsageResult,
  RewindFilesResult,
  AskUserQuestion,
  QuestionOption,
  AskUserQuestionAnnotations,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  ListSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SessionMessage,

  // Engine types
  QueryEngineConfig,
  CompletionGuardResult,

  // Content block types
  ContentBlockParam,
  ContentBlock,

  // Sandbox types
  SandboxSettings,
  SandboxProcessIsolationConfig,
  SandboxNetworkConfig,
  SandboxFilesystemConfig,

  // Output format
  OutputFormat,

  // Setting sources
  SettingSource,

  // Model info
  ModelInfo,

  // Slash commands & agent info
  SlashCommand,
  AgentInfo,
} from './types.js'

// AbortError is a class (value + type), so it must be exported separately
export { AbortError } from './types.js'

// Interrupted-run recovery: dangling tool_use detection + continuation building
// (reused by the sidecar dangling-fallback resume path).
export { detectDanglingToolUses, buildResumeContinuations } from './interrupt-recovery.js'
export type { DanglingToolUse, ResumeToolInfo } from './interrupt-recovery.js'

// Lifecycle projector - SDKMessage stream -> lifecycle skeleton events (batch 1)
export { projectLifecycle } from './events/lifecycle-projector.js'
