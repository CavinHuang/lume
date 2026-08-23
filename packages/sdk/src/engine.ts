/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

import type {
  SDKMessage,
  ContextUsageResult,
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  TokenUsage,
  ContentBlockParam,
  AgentContextCompactionBoundary,
  AgentContextCompactionMetadata,
  AgentContextCompactionStage,
  AgentContextCompactionTrigger,
  SDKAssistantMessageError,
  SDKUsageRecord,
  BillingUsageRecord,
  BillingUsageSummary,
  ContextUsageSnapshot,
  NormalizedProviderUsage,
  UsageIdentity,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  NormalizedMessageParam,
  NormalizedTool,
  CreateMessageParams,
} from './providers/types.js'
import {
  estimateMessagesTokens,
  estimateCost,
  estimateSystemPromptTokens,
  getContextWindowSize,
} from './utils/tokens.js'
import {
  createContextUsageSnapshot,
  normalizeProviderUsage,
} from './utils/usage.js'
import {
  shouldAutoCompact,
  compactConversation as defaultCompactConversation,
  microCompactMessages as defaultMicroCompactMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
} from './utils/retry.js'
import { getSystemContext, getUserContext } from './utils/context.js'
import {
  hydrateEphemeralImageReferences,
  collectInternalContextBlocks,
  normalizeMessagesForAPI,
  releaseEphemeralImageReferences,
  renderComputerUseActionFacts,
  stripInternalContextBlocks,
} from './utils/messages.js'
import type { HookRegistry, HookInput, HookExecutionResult } from './hooks.js'
import { readRepeatGuardState } from './repeat-guard.js'
import { stableSerialize } from '@lume/shared'
import { buildStructuredOutputInstruction, parseStructuredOutput } from './utils/structured-output.js'
import { captureFileSnapshots, captureWorkspaceFileSnapshots, collectCheckpointPaths, requiresWorkspaceCheckpoint } from './utils/file-checkpoints.js'
import { generatePromptSuggestion } from './utils/prompt-suggestions.js'
import { resolve } from 'path'
import { getModelInvocableSkills, getUserInvocableSkills, renderSkillCatalog } from './skills/index.js'
import { matchesAnyToolPattern } from './utils/tool-approval.js'
import { FileStateCache } from './utils/fileCache.js'
import { createExecuteTool, createToolSearchTool, estimateToolTokens, getDeferredToolTokenCount } from './tools/tool-search.js'

// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  response_item_id?: string
  name: string
  input: any
}

interface RepeatedToolCallState {
  resultSignature: string
  equivalentResultCount: number
  isError: boolean
}

const MAX_EQUIVALENT_MUTATION_RESULTS = 2
const MAX_BLOCKED_REPEAT_ATTEMPTS = 2

function toolCallSignature(block: ToolUseBlock): string {
  return `${block.name}\0${stableSerialize(block.input)}`
}

function toolResultSignature(result: ToolResult): string {
  // Tools whose public result contains volatile operation ids may expose the
  // stable state that matters for progress via withRepeatGuardState().
  const stableState = readRepeatGuardState(result) ?? result.content
  return stableSerialize({
    state: stableState,
    isError: result.is_error === true,
  })
}

// Deterministic refusals are user or policy decisions rather than tool
// outcomes; they must not count toward result equivalence so that a later
// identical call still reaches canUseTool (e.g. after the user changes their
// mind or the permission mode is relaxed mid-run).
const REPEAT_GUARD_EXEMPT_ERROR_CODES = new Set(['permission_denied', 'invalid_input'])

function isDeterministicRefusal(result: ToolResult): boolean {
  const error = result._meta?.error
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && REPEAT_GUARD_EXEMPT_ERROR_CODES.has(code)
}

function createRepeatGuardSkippedToolResult(block: ToolUseBlock): ToolResult & { tool_name: string } {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: `Skipped: tool "${block.name}" was not executed because the agent was stopped after repeating identical tool calls.`,
    is_error: true,
    tool_name: block.name,
  }
}

function extractAssistantText(response: CreateMessageResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function summarizeAssistantTurn(
  response: CreateMessageResponse,
  sessionId: string,
): SDKMessage {
  const text = extractAssistantText(response)
  const toolUseBlocks = response.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  )
  const assistantBlockId = toolUseBlocks[0]?.id || crypto.randomUUID()

  let statusCategory: 'blocked' | 'waiting' | 'completed' | 'review_ready' | 'failed' = 'completed'
  let statusDetail = 'Turn completed.'
  let title = 'Completed'
  let needsAction = 'No immediate action required.'

  if (toolUseBlocks.length > 0) {
    statusCategory = 'waiting'
    statusDetail = `Waiting on ${toolUseBlocks.length} tool call(s).`
    title = 'Using Tools'
    needsAction = 'Wait for tool execution to finish.'
  } else if (response.stopReason === 'max_tokens') {
    statusCategory = 'waiting'
    statusDetail = 'Response reached the token limit and may continue.'
    title = 'Continuation Needed'
    needsAction = 'Continue the assistant response.'
  } else if (/review|verify|check/i.test(text)) {
    statusCategory = 'review_ready'
    statusDetail = 'Output is ready for user review.'
    title = 'Ready For Review'
    needsAction = 'Review the assistant output.'
  }

  const description = text
    ? text.slice(0, 280)
    : toolUseBlocks.length > 0
      ? `Assistant invoked ${toolUseBlocks.map((block) => block.name).join(', ')}.`
      : 'Assistant completed a turn.'

  return {
    type: 'system',
    subtype: 'post_turn_summary',
    summarizes_uuid: assistantBlockId,
    status_category: statusCategory,
    status_detail: statusDetail,
    is_noteworthy: toolUseBlocks.length > 0 || /error|fail|review|verify/i.test(text),
    title,
    description,
    recent_action: toolUseBlocks.length > 0
      ? `Called ${toolUseBlocks.map((block) => block.name).join(', ')}`
      : (text.slice(0, 120) || 'Generated a response.'),
    needs_action: needsAction,
    artifact_urls: [],
    session_id: sessionId,
  }
}

function createStreamlinedTextMessage(
  response: CreateMessageResponse,
  sessionId: string,
): SDKMessage | null {
  const text = extractAssistantText(response)
  if (!text) return null

  return {
    type: 'streamlined_text',
    text,
    session_id: sessionId,
  }
}

function createStreamlinedToolUseSummaryMessage(
  response: CreateMessageResponse,
  sessionId: string,
): SDKMessage | null {
  const toolUseBlocks = response.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  )
  if (toolUseBlocks.length === 0) return null

  const names = toolUseBlocks.map((block) => block.name)
  const summary = names.length === 1
    ? `Used tool: ${names[0]}`
    : `Used tools: ${names.join(', ')}`

  return {
    type: 'streamlined_tool_use_summary',
    tool_summary: summary,
    session_id: sessionId,
  }
}

function createDeferredSiblingToolResult(
  block: ToolUseBlock,
): ToolResult & { tool_name: string } {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    tool_name: block.name,
    content:
      'Tool call skipped: a Skill activation in the same assistant turn must be applied before other tools can run. Retry after the skill prompt is loaded.',
    is_error: true,
  }
}

/** Placeholder tool result pairing an interrupted tool_use so history never dangles. */
function createInterruptedToolResult(
  block: ToolUseBlock,
): ToolResult & { tool_name: string } {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    tool_name: block.name,
    content: 'Error: interrupted by user before execution',
    is_error: true,
  }
}

function compactMetadataContextWindow(metadata?: AgentContextCompactionMetadata): number | undefined {
  if (typeof metadata?.contextWindow === 'number' && Number.isFinite(metadata.contextWindow)) {
    return metadata.contextWindow
  }
  const budget = metadata?.budget
  if (budget && typeof budget === 'object') {
    const record = budget as Record<string, unknown>
    if (typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens)) {
      return record.totalTokens
    }
    if (typeof record.total === 'number' && Number.isFinite(record.total)) {
      return record.total
    }
  }
  return undefined
}

function compactMetadataBudget(metadata?: AgentContextCompactionMetadata): AgentContextCompactionMetadata['budget'] | undefined {
  const budget = metadata?.budget
  if (!budget || typeof budget !== 'object') return undefined
  return budget
}

function mergeCompactionMetadata(
  base: AgentContextCompactionMetadata,
  override?: AgentContextCompactionMetadata,
): AgentContextCompactionMetadata {
  return {
    ...base,
    ...override,
    budget: override?.budget ?? base.budget,
  }
}

function compactionStageMessage(stage: AgentContextCompactionStage): string {
  if (stage === 'summarizing') return '正在生成上下文摘要'
  return '正在恢复压缩后的上下文'
}

/** 流式与非流式两条 retry 路径共用的 api_retry 错误分类（#389 去重）。 */
function classifyRetryError(status: number | null): SDKAssistantMessageError {
  return status === 429
    ? 'rate_limit'
    : status === 400
      ? 'invalid_request'
      : status === 401 || status === 403
        ? 'authentication_failed'
        : status === 500 || status === 502 || status === 503 || status === 529
          ? 'server_error'
          : 'unknown'
}

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  const deferredToolGuide = config.deferredTools?.length
    ? '\n\n部分工具已延迟加载以保持上下文精简。用 ToolSearch 发现它们；匹配的工具在下一回合即可直接按名称调用。可见工具不覆盖任务时，先搜索再判断，不要未搜索就宣称能力不可用。'
    : ''
  if (config.systemPrompt) {
    const structuredOutputInstruction = buildStructuredOutputInstruction(
      config.jsonSchema,
      config.outputFormat,
    )
    const base = (structuredOutputInstruction
      ? `${config.systemPrompt}\n\n${structuredOutputInstruction}`
      : config.systemPrompt) + deferredToolGuide
    return config.appendSystemPrompt
      ? base + '\n\n' + config.appendSystemPrompt
      : base
  }

  const parts: string[] = []

  parts.push(
    'You are an AI assistant with access to tools. Use the tools provided to help the user accomplish their tasks.',
    'You should use tools when they would help you complete the task more accurately or efficiently.',
  )
  if (deferredToolGuide) parts.push(deferredToolGuide.trim())

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)
  if (config.additionalDirectories?.length) {
    parts.push('\n# Additional Working Directories\n')
    for (const dir of config.additionalDirectories) {
      parts.push(`- ${dir}`)
    }
  }

  const structuredOutputInstruction = buildStructuredOutputInstruction(
    config.jsonSchema,
    config.outputFormat,
  )
  if (structuredOutputInstruction) {
    parts.push(`\n# Structured Output\n${structuredOutputInstruction}`)
  }

  if (config.appendSystemPrompt) {
    parts.push('\n' + config.appendSystemPrompt)
  }

  return parts.join('\n')
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: Array<NormalizedMessageParam & {
    usage?: NormalizedProviderUsage
    usageIdentity?: UsageIdentity
  }> = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private usageRecords: BillingUsageRecord[] = []
  private totalCost = 0
  private turnCount = 0
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private permissionDenials: Array<{
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }> = []
  private fileStateCache = new FileStateCache()
  private workingDirectory: string
  /** Tool calls skipped or interrupted by an abort during the current run. */
  private abortedPendingToolCalls: Array<{ id: string; name: string; input: unknown }> = []
  private repeatedToolCalls = new Map<string, RepeatedToolCallState>()
  private blockedRepeatAttempts = 0

  constructor(config: QueryEngineConfig) {
    this.config = config
    // Rebind generated discovery tools to the engine's live deferred list:
    // the agent passes a filtered copy, so promotion must be engine-local.
    if (this.config.deferredTools && this.config.deferredTools.length > 0) {
      const live = () => this.config.deferredTools ?? []
      this.config.tools = this.config.tools.map((tool) =>
        tool.name === 'ToolSearch' ? createToolSearchTool(live)
          : tool.name === 'ExecuteTool' ? createExecuteTool(live)
            : tool)
    }
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
    this.workingDirectory = config.cwd
  }

  private recordProviderUsage(
    usage: CreateMessageResponse['usage'] | NormalizedProviderUsage,
    usageIdentity: UsageIdentity,
    ttftMs?: number,
  ): BillingUsageRecord {
    const normalized = 'input_tokens' in usage
      ? normalizeProviderUsage(usage)
      : usage
    const costUSD = estimateCost(this.config.model, {
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
      cache_read_input_tokens: normalized.cacheReadInputTokens,
      cache_creation_input_tokens: normalized.cacheCreationInputTokens,
    })
    this.totalUsage.input_tokens += normalized.inputTokens
    this.totalUsage.output_tokens += normalized.outputTokens
    if (normalized.cacheCreationInputTokens) {
      this.totalUsage.cache_creation_input_tokens =
        (this.totalUsage.cache_creation_input_tokens || 0) +
        normalized.cacheCreationInputTokens
    }
    if (normalized.cacheReadInputTokens) {
      this.totalUsage.cache_read_input_tokens =
        (this.totalUsage.cache_read_input_tokens || 0) +
        normalized.cacheReadInputTokens
    }
    this.totalCost += costUSD
    const record: BillingUsageRecord = {
      ...normalized,
      usageIdentity,
      callerLabel: usageIdentity.callerLabel ?? `Turn ${this.turnCount}`,
      model: this.config.model,
      costUSD,
      ...(usageIdentity.turn !== undefined ? { turn: usageIdentity.turn } : {}),
      ...(ttftMs !== undefined ? { ttftMs: Math.max(0, Math.round(ttftMs)) } : {}),
    }
    this.usageRecords.push(record)
    return record
  }

  private optionalUsageRecords(): { usageRecords?: SDKUsageRecord[] } {
    return this.usageRecords.length > 0
      ? { usageRecords: this.usageRecords.map((record) => ({
          ...record,
          callerKind: record.usageIdentity.callerKind,
          threadId: record.usageIdentity.threadId,
          ...(record.usageIdentity.runId ? { runId: record.usageIdentity.runId } : {}),
          ...(record.usageIdentity.parentThreadId ? { parentThreadId: record.usageIdentity.parentThreadId } : {}),
          ...(record.usageIdentity.parentRunId ? { parentRunId: record.usageIdentity.parentRunId } : {}),
          ...(record.usageIdentity.subagentRunId ? { subagentRunId: record.usageIdentity.subagentRunId } : {}),
          ...(record.usageIdentity.responseId ? { responseId: record.usageIdentity.responseId } : {}),
        })) }
      : {}
  }

  private createUsageIdentity(
    callerKind: UsageIdentity['callerKind'],
    options: Partial<Omit<UsageIdentity, 'threadId' | 'callerKind'>> = {},
  ): UsageIdentity {
    return {
      threadId: this.sessionId,
      callerKind,
      // runId 用真实 run 标识(config.runId 由 Agent.run opts 透传);
      // 缺省回落 sessionId——此前恒用 sessionId 导致 usageIdentity 无法按 run 聚合
      runId: this.config.runId ?? this.sessionId,
      responseId: crypto.randomUUID(),
      ...options,
    }
  }

  private createBillingUsageSummary(): BillingUsageSummary {
    const cumulative = normalizeProviderUsage({
      input_tokens: this.totalUsage.input_tokens,
      output_tokens: this.totalUsage.output_tokens,
      cache_read_input_tokens: this.totalUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: this.totalUsage.cache_creation_input_tokens ?? 0,
    })
    return {
      cumulative,
      ...(this.usageRecords.length > 0 ? { latestRecord: { ...this.usageRecords[this.usageRecords.length - 1]! } } : {}),
      records: this.usageRecords.map((record) => ({ ...record })),
      totalCostUSD: this.totalCost,
    }
  }

  private normalizedUsageFromRecord(record: BillingUsageRecord): NormalizedProviderUsage {
    return {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      totalTokens: record.totalTokens,
    }
  }

  private getContextWindow(): number {
    return this.config.contextWindow ?? getContextWindowSize(this.config.model)
  }

  private estimateToolSchemaTokens(): number {
    // 与 tool-search 的 getDeferredToolTokenCount 同一口径：name + description +
    // inputSchema 全算（#389）。此前漏 inputSchema 导致 contextUsage 低估工具占比。
    return getDeferredToolTokenCount(this.config.tools)
  }

  private createContextUsage(): ContextUsageSnapshot {
    return createContextUsageSnapshot(this.messages, {
      threadId: this.sessionId,
      contextWindow: this.getContextWindow(),
      contextWindowSource: 'model',
      systemTokens: estimateSystemPromptTokens(this.config.systemPrompt || ''),
      memoryTokens: 0,
      toolSchemaTokens: this.estimateToolSchemaTokens(),
    })
  }

  private createResultUsageFields(): {
    usage: TokenUsage
    model_usage: Record<string, { input_tokens: number; output_tokens: number }>
    modelUsage: Record<string, {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
      contextWindow: number
      maxOutputTokens: number
    }>
    usageRecords?: SDKUsageRecord[]
    billingUsage: BillingUsageSummary
    contextUsage: ContextUsageSnapshot
  } {
    const contextUsage = this.createContextUsage()
    const usage = { ...this.totalUsage }
    const snakeCaseUsage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    }
    const camelCaseUsage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: this.totalCost,
      contextWindow: contextUsage.contextWindow,
      maxOutputTokens: this.config.maxTokens,
    }
    return {
      usage,
      model_usage: { [this.config.model]: snakeCaseUsage },
      modelUsage: { [this.config.model]: camelCaseUsage },
      ...this.optionalUsageRecords(),
      billingUsage: this.createBillingUsageSummary(),
      contextUsage,
    }
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookExecutionResult> {
    if (!this.hookRegistry?.hasHooks(event)) {
      return { outputs: [], events: [] }
    }
    try {
      return await this.hookRegistry.executeDetailed(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...extra,
      })
    } catch {
      return { outputs: [], events: [] }
    }
  }

  private isManualCompactPrompt(prompt: string | ContentBlockParam[]): boolean {
    return typeof prompt === 'string' && prompt.trim() === '/compact'
  }

  private async shouldCompactAutomatically(): Promise<boolean> {
    const contextUsage = this.createContextUsage()
    const estimatedTokens = contextUsage.totalTokens
    const controller = this.config.contextController
    if (controller?.shouldAutoCompact) {
      return controller.shouldAutoCompact({
        messages: this.messages,
        model: this.config.model,
        state: this.compactState,
        estimatedTokens,
        contextUsage,
      })
    }
    return shouldAutoCompact(this.messages as any[], this.config.model, this.compactState, {
      contextUsage,
      maxOutputTokens: this.config.maxTokens,
    })
  }

  private async compactMessages(
    trigger: AgentContextCompactionTrigger,
    preTokens: number,
    protectedMessageIndex?: number,
  ): Promise<{
    compacted: boolean
    compactedMessages: NormalizedMessageParam[]
    summary: string
    failureReason?: import('./utils/compact.js').CompactionFailureReason
    retainedTokens?: number
    retainedMessageCount?: number
    state: AutoCompactState
    metadata?: AgentContextCompactionMetadata
    usage?: NormalizedProviderUsage
  }> {
    const controller = this.config.contextController
    if (controller?.compactConversation) {
      const result = await controller.compactConversation({
        provider: this.provider,
        model: this.config.model,
        messages: this.messages,
        state: this.compactState,
        trigger,
        preTokens,
        protectedMessageIndex,
        abortSignal: this.config.abortSignal,
      })
      return {
        compacted: result.compacted ?? true,
        compactedMessages: result.compactedMessages,
        summary: result.summary,
        failureReason: result.failureReason,
        retainedTokens: result.retainedTokens,
        retainedMessageCount: result.retainedMessageCount,
        state: result.state ?? {
          ...this.compactState,
          compacted: true,
          consecutiveFailures: 0,
        },
        metadata: result.metadata,
        usage: result.usage,
      }
    }
    return defaultCompactConversation(
      this.provider,
      this.config.model,
      this.messages as any[],
      this.compactState,
      {
        trigger,
        reserveTokens: Math.min(this.config.maxTokens, 20_000),
        protectedMessageIndex,
        abortSignal: this.config.abortSignal,
      },
    )
  }

  private createCompactionStartedEvent(
    trigger: AgentContextCompactionTrigger,
    preTokens: number,
    metadata?: AgentContextCompactionMetadata,
  ): SDKMessage {
    return {
      type: 'system',
      subtype: 'context_compaction_started',
      compact_metadata: {
        trigger,
        pre_tokens: preTokens,
        ...(compactMetadataContextWindow(metadata) !== undefined
          ? { context_window: compactMetadataContextWindow(metadata) }
          : {}),
        ...(compactMetadataBudget(metadata) ? { budget: compactMetadataBudget(metadata) } : {}),
        ...(typeof metadata?.policy === 'string' ? { policy: metadata.policy } : {}),
        ...(typeof metadata?.source === 'string' ? { source: metadata.source } : {}),
      },
      session_id: this.sessionId,
    } as SDKMessage
  }

  private createCompactionProgressEvent(
    trigger: AgentContextCompactionTrigger,
    preTokens: number,
    stage: AgentContextCompactionStage,
    progress: number,
    metadata?: AgentContextCompactionMetadata,
  ): SDKMessage {
    return {
      type: 'system',
      subtype: 'context_compaction_progress',
      compact_metadata: {
        trigger,
        pre_tokens: preTokens,
        stage,
        progress,
        message: compactionStageMessage(stage),
        ...(compactMetadataContextWindow(metadata) !== undefined
          ? { context_window: compactMetadataContextWindow(metadata) }
          : {}),
        ...(compactMetadataBudget(metadata) ? { budget: compactMetadataBudget(metadata) } : {}),
        ...(typeof metadata?.policy === 'string' ? { policy: metadata.policy } : {}),
        ...(typeof metadata?.source === 'string' ? { source: metadata.source } : {}),
      },
      session_id: this.sessionId,
    } as SDKMessage
  }

  private createCompactBoundaryEvent(
    boundary: AgentContextCompactionBoundary,
  ): SDKMessage {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: boundary.trigger,
        pre_tokens: boundary.preTokens,
        ...(boundary.postTokens !== undefined ? { post_tokens: boundary.postTokens } : {}),
        ...(compactMetadataContextWindow(boundary.metadata) !== undefined
          ? { context_window: compactMetadataContextWindow(boundary.metadata) }
          : {}),
        ...(compactMetadataBudget(boundary.metadata) ? { budget: compactMetadataBudget(boundary.metadata) } : {}),
        ...(boundary.summary ? { summary: boundary.summary } : {}),
        ...(typeof boundary.metadata?.policy === 'string' ? { policy: boundary.metadata.policy } : {}),
        ...(typeof boundary.metadata?.source === 'string' ? { source: boundary.metadata.source } : {}),
        ...(Array.isArray(boundary.metadata?.sourceMessageIds)
          ? { source_message_ids: boundary.metadata.sourceMessageIds }
          : {}),
        ...(boundary.metadata?.preservedSegment
          ? { preserved_segment: boundary.metadata.preservedSegment }
          : {}),
        ...(boundary.metadata?.outcome ? { outcome: boundary.metadata.outcome } : {}),
        ...(boundary.metadata?.failureReason
          ? { failure_reason: boundary.metadata.failureReason }
          : {}),
        ...(typeof boundary.metadata?.retainedTokens === 'number'
          ? { retained_tokens: boundary.metadata.retainedTokens }
          : {}),
        ...(typeof boundary.metadata?.retainedMessageCount === 'number'
          ? { retained_message_count: boundary.metadata.retainedMessageCount }
          : {}),
      },
      session_id: this.sessionId,
    } as SDKMessage
  }

  private async getCompactionStartMetadata(
    trigger: AgentContextCompactionTrigger,
    preTokens: number,
  ): Promise<AgentContextCompactionMetadata | undefined> {
    const baseMetadata: AgentContextCompactionMetadata = {
      contextWindow: this.getContextWindow(),
    }
    const controller = this.config.contextController
    if (!controller?.getCompactionMetadata) return baseMetadata
    try {
      return mergeCompactionMetadata(baseMetadata, await controller.getCompactionMetadata({
        messages: this.messages,
        model: this.config.model,
        state: this.compactState,
        trigger,
        preTokens,
      }))
    } catch {
      return baseMetadata
    }
  }

  private async *runCompaction(
    trigger: AgentContextCompactionTrigger,
    protectedMessageIndex?: number,
  ): AsyncGenerator<SDKMessage, boolean> {
    const preTokens = this.createContextUsage().totalTokens
    const startMetadata = await this.getCompactionStartMetadata(trigger, preTokens)
    yield this.createCompactionStartedEvent(trigger, preTokens, startMetadata)
    yield this.createCompactionProgressEvent(trigger, preTokens, 'summarizing', 45, startMetadata)

    const result = await this.compactMessages(trigger, preTokens, protectedMessageIndex)
    const resultMetadata = mergeCompactionMetadata({
      contextWindow: this.getContextWindow(),
      outcome: result.compacted ? 'succeeded' : 'failed',
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(typeof result.retainedTokens === 'number' ? { retainedTokens: result.retainedTokens } : {}),
      ...(typeof result.retainedMessageCount === 'number'
        ? { retainedMessageCount: result.retainedMessageCount }
        : {}),
    }, result.metadata)
    if (result.usage) {
      this.recordProviderUsage(result.usage, this.createUsageIdentity('compaction', {
        callerLabel: 'Compaction',
        turn: this.turnCount,
      }))
    }
    this.compactState = result.state
    if (!result.compacted) {
      const boundary: AgentContextCompactionBoundary = {
        trigger,
        preTokens,
        postTokens: estimateMessagesTokens(this.messages),
        metadata: resultMetadata,
      }
      await this.config.contextController?.onCompactionBoundary?.(boundary)
      yield this.createCompactBoundaryEvent(boundary)
      return false
    }

    yield this.createCompactionProgressEvent(trigger, preTokens, 'rewriting_context', 85, resultMetadata)
    const latestRuntimeMessage = [...this.messages]
      .reverse()
      .find((message) => message.role === 'runtime')
    const compactedMessages = result.compactedMessages.filter((message) => message.role !== 'runtime')
    this.messages = latestRuntimeMessage
      ? [...compactedMessages, latestRuntimeMessage]
      : compactedMessages
    const boundary: AgentContextCompactionBoundary = {
      trigger,
      preTokens,
      postTokens: estimateMessagesTokens(this.messages),
      summary: result.summary,
      metadata: resultMetadata,
    }
    await this.config.contextController?.onCompactionBoundary?.(boundary)
    yield this.createCompactBoundaryEvent(boundary)
    return true
  }

  private async microCompactForProvider(messages: NormalizedMessageParam[]): Promise<NormalizedMessageParam[]> {
    const controller = this.config.contextController
    if (controller?.microCompactMessages) {
      return controller.microCompactMessages({
        messages,
        model: this.config.model,
      })
    }
    return defaultMicroCompactMessages(messages as any[]) as NormalizedMessageParam[]
  }

  private async buildPermissionMetadata(
    block: ToolUseBlock,
    tool: ToolDefinition,
    context: ToolContext,
  ) {
    const payload =
      block.input && typeof block.input === 'object'
        ? (block.input as Record<string, unknown>)
        : {}
    const filePath = tool.getPath
      ? await tool.getPath(block.input, context)
      : typeof payload.file_path === 'string'
        ? resolve(this.config.cwd, payload.file_path)
        : undefined

    return {
      toolUseId: block.id,
      blockedPath: filePath,
      title: `${tool.name} permission request`,
      displayName: tool.name,
      description: tool.description,
      decisionReason: `Tool "${tool.name}" requires permission review`,
      permissionSuggestions:
        filePath && !tool.isReadOnly?.(block.input, context)
          ? [{
              type: 'addRules' as const,
              rules: [{ toolName: tool.name }],
              behavior: 'allow' as const,
              destination: 'session' as const,
            }]
          : undefined,
    }
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    const setupHooks = await this.executeHooks('Setup')
    for (const event of setupHooks.events) yield event

    // Hook: SessionStart
    const sessionStartHooks = await this.executeHooks('SessionStart')
    for (const event of sessionStartHooks.events) yield event

    // Hook: UserPromptSubmit
    const userHookResults = this.config.toolContinuations?.length
      ? { events: [], outputs: [] }
      : await this.executeHooks('UserPromptSubmit', { toolInput: prompt })
    for (const event of userHookResults.events) yield event
    // Check if any hook blocks the submission
    if (userHookResults.outputs.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        ...this.createResultUsageFields(),
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    if (this.isManualCompactPrompt(prompt)) {
      const compacted = yield* this.runCompaction('manual')
      yield {
        type: 'result',
        subtype: compacted ? 'success' : 'error_during_execution',
        session_id: this.sessionId,
        is_error: !compacted,
        num_turns: 0,
        total_cost_usd: this.totalCost,
        duration_api_ms: Math.round(this.apiTimeMs),
        ...this.createResultUsageFields(),
        cost: this.totalCost,
        ...(!compacted ? { errors: ['Context compaction failed; the original context was preserved.'] } : {}),
      } as SDKMessage
      return
    }

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(this.config)

    // Emit init system message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.tools.map(t => t.name),
      model: this.config.model,
      cwd: this.workingDirectory,
      permission_mode: this.config.permissionMode || 'bypassPermissions',
      permissionMode: this.config.permissionMode || 'bypassPermissions',
      agents: this.config.agents ? Object.keys(this.config.agents) : [],
      apiKeySource: this.config.initialization?.apiKeySource || 'unknown',
      slash_commands: this.config.initialization?.slashCommands || [],
      skills: this.config.initialization?.skills || [],
      plugins: this.config.initialization?.plugins || [],
      output_style: this.config.initialization?.outputStyle || 'text',
      claude_code_version: this.config.initialization?.claudeCodeVersion || 'open-agent-sdk/0.2.0',
    } as SDKMessage

    // Match Pi's timing: compact completed history once before appending the
    // new user turn. Tool-loop growth is handled by prompt-too-long recovery.
    let autoCompacted = false
    try {
      if (await this.shouldCompactAutomatically()) {
        await this.executeHooks('PreCompact')
        autoCompacted = yield* this.runCompaction('auto')
        if (autoCompacted) await this.executeHooks('PostCompact')
      }
    } catch {
      // Host-owned compaction remains fail-open for normal conversation turns.
    }

    // Runtime context is persisted in history but remains an internal message.
    // Each turn re-emits the full runtime context (policy text plus per-turn
    // state snapshots), so only the latest copy is kept, re-appended just
    // before the new user turn: older copies carry no information the newest
    // one does not, and retaining them would grow history linearly over a long
    // session. Compaction rebuilds history on the same single-latest-copy
    // assumption.
    if (this.config.runtimeContext?.trim()) {
      const nextRuntime: NormalizedMessageParam = { role: 'runtime', content: this.config.runtimeContext.trim() }
      this.messages = [
        ...this.messages.filter((message) => message.role !== 'runtime'),
        nextRuntime,
      ]
    }

    // Exact cold-start continuations resume at the persisted tool boundary,
    // so they must not add a second model-facing user prompt.
    let protectedMessageIndex: number | undefined
    // Reset per-run abort bookkeeping before any tool execution (continuations
    // included) so run_aborted reflects this run's interrupted tool calls.
    this.abortedPendingToolCalls = []
    this.repeatedToolCalls.clear()
    this.blockedRepeatAttempts = 0

    if (!this.config.toolContinuations?.length) {
      protectedMessageIndex = this.messages.length
      this.messages.push({ role: 'user', content: prompt as any })
    }

    if (this.config.toolContinuations?.length) {
      // Result-side idempotency: a continuation whose tool_use_id already has
      // a tool_result in history (e.g. abort placeholders persisted by the
      // engine) must not be executed or injected again — a second result for
      // the same id is rejected by the provider.
      const answeredToolUseIds = new Set<string>()
      for (const message of this.messages) {
        if (message.role !== 'user' || !Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            answeredToolUseIds.add(block.tool_use_id)
          }
        }
      }
      const continuations = this.config.toolContinuations.filter(
        (persisted) => !answeredToolUseIds.has(persisted.toolCall.id),
      )
      if (continuations.length > 0) {
        const blocks: ToolUseBlock[] = continuations.map((persisted) => ({
          type: 'tool_use',
          id: persisted.toolCall.id,
          name: persisted.toolCall.name,
          input: persisted.toolCall.input,
        }))
        // Idempotent rebuild: only push the assistant blocks that are not already present.
        const missing = blocks.filter((block) => !this.messages.some((message) => (
          message.role === 'assistant'
          && Array.isArray(message.content)
          && message.content.some((content) => content.type === 'tool_use' && content.id === block.id)
        )))
        if (missing.length > 0) {
          this.messages.push({ role: 'assistant', content: missing })
        }
        const allResults: Array<{ result: ToolResult & { tool_name?: string }; toolName: string }> = []
        for (const persisted of continuations) {
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: persisted.toolCall.id,
            name: persisted.toolCall.name,
            input: persisted.toolCall.input,
          }
          const execution = persisted.toolResult
            ? { results: [{ ...persisted.toolResult, tool_use_id: block.id, tool_name: block.name }], events: [], toolsUsed: [block.name] }
            : await this.executeTools([block])
          for (const event of execution.events) yield event
          for (const result of execution.results) {
            const toolName = result.tool_name || block.name
            allResults.push({ result, toolName })
            yield {
              type: 'tool_result',
              result: {
                tool_use_id: result.tool_use_id,
                tool_name: toolName,
                output: formatToolResultOutput(result.content),
                content: result.content,
                is_error: result.is_error === true,
                ...(result._meta ? { _meta: result._meta } : {}),
              },
            }
          }
        }
        this.messages.push({
          role: 'user',
          content: allResults.map(({ result }) => ({
            type: 'tool_result' as const,
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
            ...(result._meta ? { _meta: result._meta } : {}),
          })),
        })
      }
    }

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let structuredOutputRetriesExceeded = false
    let completedNaturally = false
    let completionGuardStop: { message: string; errorCode?: string } | undefined
    let maxTokensExhausted = false
    let maxOutputRecoveryAttempts = 0
    const MAX_OUTPUT_RECOVERY = 3
    let structuredOutputRetryAttempts = 0
    const MAX_STRUCTURED_OUTPUT_RETRIES = 2

    turnLoop: while (turnsRemaining > 0) {
      // Soft abort: skip further turns and fall through to normal finalization.
      if (this.config.abortSignal?.aborted) break turnLoop

      // Check budget
      if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Micro-compact: truncate large tool results
      const internalContextBlocks = collectInternalContextBlocks(this.messages as any[])
      const computerUseActionFacts = renderComputerUseActionFacts(this.messages as any[])
      const conversationMessages = stripInternalContextBlocks(this.messages as any[])
      const hydratedMessages = await hydrateEphemeralImageReferences(conversationMessages)
      const apiMessages = await this.microCompactForProvider(
        normalizeMessagesForAPI(hydratedMessages) as NormalizedMessageParam[],
      )
      const transientRuntimeContext = [
        internalContextBlocks.length > 0
          ? `<internal_context type="compaction">\n${internalContextBlocks.join('\n\n')}\n</internal_context>`
          : '',
        computerUseActionFacts
          ? `<internal_context type="computer_use_action_ledger">\n${computerUseActionFacts}\n</internal_context>`
          : '',
      ].filter(Boolean).join('\n\n')
      if (transientRuntimeContext) {
        apiMessages.push({ role: 'runtime', content: transientRuntimeContext })
      }

      const skillCatalog = renderSkillCatalog(
        this.config.skillRegistry?.getModelInvocable() ?? getModelInvocableSkills(),
      )
      if (skillCatalog) {
        apiMessages.push({ role: 'runtime', content: skillCatalog })
      }

      this.turnCount++
      turnsRemaining--
      const tools = this.config.tools.map(toProviderTool)

      // Make API call with retry via provider
      let response: CreateMessageResponse
      const providerRequest: CreateMessageParams = {
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        system: systemPrompt,
        messages: apiMessages,
        tools: tools.length > 0 ? tools : undefined,
        jsonSchema: this.config.jsonSchema,
        outputFormat: this.config.outputFormat,
        effort: this.config.effort,
        promptCache: this.config.promptCache,
        abortSignal: this.config.abortSignal,
        thinking:
          this.config.thinking?.type === 'enabled' &&
          this.config.thinking.budgetTokens
            ? {
                type: 'enabled',
                budget_tokens: this.config.thinking.budgetTokens,
              }
            : this.config.thinking?.type === 'disabled'
              ? { type: 'disabled' }
              : undefined,
      }
      const apiStart = performance.now()
      let firstResponseAt: number | undefined
      try {
        if (this.config.includePartialMessages && this.provider.createMessageStream) {
          const stream = this.provider.createMessageStream(providerRequest)
          // 流重试 delta 抑制（#160）：已转发过 delta 的流一旦中途重试（或路由切换），
          // 重试成功后会从头重发全量 delta，继续转发会让 UI 出现重复前缀、并污染
          // 无 assistant.final 回放路径的重建文本。抑制后 UI 保留旧前缀直到 done 的
          // 完整 response 落地（最终一致性由 done 保证）。retry 前无 delta 则不抑制。
          let emittedAnyDelta = false
          let suppressStreamDeltas = false

          while (true) {
            // Soft abort mid-stream: the response is incomplete and no tool_use
            // was committed, so abandon the turn without pairing obligations.
            if (this.config.abortSignal?.aborted) break turnLoop
            const next = await stream.next()
            if (next.done) {
              response = next.value as CreateMessageResponse
              break
            }

            const chunk = next.value as CreateMessageStreamEvent
            if (chunk.type === 'retry_state' && chunk.phase === 'waiting' && emittedAnyDelta) {
              suppressStreamDeltas = true
            }
            if ((chunk.type === 'text_delta' || chunk.type === 'thinking_delta') && suppressStreamDeltas) {
              continue
            }
            if (chunk.type === 'text_delta' && chunk.text) {
              firstResponseAt ??= performance.now()
              emittedAnyDelta = true
              // Official Claude Agent SDK format (stream_event)
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: chunk.text },
                },
                parent_tool_use_id: null,
                session_id: this.sessionId,
              }
              // Legacy format - kept for backward compatibility
              yield {
                type: 'partial_message',
                partial: {
                  type: 'text',
                  text: chunk.text,
                },
              }
            }
            if (chunk.type === 'thinking_delta' && chunk.thinking) {
              firstResponseAt ??= performance.now()
              emittedAnyDelta = true
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'thinking_delta', thinking: chunk.thinking },
                },
                parent_tool_use_id: null,
                session_id: this.sessionId,
              }
            }
            if (chunk.type === 'retry_state') {
              const status = chunk.errorStatus
              const errorType = classifyRetryError(status)
              yield {
                type: 'system',
                subtype: 'api_retry',
                phase: chunk.phase,
                attempt: chunk.attempt,
                max_retries: chunk.maxRetries,
                retry_delay_ms: chunk.retryDelayMs,
                error_status: status,
                error: errorType,
                session_id: this.sessionId,
              }
            }
          }
        } else {
          const retryEvents: SDKMessage[] = []
          response = await withRetry(
            async () => this.provider.createMessage(providerRequest),
            undefined,
            this.config.abortSignal,
            async (retry) => {
              const status = typeof retry.error?.status === 'number' ? retry.error.status : null
              const errorType = classifyRetryError(status)
              const event: SDKMessage = {
                type: 'system',
                subtype: 'api_retry',
                attempt: retry.attempt,
                max_retries: retry.maxRetries,
                retry_delay_ms: retry.retryDelayMs,
                error_status: status,
                error: errorType,
                session_id: this.sessionId,
              }
              retryEvents.push(event)
              // Deliver through the async channel immediately so hosts see
              // retries as they happen instead of after the whole backoff
              // sequence (matching the streaming path). The buffer is only a
              // fallback for engines without a host callback.
              try {
                this.config.onAsyncEvent?.(event)
              } catch {
                // Host event delivery must not break the retry loop.
              }
            },
          )
          if (!this.config.onAsyncEvent) {
            for (const retryEvent of retryEvents) {
              yield retryEvent
            }
          }
        }
      } catch (err: any) {
        // Soft abort: the provider call failed because the run was aborted.
        // Finalize normally instead of propagating to the caller.
        if (this.config.abortSignal?.aborted) {
          break turnLoop
        }
        const stopFailureHooks = await this.executeHooks('StopFailure', {
          error: err?.message || 'Unknown provider error',
        })
        for (const event of stopFailureHooks.events) yield event
        // Handle prompt-too-long by compacting. Gate on consecutive compaction
        // failures (reset to 0 on success) instead of the one-shot `compacted`
        // flag: a tool loop can outgrow the window a second time, and repeated
        // failures trip the breaker on their own.
        if (isPromptTooLongError(err) && this.compactState.consecutiveFailures < 3) {
          try {
            const compacted = yield* this.runCompaction('prompt_too_long', protectedMessageIndex)
            if (compacted) {
              turnsRemaining++ // Retry this turn
              this.turnCount--
              continue
            }
          } catch {
            // Preserve the original provider error when compaction itself fails.
          }
        }

        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          ...this.createResultUsageFields(),
          num_turns: this.turnCount,
          cost: this.totalCost,
          errors: [err?.message || 'Unknown provider error'],
        }
        return
      }

      this.messages = releaseEphemeralImageReferences(this.messages as any[]) as NormalizedMessageParam[]

      // Track API timing
      const apiEnd = performance.now()
      this.apiTimeMs += apiEnd - apiStart

      const usageIdentity = this.createUsageIdentity('conversation', {
        callerLabel: `Turn ${this.turnCount}`,
        turn: this.turnCount,
      })
      let usageRecord: BillingUsageRecord | undefined

      // Track usage (normalized by provider)
      if (response.usage) {
        usageRecord = this.recordProviderUsage(
          response.usage,
          usageIdentity,
          (firstResponseAt ?? apiEnd) - apiStart,
        )
      }

      // Add assistant message to conversation
      this.messages.push({
        role: 'assistant',
        content: response.content as any,
        ...(usageRecord ? { usage: this.normalizedUsageFromRecord(usageRecord), usageIdentity } : {}),
      })

      // Yield assistant message
      yield {
        type: 'assistant',
        session_id: this.sessionId,
        message: {
          role: 'assistant',
          content: response.content as any,
        },
        ...(usageRecord ? {
          usage: this.normalizedUsageFromRecord(usageRecord),
          usageIdentity,
          costUSD: usageRecord.costUSD,
        } : {}),
      }

      if (this.config.initialization?.outputStyle === 'streamlined') {
        const streamlinedText = createStreamlinedTextMessage(response, this.sessionId)
        if (streamlinedText) {
          yield streamlinedText
        }
        const streamlinedToolSummary = createStreamlinedToolUseSummaryMessage(
          response,
          this.sessionId,
        )
        if (streamlinedToolSummary) {
          yield streamlinedToolSummary
        }
      }

      yield summarizeAssistantTurn(response, this.sessionId)

      // Handle max_output_tokens recovery
      if (response.stopReason === 'max_tokens') {
        // A truncated turn can end mid-tool_use; leaving it unanswered makes
        // the next request invalid (provider 400) with no recovery path.
        // Close them with placeholder results before continuing (#304).
        const pendingToolUse = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use',
        )
        if (maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY) {
          maxOutputRecoveryAttempts++
          if (pendingToolUse.length > 0) {
            this.messages.push({
              role: 'user',
              content: [
                ...pendingToolUse.map((block) => createInterruptedToolResult(block)),
                {
                  type: 'text',
                  text: 'Please continue from where you left off.',
                },
              ],
            })
          } else {
            // Add continuation prompt
            this.messages.push({
              role: 'user',
              content: 'Please continue from where you left off.',
            })
          }
          continue
        }
        // Continuation budget exhausted on a truncated, tool-free answer:
        // report it as an error instead of dressing truncation up as success.
        if (pendingToolUse.length === 0) {
          maxTokensExhausted = true
          break
        }
      }

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      )

      const structuredOutput = parseStructuredOutput(
        extractAssistantText(response),
        this.config.jsonSchema,
        this.config.outputFormat,
      )

      if (
        toolUseBlocks.length === 0 &&
        (this.config.jsonSchema || this.config.outputFormat) &&
        structuredOutput === undefined
      ) {
        if (structuredOutputRetryAttempts < MAX_STRUCTURED_OUTPUT_RETRIES) {
          structuredOutputRetryAttempts++
          this.messages.push({
            role: 'user',
            content:
              'Your previous response did not match the requested JSON schema. Your response must begin with `{` as the very first character — no prose, markdown fences, or commentary before it — and contain only valid JSON matching the schema exactly.',
          })
          continue
        }
        structuredOutputRetriesExceeded = true
        break
      }

      if (toolUseBlocks.length === 0) {
        const feedback = await this.config.completionGuard?.()
        if (feedback) {
          if (typeof feedback !== 'string' && feedback.type === 'stop') {
            completionGuardStop = feedback
            break
          }
          const feedbackText = typeof feedback === 'string' ? feedback : feedback.message
          this.messages.push({
            role: 'user',
            content: feedbackText,
          })
          continue
        }
        completedNaturally = true
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Execute tools (concurrent read-only, serial mutations)
      const { results: toolResults, events: toolEvents, toolsUsed, repeatGuardStop } =
        await this.executeTools(toolUseBlocks)
      for (const toolEvent of toolEvents) {
        yield toolEvent
      }

      // Yield tool results
      for (const result of toolResults) {
        yield {
          type: 'tool_result',
          result: {
            tool_use_id: result.tool_use_id,
            tool_name: result.tool_name || '',
            output: formatToolResultOutput(result.content),
            content: result.content,
            is_error: result.is_error === true,
            ...(result._meta ? { _meta: result._meta } : {}),
          },
        }
      }

      // Add tool results to conversation
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
          ...(r._meta ? { _meta: r._meta } : {}),
        })),
      })

      if (repeatGuardStop) {
        completionGuardStop = repeatGuardStop
        break
      }

      if (response.stopReason === 'end_turn') break

      if (this.config.promptSuggestions && toolsUsed.length > 0) {
        yield {
          type: 'tool_use_summary',
          summary: `Used tools: ${toolsUsed.join(', ')}`,
          preceding_tool_use_ids: toolUseBlocks.map((block) => block.id),
          session_id: this.sessionId,
        }
      }
    }

    // Soft abort: report the interrupted boundary (tool calls that never ran)
    // via onAsyncEvent so hosts can offer resumption later.
    const runAborted = this.config.abortSignal?.aborted === true
    if (runAborted) {
      this.config.onAsyncEvent?.({
        type: 'system',
        subtype: 'run_aborted',
        pending_tool_calls: this.abortedPendingToolCalls,
        session_id: this.sessionId,
      })
    }

    // Hook: Stop (end of agentic loop)
    const stopHooks = await this.executeHooks('Stop', {
      // Expose the bounded, normalized conversation to host-owned post-turn
      // reviewers without changing the model-visible prompt.
      messages: this.messages,
    })
    for (const event of stopHooks.events) yield event

    // Hook: SessionEnd
    const sessionEndHooks = await this.executeHooks('SessionEnd')
    for (const event of sessionEndHooks.events) yield event

    // Yield enriched final result
    const endSubtype = runAborted
      ? 'error_during_execution'
      : budgetExceeded
      ? 'error_max_budget_usd'
      : maxTokensExhausted
        ? 'error_max_output_tokens'
      : structuredOutputRetriesExceeded
        ? 'error_max_structured_output_retries'
      : completionGuardStop
        ? 'error_completion_guard'
      : turnsRemaining <= 0 && !completedNaturally
        ? 'error_max_turns'
        : 'success'

    const finalText = [...this.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const textContent = Array.isArray(finalText?.content)
      ? finalText?.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n')
      : ''
    const structuredOutput = parseStructuredOutput(
      textContent,
      this.config.jsonSchema,
      this.config.outputFormat,
    )

    yield {
      type: 'result',
      subtype: endSubtype,
      session_id: this.sessionId,
      // 用户中止显式携带 stop_reason：projector/web 端按此归一为 aborted，
      // 不再与 error_during_execution 的失败语义混同（#401）。
      ...(runAborted ? { stop_reason: 'aborted' as const } : {}),
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      ...this.createResultUsageFields(),
      cost: this.totalCost,
      permission_denials: this.permissionDenials,
      structured_output: structuredOutput,
      errors: runAborted
        ? ['Run aborted by user.']
        : completionGuardStop
        ? [completionGuardStop.message]
        : structuredOutputRetriesExceeded
          ? ['Structured output validation failed after retry attempts.']
        : maxTokensExhausted
          ? ['Response reached the output token limit and continuation attempts were exhausted.']
        : undefined,
      // Structured attribution for guard-driven stops so hosts can tell an SDK
      // internal repeat-guard stop ('repeated_tool_call') apart from their own
      // completionGuard policy stops without matching on English messages.
      ...(completionGuardStop?.errorCode ? { errorCode: completionGuardStop.errorCode } : {}),
    }

    if (this.config.promptSuggestions && textContent) {
      const suggestion = generatePromptSuggestion(textContent)
      if (suggestion) {
        yield {
          type: 'prompt_suggestion',
          suggestion,
          session_id: this.sessionId,
        }
      }
    }
  }

  /**
   * Execute tool calls with concurrency control.
   *
   * Read-only tools run concurrently (up to 10 at a time).
   * Mutation tools run sequentially.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<{
    results: (ToolResult & { tool_name?: string })[]
    events: SDKMessage[]
    toolsUsed: string[]
    repeatGuardStop?: { message: string; errorCode: string }
  }> {
    const events: SDKMessage[] = []
    const toolsUsed: string[] = []
    const context: ToolContext = {
      cwd: this.config.cwd,
      abortSignal: this.config.abortSignal,
      provider: this.provider,
      model: this.config.model,
      apiType: this.provider.apiType,
      sessionId: this.sessionId,
      runId: this.config.runId,
      currentUserMessageId: this.config.currentUserMessageId,
      setWorkingDirectory: (cwd) => {
        this.workingDirectory = resolve(cwd)
      },
      additionalDirectories: this.config.additionalDirectories,
      sandbox: this.config.sandbox,
      toolConfig: this.config.toolConfig,
      fileStateCache: this.fileStateCache,
      artifactsRoot: this.config.artifactsRoot,
      onToolExecution: this.config.onToolExecution,
      onBeforeToolExecution: this.config.onBeforeToolExecution,
      permissionMode: this.config.permissionMode,
      hookRegistry: this.hookRegistry,
      skillRegistry: this.config.skillRegistry,
      emitEvent: (event) => {
        events.push(event)
      },
    }

    const parsedConcurrency = parseInt(
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10',
      10,
    )
    // NaN/0/negative would silently skip every concurrent batch or spin forever
    const MAX_CONCURRENCY = Number.isInteger(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 10

    // Sticky across both execution phases: once the guard decides to stop,
    // later successful tools must not clear it and nothing else may execute.
    let repeatGuardStop: { message: string; errorCode: string } | undefined

    // Shared pipeline for the two sequential phases (skill activations and
    // serial mutations): soft-abort break, guard-stop placeholders,
    // interrupted-call fallback, and the events/toolsUsed fan-out.
    // Returns true when the caller must break out (soft abort).
    const runSequentialItem = async (
      block: ToolUseBlock,
      tool: ToolDefinition | undefined,
      storeResult: (result: ToolResult & { tool_name?: string }) => void,
    ): Promise<boolean> => {
      if (this.config.abortSignal?.aborted) return true // soft abort: skip remaining tools
      if (repeatGuardStop) {
        // The guard already decided to stop this run: pair the remaining
        // tool_use blocks with skipped placeholders instead of executing.
        storeResult(createRepeatGuardSkippedToolResult(block))
        return false
      }
      let outcome
      try {
        outcome = await this.executeToolWithRepeatGuard(block, tool, context)
      } catch (error) {
        if (!this.config.abortSignal?.aborted) throw error
        this.abortedPendingToolCalls.push({ id: block.id, name: block.name, input: block.input })
        outcome = {
          result: createInterruptedToolResult(block),
          events: [] as SDKMessage[],
          toolsUsed: [] as string[],
          repeatGuardStop: undefined,
        }
      }
      storeResult(outcome.result)
      events.push(...outcome.events)
      toolsUsed.push(...outcome.toolsUsed)
      if (outcome.repeatGuardStop) repeatGuardStop ??= outcome.repeatGuardStop
      return false
    }

    const hasSkillActivation = toolUseBlocks.some((block) => block.name === 'Skill')
    if (hasSkillActivation && toolUseBlocks.length > 1) {
      const resultsById = new Map<string, ToolResult & { tool_name?: string }>()

      for (const block of toolUseBlocks.filter((item) => item.name === 'Skill')) {
        const aborted = await runSequentialItem(
          block,
          this.config.tools.find((t) => t.name === block.name),
          (result) => resultsById.set(block.id, result),
        )
        if (aborted) break
      }

      for (const block of toolUseBlocks.filter((item) => item.name !== 'Skill')) {
        resultsById.set(block.id, createDeferredSiblingToolResult(block))
      }

      return {
        results: toolUseBlocks.map((block) => {
          const existing = resultsById.get(block.id)
          if (existing) return existing
          if (this.config.abortSignal?.aborted) {
            this.abortedPendingToolCalls.push({ id: block.id, name: block.name, input: block.input })
            return createInterruptedToolResult(block)
          }
          return createDeferredSiblingToolResult(block)
        }),
        events,
        toolsUsed,
        ...(repeatGuardStop ? { repeatGuardStop } : {}),
      }
    }

    // Partition into concurrent (read-only or concurrency-safe) and serial (mutations)
    const concurrent: Array<{ index: number; block: ToolUseBlock; tool?: ToolDefinition }> = []
    const serial: Array<{ index: number; block: ToolUseBlock; tool?: ToolDefinition }> = []

    for (const [index, block] of toolUseBlocks.entries()) {
      const tool = this.config.tools.find((t) => t.name === block.name)
      if (tool?.isReadOnly?.(block.input, context) || tool?.isConcurrencySafe?.(block.input, context)) {
        concurrent.push({ index, block, tool })
      } else {
        serial.push({ index, block, tool })
      }
    }

    const results: Array<(ToolResult & { tool_name?: string }) | undefined> =
      new Array(toolUseBlocks.length)

    // Execute concurrent tools (batched by MAX_CONCURRENCY). Read-only calls go
    // through the same repeat guard as mutations so repeated equivalent results
    // — including failures — are refused without burning real executions.
    for (let i = 0; i < concurrent.length; i += MAX_CONCURRENCY) {
      if (this.config.abortSignal?.aborted) break // soft abort: skip not-yet-started batches
      if (repeatGuardStop) break // guard decided to stop: no further execution
      const batch = concurrent.slice(i, i + MAX_CONCURRENCY)

      // Pre-check signatures synchronously before spawning parallel work.
      const executable: typeof batch = []
      let guardStoppedHere = false
      for (const item of batch) {
        if (guardStoppedHere) {
          results[item.index] = createRepeatGuardSkippedToolResult(item.block)
          continue
        }
        const blocked = this.repeatGuardPreCheck(item.block)
        if (!blocked) {
          executable.push(item)
          continue
        }
        results[item.index] = blocked.result
        if (blocked.repeatGuardStop) {
          repeatGuardStop ??= blocked.repeatGuardStop
          guardStoppedHere = true
        }
      }
      if (executable.length === 0 || repeatGuardStop) continue

      const batchResults = await Promise.allSettled(
        executable.map((item) =>
          this.executeSingleTool(item.block, item.tool, context),
        ),
      )
      for (const [batchIndex, batchResult] of batchResults.entries()) {
        const item = executable[batchIndex]
        if (!item) continue
        if (batchResult.status === 'fulfilled') {
          // Keep completed results even if the abort fired while awaiting.
          results[item.index] = batchResult.value.result
          events.push(...batchResult.value.events)
          toolsUsed.push(...batchResult.value.toolsUsed)
          this.repeatGuardPostRecord(item.block, batchResult.value.result)
        } else if (this.config.abortSignal?.aborted) {
          // Interrupted mid-flight: pair with an error placeholder.
          this.abortedPendingToolCalls.push({ id: item.block.id, name: item.block.name, input: item.block.input })
          results[item.index] = createInterruptedToolResult(item.block)
        } else {
          throw batchResult.reason
        }
      }
    }

    // Execute serial tools sequentially
    for (const item of serial) {
      const aborted = await runSequentialItem(
        item.block,
        item.tool,
        (result) => { results[item.index] = result },
      )
      if (aborted) break
    }

    return {
      results: toolUseBlocks.map((block, index) => {
        const existing = results[index]
        if (existing) return existing
        if (this.config.abortSignal?.aborted) {
          // Skipped by an abort break: still pair the tool_use with a result.
          this.abortedPendingToolCalls.push({ id: block.id, name: block.name, input: block.input })
          return createInterruptedToolResult(block)
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: `Error: Tool "${block.name}" did not return a result`,
          is_error: true,
          tool_name: block.name,
        }
      }),
      events,
      toolsUsed,
      ...(repeatGuardStop ? { repeatGuardStop } : {}),
    }
  }

  /**
   * Repeat guard, refusal half: when the same call has already produced an
   * equivalent result twice, synthesize a refusal without executing. The
   * blocked counter is global and consecutive across signatures — alternating
   * between two stalled calls or interleaving unrelated successful tools no
   * longer resets it. Only fresh successful progress (see postRecord) clears it.
   */
  private repeatGuardPreCheck(
    block: ToolUseBlock,
  ): {
    result: ToolResult & { tool_name?: string }
    repeatGuardStop?: { message: string; errorCode: string }
  } | undefined {
    const signature = toolCallSignature(block)
    const previous = this.repeatedToolCalls.get(signature)
    if (!previous || previous.equivalentResultCount < MAX_EQUIVALENT_MUTATION_RESULTS) return undefined

    this.blockedRepeatAttempts++
    const message =
      `Runtime repeat guard: "${block.name}" with the same input already returned an equivalent result twice, so this call was not executed. `
      + 'Do not retry the unchanged call. Use the existing result as evidence: finish if the user goal is satisfied, or inspect current state and choose a materially different action.'
    // Hard stop is reserved for repeated SUCCESSFUL results: the model got its
    // answer and keeps repeating the same call anyway. An equivalent error may
    // be a transient failure worth retrying once conditions change, so keep
    // only refusing there and let maxTurns remain the backstop.
    const shouldStop =
      this.blockedRepeatAttempts >= MAX_BLOCKED_REPEAT_ATTEMPTS && !previous.isError
    return {
      result: {
        type: 'tool_result',
        tool_use_id: block.id,
        tool_name: block.name,
        content: message,
        is_error: true,
        _meta: {
          error: { code: 'repeated_tool_call', retryable: false },
          repeatGuard: {
            equivalentResults: previous.equivalentResultCount,
            blockedAttempts: this.blockedRepeatAttempts,
          },
        },
      },
      ...(shouldStop ? {
        repeatGuardStop: {
          errorCode: 'repeated_tool_call',
          message: `Agent stopped after retrying the unchanged "${block.name}" call despite repeat-guard feedback.`,
        },
      } : {}),
    }
  }

  /**
   * Repeat guard, bookkeeping half: record the result signature for this call
   * and clear the global blocked counter on fresh successful progress.
   *
   * Progress means either a first-seen call succeeding or a previously-seen
   * call returning a different successful result — evidence that state moved.
   * Note the deliberate boundary: a command whose output changes every time
   * can still reset the counter; this is a stall guard, not an adversarial one.
   */
  private repeatGuardPostRecord(block: ToolUseBlock, result: ToolResult): void {
    if (isDeterministicRefusal(result)) return
    const signature = toolCallSignature(block)
    const newSignature = toolResultSignature(result)
    const previous = this.repeatedToolCalls.get(signature)
    this.repeatedToolCalls.set(signature, {
      resultSignature: newSignature,
      equivalentResultCount:
        previous?.resultSignature === newSignature ? previous.equivalentResultCount + 1 : 1,
      isError: result.is_error === true,
    })
    if (!result.is_error && (!previous || previous.resultSignature !== newSignature)) {
      this.blockedRepeatAttempts = 0
    }
  }

  private async executeToolWithRepeatGuard(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
  ): Promise<{
    result: ToolResult & { tool_name?: string }
    events: SDKMessage[]
    toolsUsed: string[]
    repeatGuardStop?: { message: string; errorCode: string }
  }> {
    const blocked = this.repeatGuardPreCheck(block)
    if (blocked) {
      // A guard refusal executes nothing: no side effects, so no events and
      // no toolsUsed — constructed here so callers can fan out uniformly
      // instead of relying on an empty-array invariant of the pre-check.
      return { ...blocked, events: [], toolsUsed: [] }
    }
    const execution = await this.executeSingleTool(block, tool, context)
    this.repeatGuardPostRecord(block, execution.result)
    return execution
  }

  /**
   * Execute a single tool with permission checking.
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
  ): Promise<{
    result: ToolResult & { tool_name?: string }
    events: SDKMessage[]
    toolsUsed: string[]
  }> {
    const events: SDKMessage[] = []
    const toolsUsed: string[] = []
    const toolContext: ToolContext = {
      ...context,
      toolUseId: block.id,
    }
    let toolCallActive = true
    toolContext.emitEvent = (event) => {
      if (toolCallActive) {
        context.emitEvent?.(event)
        return
      }
      if (event.type === 'system' && event.subtype === 'task_notification') {
        try {
          this.config.onAsyncEvent?.(event)
        } catch {
          // Host event delivery must not break terminal process cleanup.
        }
      }
    }
    // Live channel: delivered to the host immediately while the tool runs,
    // bypassing the deferred batch buffer. Closed once the tool call returns —
    // post-return progress belongs to the async channel above. Only mounted
    // when the host listens: tools fall back to emitEvent otherwise, so
    // hosts without onLiveEvent keep the buffered (persistable) behavior.
    if (this.config.onLiveEvent) {
      const deliverLive = this.config.onLiveEvent
      toolContext.emitLiveEvent = (event) => {
        if (!toolCallActive) return
        try {
          deliverLive(event)
        } catch {
          // Live delivery must not break tool execution.
        }
      }
    }
    toolContext.executeNestedTool = async ({ toolName, params }) => {
      const target = this.config.tools.find((candidate) => candidate.name === toolName)
        ?? this.config.deferredTools?.find((candidate) => candidate.name === toolName)
      if (!target) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: Nested tool "${toolName}" is not available.`,
          is_error: true,
        }
      }
      const delegated = await this.executeSingleTool({
        type: 'tool_use',
        id: `${block.id}:${toolName}`,
        name: target.name,
        input: params,
      }, target, context)
      events.push(...delegated.events)
      toolsUsed.push(...delegated.toolsUsed)
      return delegated.result
    }
    toolContext.executeDeferredTool = toolContext.executeNestedTool
    toolContext.activateTools = (names) => {
      const promoted: string[] = []
      for (const name of names) {
        const target = this.config.deferredTools?.find((candidate) => candidate.name === name)
        if (!target || this.config.tools.some((candidate) => candidate.name === name)) continue
        this.config.tools.push(target)
        this.config.deferredTools = this.config.deferredTools?.filter((candidate) => candidate.name !== name) ?? []
        promoted.push(name)
      }
      if (promoted.length > 0) this.config.onToolsActivated?.(promoted)
      return promoted
    }
    toolContext.listAvailableTools = () =>
      [...this.config.tools, ...(this.config.deferredTools ?? [])]
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    if (!tool) {
      return {
        result: {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: Unknown tool "${block.name}"`,
          is_error: true,
          tool_name: block.name,
        },
        events,
        toolsUsed,
      }
    }

    if (toolContext.abortSignal?.aborted) throw new Error('aborted')

    // Check enabled
    if (tool.isEnabled && !tool.isEnabled()) {
      return {
        result: {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: Tool "${block.name}" is not enabled`,
          is_error: true,
          tool_name: block.name,
        },
        events,
        toolsUsed,
      }
    }

    // Check permissions
    if (this.config.canUseTool && !tool.runtimeMetadata?.delegatesPermission) {
      const permissionRequestHooks = await this.executeHooks('PermissionRequest', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
      })
      events.push(...permissionRequestHooks.events)
      if (toolContext.abortSignal?.aborted) throw new Error('aborted')
      try {
        const permission = await this.config.canUseTool(
          tool,
          block.input,
          await this.buildPermissionMetadata(block, tool, toolContext),
        )
        if (toolContext.abortSignal?.aborted) throw new Error('aborted')
        if (permission.behavior === 'deny') {
          this.permissionDenials.push({
            tool_name: block.name,
            tool_use_id: block.id,
            tool_input:
              block.input && typeof block.input === 'object'
                ? block.input as Record<string, unknown>
                : {},
          })
          const permissionDeniedHooks = await this.executeHooks('PermissionDenied', {
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            error: permission.message || 'Permission denied',
          })
          events.push(...permissionDeniedHooks.events)
          return {
            result: {
              type: 'tool_result',
              tool_use_id: block.id,
              content: permission.message || `Permission denied for tool "${block.name}"`,
              is_error: true,
              tool_name: block.name,
              _meta: { error: { code: 'permission_denied', retryable: false } },
            },
            events,
            toolsUsed,
          }
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
          toolContext.permissionUpdatedInput = true
        }
      } catch (err: any) {
        if (toolContext.abortSignal?.aborted) throw new Error('aborted')
        return {
          result: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Permission check error: ${err.message}`,
            is_error: true,
            tool_name: block.name,
          },
          events,
          toolsUsed,
        }
      }
    }

    // Validate the permission-adjusted input immediately before hooks and
    // execution so malformed model output cannot reach tool side effects.
    if (tool.validateInput) {
      try {
        const validationError = await tool.validateInput(block.input, toolContext)
        if (toolContext.abortSignal?.aborted) throw new Error('aborted')
        if (typeof validationError === 'string' && validationError.trim()) {
          return {
            result: {
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Invalid input for tool "${block.name}": ${validationError}`,
              is_error: true,
              tool_name: block.name,
              _meta: { error: { code: 'invalid_input', retryable: true } },
            },
            events,
            toolsUsed,
          }
        }
      } catch (err: any) {
        if (toolContext.abortSignal?.aborted) throw new Error('aborted')
        return {
          result: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Input validation error for tool "${block.name}": ${err.message}`,
            is_error: true,
            tool_name: block.name,
          },
          events,
          toolsUsed,
        }
      }
    }

    // Hook: PreToolUse
    const preHookResults = await this.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    events.push(...preHookResults.events)
    if (toolContext.abortSignal?.aborted) throw new Error('aborted')
    // Check if any hook blocks this tool
    if (preHookResults.outputs.some((r) => r.block)) {
      const msg = preHookResults.outputs.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
      return {
        result: {
          type: 'tool_result',
          tool_use_id: block.id,
          content: msg,
          is_error: true,
          tool_name: block.name,
        },
        events,
        toolsUsed,
      }
    }

    // Execute the tool
    try {
      if (toolContext.abortSignal?.aborted) throw new Error('aborted')
      await this.config.onBeforeToolExecution?.({
        toolName: block.name,
        input: block.input,
        userMessageId: this.config.currentUserMessageId,
        cwd: toolContext.cwd,
      })
      if (toolContext.abortSignal?.aborted) throw new Error('aborted')
      if (this.config.enableFileCheckpointing === true && this.config.fileCheckpointState && this.config.currentUserMessageId) {
        if (requiresWorkspaceCheckpoint(block.name)) {
          await captureWorkspaceFileSnapshots(
            this.config.fileCheckpointState,
            this.config.currentUserMessageId,
            [this.config.cwd, ...(this.config.additionalDirectories ?? [])],
          )
        } else {
          const checkpointPaths = collectCheckpointPaths(block.name, block.input)
            .map((path) => resolve(toolContext.cwd, path))
          await captureFileSnapshots(
            this.config.fileCheckpointState,
            this.config.currentUserMessageId,
            checkpointPaths,
          )
        }
      }
      if (toolContext.abortSignal?.aborted) throw new Error('aborted')

      const startedAt = performance.now()
      const eventStartIndex = events.length
      const result = await tool.call(block.input, toolContext)
      // Soft abort: a tool that already finished keeps its result; only
      // not-yet-started or still-running tools are interrupted.
      toolCallActive = false
      toolContext.onToolExecution?.({
        toolName: block.name,
        input: block.input,
        result,
      })
      applySkillAllowedTools(block.name, result, this.config)
      const elapsedTimeSeconds = Math.max(0, (performance.now() - startedAt) / 1000)
      toolsUsed.push(block.name)
      events.push({
        type: 'tool_progress',
        tool_use_id: block.id,
        tool_name: block.name,
        parent_tool_use_id: null,
        elapsed_time_seconds: Number(elapsedTimeSeconds.toFixed(3)),
        session_id: this.sessionId,
      })

      const emittedDuringCall = events.slice(eventStartIndex)
      for (const emitted of emittedDuringCall) {
        if (emitted.type === 'system' && emitted.subtype === 'task_started') {
          const taskCreatedHooks = await this.executeHooks('TaskCreated', {
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            task_id: emitted.task_id,
          })
          events.push(...taskCreatedHooks.events)
        }
        if (emitted.type === 'system' && emitted.subtype === 'task_notification') {
          const taskCompletedHooks = await this.executeHooks('TaskCompleted', {
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            task_id: emitted.task_id,
            status: emitted.status,
          })
          events.push(...taskCompletedHooks.events)
        }
      }

      // Hook: PostToolUse
      const postToolResults = await this.executeHooks('PostToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        toolUseId: block.id,
      })
      events.push(...postToolResults.events)
      if (block.name === 'Config') {
        const configHooks = await this.executeHooks('ConfigChange', {
          toolName: block.name,
          toolInput: block.input,
          toolOutput: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          toolUseId: block.id,
        })
        events.push(...configHooks.events)
      }

      return {
        result: { ...result, tool_use_id: block.id, tool_name: block.name },
        events,
        toolsUsed,
      }
    } catch (err: any) {
      toolCallActive = false
      if (toolContext.abortSignal?.aborted) throw new Error('aborted')
      // Hook: PostToolUseFailure
      const postFailureHooks = await this.executeHooks('PostToolUseFailure', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
        error: err.message,
      })
      events.push(...postFailureHooks.events)

      return {
        result: {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool execution error: ${err.message}`,
          is_error: true,
          tool_name: block.name,
        },
        events,
        toolsUsed,
      }
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Get total usage across all turns.
   */
  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.totalCost
  }

  getContextUsage(): ContextUsageResult {
    const systemPrompt = this.config.systemPrompt || ''
    const messageTokens = estimateMessagesTokens(this.messages)
    const systemTokens = estimateSystemPromptTokens(systemPrompt)
    const totalTokens = messageTokens + systemTokens
    const maxTokens = this.getContextWindow()
    const toolTokens = this.estimateToolSchemaTokens()
    const skills = this.config.skillRegistry?.getUserInvocable() ?? getUserInvocableSkills()
    const skillFrontmatter = skills.map((skill) => ({
      name: skill.name,
      source: 'runtime',
      tokens: Math.ceil((skill.name.length + skill.description.length) / 4),
    }))
    const systemTools = this.config.tools
      .filter((tool) => !tool.name.startsWith('mcp__'))
      .map((tool) => ({
        name: tool.name,
        tokens: estimateToolTokens(tool),
      }))
    const toolCallsByType = new Map<string, { callTokens: number; resultTokens: number }>()
    let toolCallTokens = 0
    let toolResultTokens = 0
    let assistantMessageTokens = 0
    let userMessageTokens = 0

    // Pair tool_result blocks with their originating tool name via the
    // assistant tool_use id (tool_use_id is an id, not a tool name).
    const toolUseNames = new Map<string, string>()
    for (const message of this.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content as any[]) {
        if (block.type === 'tool_use') toolUseNames.set(block.id, block.name)
      }
    }

    for (const message of this.messages) {
      const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }]
      for (const block of content as any[]) {
        if (block.type === 'tool_use') {
          const estimated = Math.ceil(JSON.stringify(block).length / 4)
          toolCallTokens += estimated
          const entry = toolCallsByType.get(block.name) || { callTokens: 0, resultTokens: 0 }
          entry.callTokens += estimated
          toolCallsByType.set(block.name, entry)
        } else if (block.type === 'tool_result') {
          const estimated = Math.ceil(JSON.stringify(block).length / 4)
          toolResultTokens += estimated
          const toolName = toolUseNames.get(block.tool_use_id) || 'tool_result'
          const entry = toolCallsByType.get(toolName) || { callTokens: 0, resultTokens: 0 }
          entry.resultTokens += estimated
          toolCallsByType.set(toolName, entry)
        } else if (message.role === 'assistant') {
          assistantMessageTokens += Math.ceil(JSON.stringify(block).length / 4)
        } else {
          userMessageTokens += Math.ceil(JSON.stringify(block).length / 4)
        }
      }
    }

    const gridRows = [
      [
        {
          color: 'green',
          isFilled: systemTokens > 0,
          categoryName: 'system',
          tokens: systemTokens,
          percentage: maxTokens > 0 ? systemTokens / maxTokens : 0,
          squareFullness: maxTokens > 0 ? Math.min(1, systemTokens / maxTokens) : 0,
        },
        {
          color: 'blue',
          isFilled: messageTokens > 0,
          categoryName: 'messages',
          tokens: messageTokens,
          percentage: maxTokens > 0 ? messageTokens / maxTokens : 0,
          squareFullness: maxTokens > 0 ? Math.min(1, messageTokens / maxTokens) : 0,
        },
        {
          color: 'orange',
          isFilled: toolTokens > 0,
          categoryName: 'tools',
          tokens: toolTokens,
          percentage: maxTokens > 0 ? toolTokens / maxTokens : 0,
          squareFullness: maxTokens > 0 ? Math.min(1, toolTokens / maxTokens) : 0,
        },
      ],
    ]

    return {
      categories: [
        { name: 'messages', tokens: messageTokens, color: 'blue' },
        { name: 'system', tokens: systemTokens, color: 'green' },
        { name: 'tools', tokens: toolTokens, color: 'orange' },
      ],
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage: maxTokens > 0 ? totalTokens / maxTokens : 0,
      gridRows,
      model: this.config.model,
      memoryFiles: [],
      deferredBuiltinTools: (this.config.deferredTools ?? []).map((tool) => ({
        name: tool.name,
        tokens: estimateToolTokens(tool),
        isLoaded: false,
      })),
      systemTools,
      systemPromptSections: [
        { name: 'systemPrompt', tokens: systemTokens },
      ],
      agents: Object.entries(this.config.agents || {}).map(([agentType]) => ({
        agentType,
        source: 'options',
        tokens: Math.ceil(agentType.length / 4),
      })),
      slashCommands: {
        totalCommands: 0,
        includedCommands: 0,
        tokens: 0,
      },
      skills: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        tokens: skillFrontmatter.reduce((sum, skill) => sum + skill.tokens, 0),
        skillFrontmatter,
      },
      messageBreakdown: {
        toolCallTokens,
        toolResultTokens,
        attachmentTokens: 0,
        assistantMessageTokens,
        userMessageTokens,
        toolCallsByType: Array.from(toolCallsByType.entries()).map(([name, value]) => ({
          name,
          callTokens: value.callTokens,
          resultTokens: value.resultTokens,
        })),
        attachmentsByType: [],
      },
      isAutoCompactEnabled: true,
      apiUsage: this.totalUsage,
    }
  }
}

function applySkillAllowedTools(
  toolName: string,
  result: ToolResult,
  config: QueryEngineConfig,
): void {
  if (toolName !== 'Skill' || typeof result.content !== 'string' || result.is_error) return
  try {
    const parsed = JSON.parse(result.content) as { allowedTools?: unknown; activatedTools?: unknown }
    const activated = Array.isArray(parsed.activatedTools)
      ? parsed.activatedTools.filter((item): item is string => typeof item === 'string')
      : []
    const activatedDeferredTools = (config.deferredTools ?? []).filter((tool) =>
      matchesAnyToolPattern(tool.name, activated)
    )
    const promoted: string[] = []
    for (const tool of activatedDeferredTools) {
      if (config.tools.some((candidate) => candidate.name === tool.name)) continue
      config.tools.push(tool)
      promoted.push(tool.name)
    }
    config.deferredTools = (config.deferredTools ?? []).filter((tool) =>
      !matchesAnyToolPattern(tool.name, activated)
    )

    if (Array.isArray(parsed.allowedTools)) {
      const allowed = parsed.allowedTools.filter((item): item is string => typeof item === 'string')
      if (allowed.length > 0) {
        config.tools = config.tools.filter((tool) =>
          tool.name === 'Skill'
          || tool.runtimeMetadata?.requiredDuringSkillScope === true
          || matchesAnyToolPattern(tool.name, allowed)
        )
      }
    }
    // Mirror activateTools: report activations after all config changes, only when non-empty.
    if (promoted.length > 0) config.onToolsActivated?.(promoted)
  } catch {
    // Non-JSON skill output does not alter tool visibility.
  }
}

function formatToolResultOutput(content: ToolResult['content']): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content.map((block) => {
    if (block.type !== 'image') return block
    const source = block.source && typeof block.source === 'object'
      ? block.source as { media_type?: unknown }
      : {}
    const mimeType = typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof source.media_type === 'string'
        ? source.media_type
        : 'image'
    return {
      type: 'text',
      text: `[Image: ${mimeType}]`,
      ...(block._meta ? { _meta: block._meta } : {}),
    }
  }))
}
