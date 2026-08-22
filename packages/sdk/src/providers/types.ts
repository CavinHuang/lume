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

export type ApiType =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'deepseek-chat-completions'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'google-generative-ai'

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
  | {
      type: 'retry_state'
      phase: 'waiting' | 'retrying' | 'cleared'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
    }

// --------------------------------------------------------------------------
// Provider Interface
// --------------------------------------------------------------------------

/**
 * Host-owned LLM provider contract. The SDK ships no built-in HTTP
 * providers — the host injects one implementation of this interface via
 * `createAgent({ provider })`.
 *
 * Provider obligations (the engine relies on all of these):
 *
 * - **Protocol conversion.** Translate the normalized (Anthropic-like)
 *   request/response shapes in this file to and from the provider's native
 *   API. `apiType` declares which protocol; the engine surfaces it in
 *   `auth_status` and `getApiType()` but performs no protocol handling
 *   itself.
 * - **Credentials & retry.** The provider owns keys, base URLs, and
 *   transport-level retries. The engine does not retry provider errors
 *   except its own prompt-too-long compaction path.
 * - **Usage normalization.** `usage.input_tokens` / `output_tokens` must be
 *   populated with real provider counts; they feed billing records and the
 *   `result` event. Cache fields are optional.
 * - **Thinking mapping.** When the engine requests `thinking`, map the
 *   provider's reasoning output back as `{ type: 'thinking' }` blocks if
 *   the provider emits them; silently dropping reasoning is acceptable but
 *   degrades extended-thinking flows.
 * - **Prompt cache policy.** When `params.promptCache` is set, honor the
 *   strategy (`anthropic-ephemeral`, `openrouter-sticky`, or `implicit`)
 *   where the provider supports it. Ignoring it silently multiplies real
 *   long-session cost.
 * - **Abort.** Honor `params.abortSignal`: cancel the underlying request
 *   promptly so a user interrupt stops in-flight work.
 *
 * Optional methods degrade as follows when omitted:
 *
 * - `createMessageStream` — streaming requests silently fall back to a
 *   blocking `createMessage` call: no `text_delta` partial events, and the
 *   `includePartialMessages` engine flag has nothing to forward.
 * - `countTokens` — token accounting falls back to the SDK's heuristic
 *   estimator.
 */
export interface LLMProvider {
  /** The API type this provider implements. */
  readonly apiType: ApiType

  /** Count request input tokens with the provider API when supported. */
  countTokens?(params: CreateMessageParams): Promise<number | null>

  /** Send a message and get a response. */
  createMessage(params: CreateMessageParams): Promise<CreateMessageResponse>

  /**
   * Stream partial output when supported by the provider. Emits
   * `text_delta` / `thinking_delta` / `retry_state` events and resolves to
   * the final response. When absent, the engine silently degrades to a
   * blocking `createMessage` call.
   */
  createMessageStream?(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse>
}
