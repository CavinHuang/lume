/**
 * Core type definitions for the Agent SDK
 */

import type {
  AgentContextCompactionMetadata,
  AgentContextCompactionStage,
  AgentContextCompactionTrigger,
  ContextUsageSnapshot,
  ContentBlock,
  ContentBlockParam,
  ConversationMessage,
  NormalizedProviderUsage,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  TokenUsage,
  ToolResultContentBlock,
} from '@lume/shared'

/**
 * 协议消息/用量类型已单源下沉至 @lume/shared（src/types/sdk-protocol.ts 与
 * src/types/runtime-event.ts）；此处 re-export 以保持 SDK 对外导出面不变。
 */
export type {
  AgentContextCompactionMetadata,
  AgentContextCompactionStage,
  AgentContextCompactionTrigger,
  BillingUsageRecord,
  BillingUsageSummary,
  CompactionFailureReason,
  ContentBlock,
  ContentBlockParam,
  ContextUsageSnapshot,
  ConversationMessage,
  FileResultRef,
  MessageRole,
  ModelUsage,
  NormalizedProviderUsage,
  PermissionMode,
  ProviderCallKind,
  SDKApiRetryMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKAuthStatusMessage,
  SDKCompactBoundaryMessage,
  SDKContextCompactionProgressMessage,
  SDKContextCompactionStartedMessage,
  SDKElicitationCompleteMessage,
  SDKFilesPersistedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKLocalCommandOutputMessage,
  SDKMemorySavedMessage,
  SDKMessage,
  SDKPartialMessage,
  SDKPermissionDenial,
  SDKPromptSuggestionMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKRunAbortedMessage,
  SDKStatusMessage,
  SDKStreamEventMessage,
  SDKStreamlinedTextMessage,
  SDKStreamlinedToolUseSummaryMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
  SDKToolResultMessage,
  SDKToolUseSummaryMessage,
  SDKUsageRecord,
  SDKUserMessage,
  SDKUserMessageReplay,
  TokenUsage,
  ToolExecutionMetadata,
  ToolExecutionMetadataV1,
  ToolExecutionMetadataV2,
  ToolResultContentBlock,
  UsageIdentity,
} from '@lume/shared'

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

export interface AgentContextCompactionBoundary {
  trigger: AgentContextCompactionTrigger
  preTokens: number
  postTokens?: number
  summary?: string
  metadata?: AgentContextCompactionMetadata
}

export interface AgentContextCompactionProgress {
  trigger: AgentContextCompactionTrigger
  preTokens: number
  stage: AgentContextCompactionStage | string
  progress: number
  message?: string
  metadata?: AgentContextCompactionMetadata
}

export interface AgentContextController {
  shouldAutoCompact?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
    state: import('./utils/compact.js').AutoCompactState
    estimatedTokens: number
    contextUsage?: ContextUsageSnapshot
  }) => boolean | Promise<boolean>
  microCompactMessages?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
  }) => import('./providers/types.js').NormalizedMessageParam[] | Promise<import('./providers/types.js').NormalizedMessageParam[]>
  getCompactionMetadata?: (input: {
    messages: import('./providers/types.js').NormalizedMessageParam[]
    model: string
    state: import('./utils/compact.js').AutoCompactState
    trigger: AgentContextCompactionTrigger
    preTokens: number
  }) => AgentContextCompactionMetadata | undefined | Promise<AgentContextCompactionMetadata | undefined>
  compactConversation?: (input: {
    provider: import('./providers/types.js').LLMProvider
    model: string
    messages: import('./providers/types.js').NormalizedMessageParam[]
    state: import('./utils/compact.js').AutoCompactState
    trigger: AgentContextCompactionTrigger
    preTokens: number
    protectedMessageIndex?: number
    abortSignal?: AbortSignal
  }) => Promise<{
    compacted?: boolean
    compactedMessages: import('./providers/types.js').NormalizedMessageParam[]
    summary: string
    failureReason?: import('./utils/compact.js').CompactionFailureReason
    retainedTokens?: number
    retainedMessageCount?: number
    state?: import('./utils/compact.js').AutoCompactState
    metadata?: AgentContextCompactionMetadata
    usage?: NormalizedProviderUsage
  }>
  onCompactionBoundary?: (boundary: AgentContextCompactionBoundary) => void | Promise<void>
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  /** Validate the permission-adjusted input before hooks and side effects. */
  validateInput?: (input: any, context: ToolContext) => void | string | Promise<void | string>
  /** Optional provider-independent output description for hosts and inspectors. */
  outputSchema?: Record<string, unknown>
  /** Resolve the primary path for permission metadata and diagnostics. */
  getPath?: (input: any, context: ToolContext) => string | undefined | Promise<string | undefined>
  isReadOnly?: (input?: unknown, context?: ToolContext) => boolean
  isConcurrencySafe?: (input?: unknown, context?: ToolContext) => boolean
  isEnabled?: () => boolean
  prompt?: (context: ToolContext) => Promise<string>
  runtimeMetadata?: Record<string, unknown>
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('./providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('./providers/types.js').ApiType
  sessionId?: string
  /** Host Run identity used to correlate durable process jobs. */
  runId?: string
  /** Current user message used to group file checkpoints. */
  currentUserMessageId?: string
  /** Update the active working directory for subsequent tool calls in this session. */
  setWorkingDirectory?: (cwd: string) => void
  toolUseId?: string
  /** True when the engine replaced the tool input via canUseTool updatedInput —
   *  only then may a tool trust host-injected fields (e.g. AskUserQuestion answers). */
  permissionUpdatedInput?: boolean
  additionalDirectories?: string[]
  sandbox?: SandboxSettings
  toolConfig?: Record<string, unknown>
  fileStateCache?: import('./utils/fileCache.js').FileStateCache
  /** Per-run consecutive Edit not-found failures keyed by resolved path; drives the escalating guidance (#569). */
  editFailureCounts?: Map<string, number>
  permissionMode?: PermissionMode
  emitEvent?: (event: SDKMessage) => void
  /** Live progress channel: events are delivered to the host immediately while
   *  the tool runs, bypassing the deferred batch buffer. They never enter the
   *  persisted transcript — hosts that need replayable history must keep using
   *  emitEvent. Undefined when the host did not configure onLiveEvent. */
  emitLiveEvent?: (event: SDKMessage) => void
  /** Hook registry for firing lifecycle hooks (e.g. SubagentStart/Stop). */
  hookRegistry?: import('./hooks.js').HookRegistry
  onSubagentStart?: (params: { runId: string; parentThreadId: string; agentType: string; task: string }) => void
  onSubagentEnd?: (params: { runId: string; status: 'completed' | 'errored' | 'aborted'; output?: string; error?: string }) => Promise<void> | void
  /** Called by a background tool when its process reaches a terminal state. */
  onBackgroundTaskCompleted?: () => void
  skillRegistry?: import('./skills/registry.js').SkillRegistry
  /** Session-owned directory for private, large tool result artifacts. */
  artifactsRoot?: string
  /** Host runtime observation hook; never included in provider-facing messages. */
  onToolExecution?: (observation: {
    toolName: string
    input: unknown
    result: ToolResult
  }) => void
  /** Called immediately before a tool executes, before filesystem side effects. */
  onBeforeToolExecution?: (observation: {
    toolName: string
    input: unknown
    userMessageId?: string
    cwd: string
  }) => Promise<void> | void
  /** Internal bridge used by ExecuteTool to run a discovered deferred tool. */
  executeDeferredTool?: (input: { toolName: string; params: unknown }) => Promise<ToolResult>
  /** Promote deferred tools into the native tools array for subsequent turns. Returns names actually promoted. */
  activateTools?: (names: string[]) => string[]
  /** Runs a registered core or deferred tool through the normal permission and event chain. */
  executeNestedTool?: (input: { toolName: string; params: unknown }) => Promise<ToolResult>
  /** Live snapshot of every tool this engine can call: native tools first, then deferred. */
  listAvailableTools?: () => Array<{ name: string; description: string; inputSchema: ToolDefinition['inputSchema'] }>
}

export interface PersistedToolContinuation {
  toolCall: {
    id: string
    name: string
    input: unknown
  }
  /** Omit when the approved original tool still needs to execute once. */
  toolResult?: ToolResult
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | ToolResultContentBlock[]
  is_error?: boolean
  _meta?: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/**
 * Permission update command (discriminated union).
 * Compatible with official Claude Agent SDK PermissionUpdate.
 */
export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination }

export interface CanUseToolMetadata {
  toolUseId?: string
  permissionSuggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  agentId?: string
}

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
  permissionSuggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
  metadata?: CanUseToolMetadata,
) => Promise<CanUseToolResult>

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

export interface AgentDefinition {
  description: string
  prompt: string
  /** Default skill to auto-load when this agent type is spawned. */
  defaultSkillName?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string
  mcpServers?: Array<string | { name: string; tools?: string[] }>
  skills?: string[]
  maxTurns?: number
  criticalSystemReminder_EXPERIMENTAL?: string
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  processIsolation?: SandboxProcessIsolationConfig
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxProcessIsolationConfig {
  /** Launch opaque child processes through an OS-enforced sandbox. */
  enabled?: boolean
  /** Fail closed when the host sandbox is unavailable or cannot start. */
  required?: boolean
  /** Extra roots visible as read-only to the child process. */
  readonlyPaths?: string[]
  /** Extra roots visible as read-write to the child process. */
  readwritePaths?: string[]
  /** Roots that remain inaccessible even if a broader root is granted. */
  deniedPaths?: string[]
  /** Preferred executable directories prepended to PATH inside the sandbox. */
  executableSearchPaths?: string[]
  /** Preserve existing command network behavior. */
  allowOutbound?: boolean
  allowLocalNetwork?: boolean
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface SDKAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
}

export interface InitializationResult {
  commands: SlashCommand[]
  agents: Array<{ name: string; description: string }>
  output_style: string
  available_output_styles: string[]
  models: ModelInfo[]
  account: SDKAccountInfo
  slash_commands?: string[]
  skills?: string[]
  plugins?: Array<{ name: string; path: string; source?: string }>
}

export interface ContextUsageCategory {
  name: string
  tokens: number
  isDeferred?: boolean
}

export interface ContextUsageResult {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  deferredBuiltinTools?: Array<{ name: string; tokens: number; isLoaded: boolean }>
  systemTools?: Array<{ name: string; tokens: number }>
  systemPromptSections?: Array<{ name: string; tokens: number }>
  agents?: Array<{ agentType: string; source: string; tokens: number }>
  slashCommands?: {
    totalCommands: number
    includedCommands: number
    tokens: number
  }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
  }
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  isAutoCompactEnabled: boolean
  apiUsage: TokenUsage | null
}

export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnnotations {
  preview?: string
  notes?: string
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestion[]
  answers?: Record<string, string>
  annotations?: Record<string, AskUserQuestionAnnotations>
  metadata?: {
    source?: string
  }
}

export interface AskUserQuestionResponse {
  questions: AskUserQuestion[]
  answers: Record<string, string>
  annotations?: Record<string, AskUserQuestionAnnotations>
}

export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface ListSessionsOptions {
  dir?: string
  limit?: number
  offset?: number
}

export interface ForkSessionOptions {
  dir?: string
  upToMessageId?: string
  title?: string
  newSessionId?: string
}

export interface ForkSessionResult {
  sessionId: string
}

export interface SessionMessage {
  uuid: string
  role: 'user' | 'assistant' | 'system' | 'runtime'
  timestamp: string
  content: unknown
}

export interface Query {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>
  streamInput(
    input:
      | string
      | ContentBlockParam[]
      | SDKUserMessage
      | AsyncIterable<string | ContentBlockParam[] | SDKUserMessage>,
  ): Promise<void>
}

export interface AgentOptions {
  /** Host thread identity used for tool assembly authorization. */
  threadType?: 'main' | 'subagent' | 'group' | 'channel'
  /** LLM model ID */
  model?: string
  /** Host-owned provider implementation. Required for any run: the SDK ships no built-in HTTP providers; when set, protocol and credentials are not resolved by the SDK. */
  provider?: import('./providers/types.js').LLMProvider
  /** Working directory for file/shell tools */
  cwd?: string
  /** System prompt override or preset */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Per-turn context placed after history and before the current user message. */
  runtimeContext?: string
  /** Provider prompt-cache policy selected by the host runtime. */
  promptCache?: import('./providers/types.js').PromptCachePolicy
  /** Append to default system prompt */
  appendSystemPrompt?: string
  /** Available tools (ToolDefinition[] or string[] preset) */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** Host hook for final runtime visibility/policy filtering after MCP and plugin tools are assembled */
  resolveRuntimeTools?: (
    tools: ToolDefinition[],
    context: {
      cwd: string
      sessionId: string
      permissionMode?: PermissionMode
      threadType?: 'main' | 'subagent' | 'group' | 'channel'
    }
  ) => ToolDefinition[] | Promise<ToolDefinition[]>
  /** Host hook for registering SDK-generated tools added after runtime resolution. */
  registerGeneratedRuntimeTools?: (
    tools: ToolDefinition[],
    context: {
      cwd: string
      sessionId: string
      permissionMode?: PermissionMode
      threadType?: 'main' | 'subagent' | 'group' | 'channel'
    }
  ) => void | Promise<void>
  /**
   * Host-owned completion policy. Returning feedback keeps the agent loop alive
   * and presents that feedback to the model as an internal user message.
   */
  completionGuard?: () => Promise<CompletionGuardResult>
  /** Explicit skill definitions provided by the host runtime */
  skills?: import('./skills/types.js').SkillDefinition[]
  /** Explicit filesystem roots to scan for skills */
  skillsDirectories?: string[]
  /** Optional host filter for filesystem skills, called with the source root and skill directory name */
  shouldLoadFilesystemSkill?: (input: {
    root: string
    skillName: string
    skillFile: string
  }) => boolean
  /** Maximum number of agentic turns per query */
  maxTurns?: number
  /** Maximum USD budget per query */
  maxBudgetUsd?: number
  /** Extended thinking configuration */
  thinking?: ThinkingConfig
  /**
   * Alias for `thinking`. If both are set, `thinking` takes precedence.
   * Compatible with official Claude Agent SDK option name.
   */
  thinkingConfig?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens) */
  maxThinkingTokens?: number
  /** Structured output JSON schema */
  jsonSchema?: Record<string, unknown>
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode controlling tool approval behavior */
  permissionMode?: PermissionMode
  /**
   * Skip all permission checks (equivalent to bypassPermissions mode).
   * DANGEROUS: only use in trusted, sandboxed environments.
   * Compatible with official Claude Agent SDK option.
   */
  allowDangerouslySkipPermissions?: boolean
  /** Abort controller for cancellation */
  abortController?: AbortController
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Whether to include partial streaming events */
  includePartialMessages?: boolean
  /** Environment variables */
  env?: Record<string, string | undefined>
  /** Tool names to pre-approve without prompting */
  allowedTools?: string[]
  /** Tool names to deny */
  disallowedTools?: string[]
  /** Custom subagent definitions */
  agents?: Record<string, AgentDefinition>
  /** Maximum tokens for responses */
  maxTokens?: number
  /** Resolved context window for the selected model. */
  contextWindow?: number
  /** Effort level for reasoning */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Fallback model if primary is unavailable */
  fallbackModel?: string
  /** Continue the most recent session in cwd */
  continue?: boolean
  /** Resume a specific session by ID */
  resume?: string
  /** Resume a session up to a specific message UUID */
  resumeSessionAt?: string
  /** Fork a session instead of continuing it */
  forkSession?: boolean
  /** Persist session to disk */
  persistSession?: boolean
  /** Explicit session ID */
  sessionId?: string
  /** Host Run identity for durable tool recovery. */
  runId?: string
  /** Subagent delegation identity for usage attribution. */
  subagentRunId?: string
  /** Host-owned exact tool continuations restored after a cold start. */
  toolContinuations?: PersistedToolContinuation[]
  /** Enable file checkpointing (for rewindFiles) */
  enableFileCheckpointing?: boolean
  /** Session-owned read-state shared by every engine this Agent creates (#569).
   *  Hosts that build one Agent per user message pass the same instance for all
   *  Agents of a thread so stale-read protection survives message boundaries.
   *  Omit to give each Agent a private cache (per-thread isolation). */
  fileStateCache?: import('./utils/fileCache.js').FileStateCache
  /** Sandbox configuration */
  sandbox?: SandboxSettings
  /** Load settings from filesystem */
  settingSources?: SettingSource[]
  /** Plugin configurations */
  plugins?: Array<{ name: string; path?: string; config?: Record<string, unknown>; kind?: 'command' | 'module' | 'any' }>
  /** Extra roots (absolute) outside cwd from which plugins may be loaded */
  pluginRoots?: string[]
  /** Additional working directories */
  additionalDirectories?: string[]
  /** Default agent to use */
  agent?: string
  /** Debug mode */
  debug?: boolean
  /** Debug log file */
  debugFile?: string
  /** Tool-specific configuration */
  toolConfig?: Record<string, unknown>
  artifactsRoot?: string
  onToolExecution?: ToolContext['onToolExecution']
  onBeforeToolExecution?: ToolContext['onBeforeToolExecution']
  /** Receives tool events emitted after the originating tool call has returned. */
  onAsyncEvent?: (event: SDKMessage) => void
  /** Live progress channel: receives transient progress events (e.g. periodic
   *  task_progress from long-running commands) immediately while the tool is
   *  still running. Unlike the main event stream these are not buffered until
   *  the tool batch completes and never enter the persisted transcript. */
  onLiveEvent?: (event: SDKMessage) => void
  /** Enable prompt suggestions */
  promptSuggestions?: boolean
  /** Event output style */
  outputStyle?: 'text' | 'json' | 'streamlined'
  /** Strict MCP config validation */
  strictMcpConfig?: boolean
  /** Extra CLI arguments */
  extraArgs?: Record<string, string | null>
  /** SDK betas to enable */
  betas?: string[]
  /** Permission prompt tool name override */
  permissionPromptToolName?: string
  /** Hook configurations */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
  /** Optional host-owned context policy bridge. Defaults preserve SDK compaction behavior. */
  contextController?: AgentContextController
}

export interface QueryResult {
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
}

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string
  model: string
  /** LLM provider instance (host-injected) */
  provider: import('./providers/types.js').LLMProvider
  tools: ToolDefinition[]
  /** Tools omitted from the provider schema and reachable only through ExecuteTool. */
  deferredTools?: ToolDefinition[]
  /** Notified with the names successfully promoted by activateTools (ToolSearch) or skill-scope activation during this run. */
  onToolsActivated?: (names: string[]) => void
  systemPrompt?: string
  runtimeContext?: string
  promptCache?: import('./providers/types.js').PromptCachePolicy
  appendSystemPrompt?: string
  maxTurns: number
  maxBudgetUsd?: number
  maxTokens: number
  /** Resolved context window for the selected model. */
  contextWindow?: number
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  outputFormat?: OutputFormat
  effort?: 'low' | 'medium' | 'high' | 'max'
  canUseTool: CanUseToolFn
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
  /** Host Run identity for durable tool recovery. */
  runId?: string
  /** Subagent delegation identity for usage attribution. */
  subagentRunId?: string
  /** Execute or inject persisted tool calls before the next model request. */
  toolContinuations?: PersistedToolContinuation[]
  permissionMode?: PermissionMode
  promptSuggestions?: boolean
  additionalDirectories?: string[]
  sandbox?: SandboxSettings
  toolConfig?: Record<string, unknown>
  /** Session-owned read-state shared across runs of one Agent/thread (#569).
   *  Engines without it fall back to a private per-run cache. */
  fileStateCache?: import('./utils/fileCache.js').FileStateCache
  artifactsRoot?: string
  onToolExecution?: ToolContext['onToolExecution']
  onBeforeToolExecution?: ToolContext['onBeforeToolExecution']
  /** Receives terminal background events after the tool call has returned. */
  onAsyncEvent?: (event: SDKMessage) => void
  /** Live progress channel — see QueryEngineConfig.onLiveEvent. */
  onLiveEvent?: (event: SDKMessage) => void
  /** Capture a workspace baseline before each Coding Turn. */
  enableFileCheckpointing?: boolean
  skillRegistry?: import('./skills/registry.js').SkillRegistry
  currentUserMessageId?: string
  fileCheckpointState?: import('./utils/file-checkpoints.js').FileCheckpointState
  initialization?: {
    slashCommands?: string[]
    skills?: string[]
    plugins?: Array<{ name: string; path: string; source?: string }>
    outputStyle?: 'text' | 'json' | 'streamlined'
    claudeCodeVersion?: string
    apiKeySource?: string
  }
  /** Optional host-owned context policy bridge. Defaults preserve SDK compaction behavior. */
  contextController?: AgentContextController
  /** Optional host-owned policy that can prevent natural completion. */
  completionGuard?: () => Promise<CompletionGuardResult>
}

export type CompletionGuardResult =
  | string
  | { type: 'continue'; message: string }
  | { type: 'stop'; message: string; errorCode?: string }
  | undefined

// --------------------------------------------------------------------------
// Slash Command & Agent Info (compatible with official Claude Agent SDK)
// --------------------------------------------------------------------------

/**
 * Information about an available slash command / skill.
 * Compatible with official Claude Agent SDK SlashCommand type.
 */
export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
}

/**
 * Information about an available subagent.
 * Compatible with official Claude Agent SDK AgentInfo type.
 */
export interface AgentInfo {
  name: string
  description: string
  model?: string
}

// --------------------------------------------------------------------------
// AbortError
// --------------------------------------------------------------------------

/**
 * Thrown when an operation is aborted.
 * Compatible with official Claude Agent SDK AbortError.
 */
export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}
