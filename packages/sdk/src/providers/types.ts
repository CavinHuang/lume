/**
 * LLM Provider Abstraction Types
 *
 * Defines a provider interface that normalizes API differences between
 * Anthropic Messages API and OpenAI Chat Completions API.
 *
 * Internally the SDK uses Anthropic-like message format as the canonical
 * representation. Providers convert to/from their native API format.
 */

import type { ToolResultContentBlock } from '../types.js'

// --------------------------------------------------------------------------
// API Type
// --------------------------------------------------------------------------

export type ApiType = 'anthropic-messages' | 'openai-completions' | 'deepseek-chat-completions' | 'openai-responses'

export interface PromptCachePolicy {
  strategy: 'implicit' | 'anthropic-ephemeral' | 'openrouter-sticky'
  routingKey?: string
  ttl?: '5m'
  cacheStableSystem?: boolean
  cacheConversation?: boolean
  runtimeRole?: 'developer' | 'system' | 'user'
}

// --------------------------------------------------------------------------
// Normalized Request
// --------------------------------------------------------------------------

export interface CreateMessageParams {
  model: string
  maxTokens: number
  system: string
  messages: NormalizedMessageParam[]
  tools?: NormalizedTool[]
  thinking?: { type: string; budget_tokens?: number }
  jsonSchema?: Record<string, unknown>
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
  effort?: 'low' | 'medium' | 'high' | 'max'
  promptCache?: PromptCachePolicy
  /** 中止信号：用于在流式响应过程中即时取消底层 fetch。 */
  abortSignal?: AbortSignal
}

/**
 * Normalized message format (Anthropic-like).
 * This is the internal representation used throughout the SDK.
 */
export interface NormalizedMessageParam {
  role: 'user' | 'assistant' | 'runtime'
  content: string | NormalizedContentBlock[]
}

export type NormalizedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; response_item_id?: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentBlock[]; is_error?: boolean; _meta?: Record<string, unknown> }
  | { type: 'image'; source: any }
  | { type: 'thinking'; thinking: string }

export interface NormalizedTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

// --------------------------------------------------------------------------
// Normalized Response
// --------------------------------------------------------------------------

export interface CreateMessageResponse {
  content: NormalizedResponseBlock[]
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type NormalizedResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; response_item_id?: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

export type CreateMessageStreamEvent =
  | {
      type: 'text_delta'
      text: string
    }
  | {
      type: 'thinking_delta'
      thinking: string
    }

// --------------------------------------------------------------------------
// Provider Interface
// --------------------------------------------------------------------------

export interface LLMProvider {
  /** The API type this provider implements. */
  readonly apiType: ApiType

  /** Count request input tokens with the provider API when supported. */
  countTokens?(params: CreateMessageParams): Promise<number | null>

  /** Send a message and get a response. */
  createMessage(params: CreateMessageParams): Promise<CreateMessageResponse>

  /** Stream partial output when supported by the provider. */
  createMessageStream?(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse>
}
