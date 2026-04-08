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

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

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
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const requestParams: Anthropic.MessageStreamParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

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

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text
      ) {
        yield {
          type: 'text_delta',
          text: event.delta.text,
        }
      }
    }

    const response = await stream.finalMessage()

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }
}
