/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
} from './types.js'

// Runtime messages hoisted to the top-level system param (the messages array
// rejects role:'system'; system content is billed and cached as a system block).
function collectRuntimeSystemText(params: CreateMessageParams): string | null {
  if (params.promptCache?.runtimeRole !== 'system') return null
  const parts: string[] = []
  for (const message of params.messages) {
    if (message.role !== 'runtime') continue
    parts.push(typeof message.content === 'string'
      ? message.content
      : message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function toAnthropicSystem(params: CreateMessageParams): string | Array<Record<string, unknown>> {
  const runtimeText = collectRuntimeSystemText(params)
  if (!runtimeText) {
    if (!params.promptCache?.cacheStableSystem || !params.system) return params.system
    return [{
      type: 'text',
      text: params.system,
      cache_control: { type: 'ephemeral', ttl: params.promptCache.ttl ?? '5m' },
    }]
  }
  const blocks: Array<Record<string, unknown>> = []
  if (params.system) {
    blocks.push(
      params.promptCache?.cacheStableSystem
        ? {
            type: 'text',
            text: params.system,
            cache_control: { type: 'ephemeral', ttl: params.promptCache.ttl ?? '5m' },
          }
        : { type: 'text', text: params.system },
    )
  }
  blocks.push({
    type: 'text',
    text: `<lume_runtime_context>\n${runtimeText}\n</lume_runtime_context>`,
  })
  return blocks
}

function toAnthropicMessages(params: CreateMessageParams): Array<Record<string, unknown>> {
  const hoistRuntimeSystem = params.promptCache?.runtimeRole === 'system'
  return params.messages
    .filter((message) => !hoistRuntimeSystem || message.role !== 'runtime')
    .map((message) => {
      if (message.role !== 'runtime') return message as unknown as Record<string, unknown>
      const content = typeof message.content === 'string'
        ? message.content
        : message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      return {
        role: 'user',
        content: `<lume_runtime_context>\n${content}\n</lume_runtime_context>`,
      }
    })
}

function applyAnthropicCachePolicy(
  requestParams: Record<string, unknown>,
  params: CreateMessageParams,
): void {
  if (!params.promptCache?.cacheConversation) return
  // cache_control belongs on a content block, not the request top level: mark
  // the last block of the last message (second cache breakpoint after system).
  const messages = requestParams.messages as Array<Record<string, unknown>>
  const last = messages[messages.length - 1]
  if (!last) return
  const cacheControl = { type: 'ephemeral', ttl: params.promptCache.ttl ?? '5m' }
  let blocks: Array<Record<string, unknown>>
  if (typeof last.content === 'string') {
    blocks = [{ type: 'text', text: last.content }]
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    blocks = [...last.content]
  } else {
    return
  }
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cacheControl }
  messages[messages.length - 1] = { ...last, content: blocks }
}

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async countTokens(params: CreateMessageParams): Promise<number | null> {
    const requestParams: Record<string, unknown> = {
      model: params.model,
      system: toAnthropicSystem(params),
      messages: toAnthropicMessages(params),
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }
    applyAnthropicCachePolicy(requestParams, params)

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    } else if (params.thinking?.type === 'adaptive') {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: 10000,
      }
    }

    if (params.effort) {
      requestParams.effort = params.effort
    }

    const client = this.client as unknown as {
      beta?: { messages?: { countTokens?: (request: Record<string, unknown>) => Promise<unknown> } }
      messages?: { countTokens?: (request: Record<string, unknown>) => Promise<unknown> }
    }
    const counter = client.beta?.messages?.countTokens
      ? client.beta.messages
      : client.messages?.countTokens
        ? client.messages
        : undefined
    if (!counter?.countTokens) {
      return null
    }

    try {
      const response = await counter.countTokens(requestParams)
      const inputTokens = (response as { input_tokens?: unknown }).input_tokens
      return typeof inputTokens === 'number' && Number.isFinite(inputTokens)
        ? Math.max(0, Math.round(inputTokens))
        : null
    } catch {
      return null
    }
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: toAnthropicSystem(params) as any,
      messages: toAnthropicMessages(params) as unknown as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }
    applyAnthropicCachePolicy(requestParams as unknown as Record<string, unknown>, params)

    // Extended thinking: 'enabled' uses explicit budget, 'adaptive' uses a default budget
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    } else if (params.thinking?.type === 'adaptive') {
      // Adaptive: enable thinking with a sensible default budget, model decides usage
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: 10000,
      }
    }

    // Effort level (Anthropic API param, supported on Sonnet 4.6 / Opus 4.6)
    if (params.effort) {
      (requestParams as any).thinking = {
        ...(requestParams as any).thinking,
      }
      ;(requestParams as any).effort = params.effort
    }

    const response = await this.client.messages.create(requestParams)

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: normalizeAnthropicUsage(response.usage),
    }
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const requestParams: Anthropic.MessageStreamParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: toAnthropicSystem(params) as any,
      messages: toAnthropicMessages(params) as unknown as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }
    applyAnthropicCachePolicy(requestParams as unknown as Record<string, unknown>, params)

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      ;(requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    } else if (params.thinking?.type === 'adaptive') {
      ;(requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: 10000,
      }
    }

    if (params.effort) {
      ;(requestParams as any).effort = params.effort
    }

    const stream = this.client.messages.stream(requestParams)
    params.abortSignal?.addEventListener('abort', () => stream.abort(), { once: true })

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta' && event.delta.text) {
          yield {
            type: 'text_delta',
            text: event.delta.text,
          }
        }
        if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          yield {
            type: 'thinking_delta',
            thinking: event.delta.thinking,
          }
        }
      }
    }

    const response = await stream.finalMessage()

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: normalizeAnthropicUsage(response.usage),
    }
  }
}

function normalizeAnthropicUsage(usage: Anthropic.Messages.Usage): CreateMessageResponse['usage'] {
  const raw = usage as Anthropic.Messages.Usage & {
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation?: {
      ephemeral_5m_input_tokens?: number
      ephemeral_1h_input_tokens?: number
    }
  }
  const directCacheCreation = numberOrUndefined(raw.cache_creation_input_tokens)
  const detailedCacheCreation =
    tokenValue(raw.cache_creation?.ephemeral_5m_input_tokens)
    + tokenValue(raw.cache_creation?.ephemeral_1h_input_tokens)

  return {
    input_tokens: tokenValue(raw.input_tokens),
    output_tokens: tokenValue(raw.output_tokens),
    cache_creation_input_tokens: directCacheCreation ?? detailedCacheCreation,
    cache_read_input_tokens: tokenValue(raw.cache_read_input_tokens),
  }
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
}
