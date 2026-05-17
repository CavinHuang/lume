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
  AgentContextCompactionTrigger,
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
import { normalizeMessagesForAPI } from './utils/messages.js'
import type { HookRegistry, HookInput, HookExecutionResult } from './hooks.js'
import { buildStructuredOutputInstruction, parseStructuredOutput } from './utils/structured-output.js'
import { captureFileSnapshots, collectCheckpointPaths } from './utils/file-checkpoints.js'
import { generatePromptSuggestion } from './utils/prompt-suggestions.js'
import { resolve } from 'path'
import { getUserInvocableSkills } from './skills/index.js'
import { getDeferredTools } from './tools/tool-search.js'
import { matchesAnyToolPattern } from './utils/tool-approval.js'

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
  name: string
  input: any
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

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  if (config.systemPrompt) {
    const structuredOutputInstruction = buildStructuredOutputInstruction(
      config.jsonSchema,
      config.outputFormat,
    )
    const base = structuredOutputInstruction
      ? `${config.systemPrompt}\n\n${structuredOutputInstruction}`
      : config.systemPrompt
    return config.appendSystemPrompt
      ? base + '\n\n' + config.appendSystemPrompt
      : base
  }

  const parts: string[] = []

  parts.push(
    'You are an AI assistant with access to tools. Use the tools provided to help the user accomplish their tasks.',
    'You should use tools when they would help you complete the task more accurately or efficiently.',
  )

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
  public messages: NormalizedMessageParam[] = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
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

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
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
    const estimatedTokens = estimateMessagesTokens(this.messages)
    const controller = this.config.contextController
    if (controller?.shouldAutoCompact) {
      return controller.shouldAutoCompact({
        messages: this.messages,
        model: this.config.model,
        state: this.compactState,
        estimatedTokens,
      })
    }
    return shouldAutoCompact(this.messages as any[], this.config.model, this.compactState)
  }

  private async compactMessages(
    trigger: AgentContextCompactionTrigger,
    preTokens: number,
  ): Promise<{
    compactedMessages: NormalizedMessageParam[]
    summary: string
    state: AutoCompactState
    metadata?: AgentContextCompactionMetadata
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
      })
      return {
        compactedMessages: result.compactedMessages,
        summary: result.summary,
        state: result.state ?? {
          ...this.compactState,
          compacted: true,
          consecutiveFailures: 0,
        },
        metadata: result.metadata,
      }
    }
    return defaultCompactConversation(
      this.provider,
      this.config.model,
      this.messages as any[],
      this.compactState,
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
        ...(typeof boundary.metadata?.memoryFlushJobId === 'string'
          ? { memory_flush_job_id: boundary.metadata.memoryFlushJobId }
          : {}),
        ...(boundary.metadata?.preservedSegment
          ? { preserved_segment: boundary.metadata.preservedSegment }
          : {}),
      },
      session_id: this.sessionId,
    } as SDKMessage
  }

  private async runCompaction(
    trigger: AgentContextCompactionTrigger,
  ): Promise<{ started: SDKMessage; boundary: SDKMessage }> {
    const preTokens = estimateMessagesTokens(this.messages)
    const result = await this.compactMessages(trigger, preTokens)
    this.messages = result.compactedMessages
    this.compactState = result.state
    const boundary: AgentContextCompactionBoundary = {
      trigger,
      preTokens,
      postTokens: estimateMessagesTokens(this.messages),
      summary: result.summary,
      metadata: result.metadata,
    }
    await this.config.contextController?.onCompactionBoundary?.(boundary)
    return {
      started: this.createCompactionStartedEvent(trigger, preTokens, result.metadata),
      boundary: this.createCompactBoundaryEvent(boundary),
    }
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

  private buildPermissionMetadata(
    block: ToolUseBlock,
    tool: ToolDefinition,
  ) {
    const payload =
      block.input && typeof block.input === 'object'
        ? (block.input as Record<string, unknown>)
        : {}
    const filePath =
      typeof payload.file_path === 'string'
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
        filePath && !tool.isReadOnly?.()
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
    const userHookResults = await this.executeHooks('UserPromptSubmit', {
      toolInput: prompt,
    })
    for (const event of userHookResults.events) yield event
    // Check if any hook blocks the submission
    if (userHookResults.outputs.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: this.totalUsage,
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    yield {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      session_id: this.sessionId,
    }

    if (this.isManualCompactPrompt(prompt)) {
      const { started, boundary } = await this.runCompaction('manual')
      yield started
      yield boundary
      yield {
        type: 'result',
        subtype: 'success',
        session_id: this.sessionId,
        is_error: false,
        num_turns: 0,
        total_cost_usd: this.totalCost,
        duration_api_ms: Math.round(this.apiTimeMs),
        usage: this.totalUsage,
        model_usage: { [this.config.model]: { input_tokens: 0, output_tokens: 0 } },
        modelUsage: {
          [this.config.model]: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: this.totalCost,
            contextWindow: 0,
            maxOutputTokens: this.config.maxTokens,
          },
        },
        cost: this.totalCost,
      } as SDKMessage
      yield {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: this.sessionId,
      }
      return
    }

    // Add user message
    this.messages.push({ role: 'user', content: prompt as any })

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(this.config)

    // Emit init system message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.tools.map(t => t.name),
      model: this.config.model,
      cwd: this.config.cwd,
      mcp_servers: this.config.mcpServerStatuses || [],
      permission_mode: this.config.permissionMode || 'bypassPermissions',
      permissionMode: this.config.permissionMode || 'bypassPermissions',
      agents: this.config.agents ? Object.keys(this.config.agents) : [],
      apiKeySource: this.config.initialization?.apiKeySource || (process.env.CODEANY_API_KEY ? 'env' : 'unknown'),
      slash_commands: this.config.initialization?.slashCommands || [],
      skills: this.config.initialization?.skills || [],
      plugins: this.config.initialization?.plugins || [],
      output_style: this.config.initialization?.outputStyle || 'text',
      claude_code_version: this.config.initialization?.claudeCodeVersion || 'open-agent-sdk/0.2.0',
    } as SDKMessage

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let structuredOutputRetriesExceeded = false
    let completedNaturally = false
    let maxOutputRecoveryAttempts = 0
    const MAX_OUTPUT_RECOVERY = 3
    let structuredOutputRetryAttempts = 0
    const MAX_STRUCTURED_OUTPUT_RETRIES = 2

    while (turnsRemaining > 0) {
      if (this.config.abortSignal?.aborted) break

      // Check budget
      if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Auto-compact if context is too large
      if (await this.shouldCompactAutomatically()) {
        await this.executeHooks('PreCompact')
        try {
          const { started, boundary } = await this.runCompaction('auto')
          await this.executeHooks('PostCompact')
          yield started
          yield boundary
        } catch {
          // Continue with uncompacted messages
        }
      }

      // Micro-compact: truncate large tool results
      const apiMessages = await this.microCompactForProvider(
        normalizeMessagesForAPI(this.messages as any[]) as NormalizedMessageParam[],
      )

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
      try {
        if (this.config.includePartialMessages && this.provider.createMessageStream) {
          const stream = this.provider.createMessageStream(providerRequest)

          while (true) {
            const next = await stream.next()
            if (next.done) {
              response = next.value as CreateMessageResponse
              break
            }

            const chunk = next.value as CreateMessageStreamEvent
            if (chunk.type === 'text_delta' && chunk.text) {
              // Official Claude Agent SDK format (stream_event)
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: chunk.text },
                },
                parent_tool_use_id: null,
                session_id: this.config.sessionId,
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
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'thinking_delta', thinking: chunk.thinking },
                },
                parent_tool_use_id: null,
                session_id: this.config.sessionId,
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
              const errorType = status === 429
                ? 'rate_limit'
                : status === 400
                  ? 'invalid_request'
                  : status === 401 || status === 403
                    ? 'authentication_failed'
                    : status === 500 || status === 502 || status === 503 || status === 529
                      ? 'server_error'
                      : 'unknown'
              retryEvents.push({
                type: 'system',
                subtype: 'api_retry',
                attempt: retry.attempt,
                max_retries: retry.maxRetries,
                retry_delay_ms: retry.retryDelayMs,
                error_status: status,
                error: errorType,
                session_id: this.sessionId,
              })
            },
          )
          for (const retryEvent of retryEvents) {
            yield retryEvent
          }
        }
      } catch (err: any) {
        const stopFailureHooks = await this.executeHooks('StopFailure', {
          error: err?.message || 'Unknown provider error',
        })
        for (const event of stopFailureHooks.events) yield event
        // Handle prompt-too-long by compacting
        if (isPromptTooLongError(err) && !this.compactState.compacted) {
          try {
            const { started, boundary } = await this.runCompaction('prompt_too_long')
            yield started
            yield boundary
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          usage: this.totalUsage,
          num_turns: this.turnCount,
          cost: this.totalCost,
          errors: [err?.message || 'Unknown provider error'],
        }
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: this.sessionId,
        }
        return
      }

      // Track API timing
      this.apiTimeMs += performance.now() - apiStart

      // Track usage (normalized by provider)
      if (response.usage) {
        this.totalUsage.input_tokens += response.usage.input_tokens
        this.totalUsage.output_tokens += response.usage.output_tokens
        if (response.usage.cache_creation_input_tokens) {
          this.totalUsage.cache_creation_input_tokens =
            (this.totalUsage.cache_creation_input_tokens || 0) +
            response.usage.cache_creation_input_tokens
        }
        if (response.usage.cache_read_input_tokens) {
          this.totalUsage.cache_read_input_tokens =
            (this.totalUsage.cache_read_input_tokens || 0) +
            response.usage.cache_read_input_tokens
        }
        this.totalCost += estimateCost(this.config.model, response.usage)
      }

      // Add assistant message to conversation
      this.messages.push({ role: 'assistant', content: response.content as any })

      // Yield assistant message
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: response.content as any,
        },
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
      if (
        response.stopReason === 'max_tokens' &&
        maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY
      ) {
        maxOutputRecoveryAttempts++
        // Add continuation prompt
        this.messages.push({
          role: 'user',
          content: 'Please continue from where you left off.',
        })
        continue
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
              'Your previous response did not match the requested JSON schema. Return only valid JSON matching the schema exactly, with no markdown fences or extra commentary.',
          })
          continue
        }
        structuredOutputRetriesExceeded = true
        break
      }

      if (toolUseBlocks.length === 0) {
        completedNaturally = true
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Execute tools (concurrent read-only, serial mutations)
      const { results: toolResults, events: toolEvents, toolsUsed } =
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
            output:
              typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
          },
        }
      }

      // Add tool results to conversation
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content:
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content),
          is_error: r.is_error,
        })),
      })

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

    // Hook: Stop (end of agentic loop)
    const stopHooks = await this.executeHooks('Stop')
    for (const event of stopHooks.events) yield event

    // Hook: SessionEnd
    const sessionEndHooks = await this.executeHooks('SessionEnd')
    for (const event of sessionEndHooks.events) yield event

    // Yield enriched final result
    const endSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : structuredOutputRetriesExceeded
        ? 'error_max_structured_output_retries'
      : turnsRemaining <= 0 && !completedNaturally
        ? 'error_max_turns'
        : 'success'

    // Build per-model usage in both formats for compatibility
    const snakeCaseUsage = {
      input_tokens: this.totalUsage.input_tokens,
      output_tokens: this.totalUsage.output_tokens,
    }
    const camelCaseUsage = {
      inputTokens: this.totalUsage.input_tokens,
      outputTokens: this.totalUsage.output_tokens,
      cacheReadInputTokens: this.totalUsage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: this.totalUsage.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: this.totalCost,
      contextWindow: 0,
      maxOutputTokens: this.config.maxTokens,
    }

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
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      usage: this.totalUsage,
      /** @deprecated Use modelUsage */
      model_usage: { [this.config.model]: snakeCaseUsage },
      modelUsage: { [this.config.model]: camelCaseUsage },
      cost: this.totalCost,
      permission_denials: this.permissionDenials,
      structured_output: structuredOutput,
      errors: structuredOutputRetriesExceeded
        ? ['Structured output validation failed after retry attempts.']
        : undefined,
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

    yield {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: this.sessionId,
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
      additionalDirectories: this.config.additionalDirectories,
      sandbox: this.config.sandbox,
      toolConfig: this.config.toolConfig,
      permissionMode: this.config.permissionMode,
      hookRegistry: this.hookRegistry,
      emitEvent: (event) => {
        events.push(event)
      },
    }

    const MAX_CONCURRENCY = parseInt(
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10',
    )

    // Partition into concurrent (read-only or concurrency-safe) and serial (mutations)
    const concurrent: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []
    const serial: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []

    for (const block of toolUseBlocks) {
      const tool = this.config.tools.find((t) => t.name === block.name)
      if (tool?.isReadOnly?.() || tool?.isConcurrencySafe?.()) {
        concurrent.push({ block, tool })
      } else {
        serial.push({ block, tool })
      }
    }

    const results: (ToolResult & { tool_name?: string })[] = []

    // Execute concurrent tools (batched by MAX_CONCURRENCY)
    for (let i = 0; i < concurrent.length; i += MAX_CONCURRENCY) {
      const batch = concurrent.slice(i, i + MAX_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map((item) =>
          this.executeSingleTool(item.block, item.tool, context),
        ),
      )
      for (const batchResult of batchResults) {
        results.push(batchResult.result)
        events.push(...batchResult.events)
        toolsUsed.push(...batchResult.toolsUsed)
      }
    }

    // Execute serial tools sequentially
    for (const item of serial) {
      const result = await this.executeSingleTool(item.block, item.tool, context)
      results.push(result.result)
      events.push(...result.events)
      toolsUsed.push(...result.toolsUsed)
    }

    return { results, events, toolsUsed }
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
    if (this.config.canUseTool) {
      const permissionRequestHooks = await this.executeHooks('PermissionRequest', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
      })
      events.push(...permissionRequestHooks.events)
      try {
        const permission = await this.config.canUseTool(
          tool,
          block.input,
          this.buildPermissionMetadata(block, tool),
        )
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
            },
            events,
            toolsUsed,
          }
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
      } catch (err: any) {
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

    // Hook: PreToolUse
    const preHookResults = await this.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    events.push(...preHookResults.events)
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
      if (this.config.fileCheckpointState && this.config.currentUserMessageId) {
        const checkpointPaths = collectCheckpointPaths(block.name, block.input)
          .map((path) => resolve(toolContext.cwd, path))
        await captureFileSnapshots(
          this.config.fileCheckpointState,
          this.config.currentUserMessageId,
          checkpointPaths,
        )
      }

      const startedAt = performance.now()
      const eventStartIndex = events.length
      const result = await tool.call(block.input, toolContext)
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
    const maxTokens = getContextWindowSize(this.config.model)
    const toolTokens = this.config.tools.reduce(
      (sum, tool) => sum + Math.ceil((tool.description.length + tool.name.length) / 4),
      0,
    )
    const skills = getUserInvocableSkills()
    const skillFrontmatter = skills.map((skill) => ({
      name: skill.name,
      source: 'runtime',
      tokens: Math.ceil((skill.name.length + skill.description.length + (skill.whenToUse?.length || 0)) / 4),
    }))
    const systemTools = this.config.tools
      .filter((tool) => !tool.name.startsWith('mcp__'))
      .map((tool) => ({
        name: tool.name,
        tokens: Math.ceil((tool.name.length + tool.description.length) / 4),
      }))
    const toolCallsByType = new Map<string, { callTokens: number; resultTokens: number }>()
    let toolCallTokens = 0
    let toolResultTokens = 0
    let assistantMessageTokens = 0
    let userMessageTokens = 0

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
          const matchingTool = this.config.tools.find((tool) => tool.name === block.tool_use_id) // best-effort only
          const entry = toolCallsByType.get(matchingTool?.name || 'tool_result') || { callTokens: 0, resultTokens: 0 }
          entry.resultTokens += estimated
          toolCallsByType.set(matchingTool?.name || 'tool_result', entry)
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
      mcpTools: (this.config.mcpServerStatuses || []).flatMap((server) =>
        this.config.tools
          .filter((tool) => tool.name.startsWith(`mcp__${server.name}__`))
          .map((tool) => ({
            name: tool.name,
            serverName: server.name,
            tokens: Math.ceil((tool.description.length + tool.name.length) / 4),
            isLoaded: server.status === 'connected',
          })),
      ),
      deferredBuiltinTools: getDeferredTools().map((tool) => ({
        name: tool.name,
        tokens: Math.ceil((tool.description.length + tool.name.length) / 4),
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
    const parsed = JSON.parse(result.content) as { allowedTools?: unknown }
    if (!Array.isArray(parsed.allowedTools)) return
    const allowed = parsed.allowedTools.filter((item): item is string => typeof item === 'string')
    if (allowed.length === 0) return
    config.tools = config.tools.filter((tool) =>
      tool.name === 'Skill' || matchesAnyToolPattern(tool.name, allowed)
    )
  } catch {
    // Non-JSON skill output does not alter tool visibility.
  }
}
