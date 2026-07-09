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

export { Agent, createAgent, query } from './agent.js'
export { QueryController } from './query-controller.js'

// --------------------------------------------------------------------------
// Tool Helper (Zod-based tool creation, compatible with official SDK)
// --------------------------------------------------------------------------

export { tool, sdkToolToToolDefinition } from './tool-helper.js'
export type {
  ToolAnnotations,
  CallToolResult,
  SdkMcpToolDefinition,
} from './tool-helper.js'

// --------------------------------------------------------------------------
// In-Process MCP Server
// --------------------------------------------------------------------------

export { createSdkMcpServer, isSdkServerConfig } from './sdk-mcp-server.js'
export type { McpSdkServerConfig } from './sdk-mcp-server.js'

// --------------------------------------------------------------------------
// Core Engine
// --------------------------------------------------------------------------

export { QueryEngine } from './engine.js'
export { resolveShellInvocation } from './utils/shell-invocation.js'

// --------------------------------------------------------------------------
// LLM Providers (Anthropic + OpenAI)
// --------------------------------------------------------------------------

export {
  createProvider,
  AnthropicProvider,
  OpenAIProvider,
} from './providers/index.js'
export type {
  ApiType,
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './providers/index.js'

// --------------------------------------------------------------------------
// Tool System (30+ tools)
// --------------------------------------------------------------------------

export {
  // Registry
  getAllBaseTools,
  filterTools,
  filterDisallowedTools,
  assembleToolPool,

  // Helpers
  defineTool,
  toApiTool,

  // Core file I/O & execution
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FindFilesTool,
  GlobTool,
  GrepTool,
  ListWorkspaceTreeTool,
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
  SendMessageTool,
  TeamCreateTool,
  TeamDeleteTool,

  // Tasks
  TaskCreateTool,
  TaskListTool,
  TaskUpdateTool,
  TaskGetTool,
  TaskStopTool,
  TaskOutputTool,

  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,

  // User interaction
  AskUserQuestionTool,

  // Discovery
  ToolSearchTool,

  // MCP Resources
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  SubscribeMcpResourceTool,
  UnsubscribeMcpResourceTool,
  SubscribePollingTool,
  UnsubscribePollingTool,
  McpAuthTool,

  // LSP
  LSPTool,

  // Config
  ConfigTool,

  // Todo
  createTodoTool,

  // Skill
  SkillTool,
} from './tools/index.js'

// --------------------------------------------------------------------------
// MCP Client
// --------------------------------------------------------------------------

export { connectMCPServer, closeAllConnections } from './mcp/client.js'
export type { MCPConnection } from './mcp/client.js'
export { McpClientManager } from './mcp/manager.js'
export type {
  McpCallResult,
  McpClientErrorCode,
  McpClientFactory,
  McpClientLike,
  McpClientServerStatus,
  McpClientStatus,
  McpListResourcesResult,
  McpReadResourceResult,
  McpToolDetail,
  McpTransportFactory,
  McpTransportKind,
  NormalizedMcpServerConfig,
} from './mcp/manager.js'

// --------------------------------------------------------------------------
// Slash Commands
// --------------------------------------------------------------------------

export {
  loadCommandDefinitions,
  commandDefinitionsToSlashCommands,
} from './commands/fs-loader.js'
export type { CommandDefinition } from './commands/types.js'
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
  getSessionMessages,
  getSessionInfo,
  renameSession,
  tagSession,
  appendToSession,
  deleteSession,
} from './session.js'
export type { SessionMetadata, SessionData } from './session.js'

// --------------------------------------------------------------------------
// Context Utilities
// --------------------------------------------------------------------------

export {
  getSystemContext,
  getUserContext,
  getGitStatus,
  readProjectContextContent,
  discoverProjectContextFiles,
  clearContextCache,
} from './utils/context.js'

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
  truncateText,
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
} from './utils/compact.js'
export type { AutoCompactState } from './utils/compact.js'

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
// Task & Team State (for advanced usage)
// --------------------------------------------------------------------------

export {
  getAllTasks,
  getTask,
  clearTasks,
} from './tools/task-tools.js'
export type { Task, TaskStatus } from './tools/task-tools.js'

export {
  getAllTeams,
  getTeam,
  clearTeams,
} from './tools/team-tools.js'
export type { Team } from './tools/team-tools.js'

export {
  readMailbox,
  writeToMailbox,
  clearMailboxes,
} from './tools/send-message.js'
export type { AgentMessage } from './tools/send-message.js'

export {
  registerAgents,
  clearAgents,
} from './tools/agent-tool.js'

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
  getToolSearchMode,
  getDeferredToolTokenCount,
  shouldEnableAutomaticToolSearch,
  isToolSearchEnabled,
} from './tools/tool-search.js'

export {
  setMcpConnections,
} from './tools/mcp-resource-tools.js'

export {
  getConfig,
  setConfig,
  clearConfig,
} from './tools/config-tool.js'

export type { TodoItem, TodoStatus, TodoState } from './tools/todo-tool.js'

// --------------------------------------------------------------------------
// Render Client (reverse-RPC bridge to desktop renderer)
// --------------------------------------------------------------------------

export * from './tools/render-client.js'

// WebFetch internals (enhanced WebFetch assembly in sidecar needs these)
export { runWebFetch, type WebFetchInput, type WebFetchDeps } from './tools/web-fetch.js'
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
  SDKSessionStateChangedMessage,
  SDKLocalCommandOutputMessage,
  SDKElicitationCompleteMessage,

  // Tool types
  ToolDefinition,
  ToolInputSchema,
  ToolContext,
  ToolResult,

  // Permission types
  PermissionMode,
  PermissionBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
  PermissionRuleValue,
  CanUseToolMetadata,
  CanUseToolFn,
  CanUseToolResult,

  // MCP types
  McpServerConfig,
  McpStdioConfig,
  McpSseConfig,
  McpHttpConfig,

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
  MCPServerStatus,
  ContextUsageResult,
  RewindFilesResult,
  ReloadPluginsResult,
  AskUserQuestion,
  QuestionOption,
  AskUserQuestionAnnotations,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  ListSessionsOptions,
  GetSessionMessagesOptions,
  GetSessionInfoOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SessionMessage,

  // Engine types
  QueryEngineConfig,

  // Content block types
  ContentBlockParam,
  ContentBlock,

  // Sandbox types
  SandboxSettings,
  SandboxNetworkConfig,
  SandboxFilesystemConfig,

  // Output format
  OutputFormat,

  // Setting sources
  SettingSource,

  // Model info
  ModelInfo,
  McpElicitationRequest,
  McpElicitationResponse,
  McpElicitationHandler,
  McpResourceUpdate,
  McpResourceUpdateHandler,

  // Slash commands & agent info
  SlashCommand,
  AgentInfo,
} from './types.js'

// AbortError is a class (value + type), so it must be exported separately
export { AbortError } from './types.js'
