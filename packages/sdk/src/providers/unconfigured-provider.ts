/**
 * Placeholder provider for missing host-provided LLMProvider.
 *
 * The SDK no longer ships built-in HTTP providers; the host must inject a
 * provider via options.provider. Any real call on this placeholder fails
 * loudly instead of silently constructing a broken request.
 */

import type { ApiType, LLMProvider } from './types.js'

export function unconfiguredProvider(): LLMProvider {
  const fail = (): never => {
    throw new Error(
      'No LLMProvider configured. Pass options.provider (host-provided provider required).',
    )
  }
  const provider: LLMProvider = {
    apiType: 'anthropic-messages' as ApiType,
    createMessage: fail,
  }
  return provider
}
