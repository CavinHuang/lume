/**
 * Placeholder provider for missing host-provided LLMProvider.
 *
 * The SDK no longer ships built-in HTTP providers; the host must inject a
 * provider via options.provider. Any real call on this placeholder fails
 * loudly instead of silently constructing a broken request.
 */

import type { ApiType, LLMProvider } from './types.js'

const UNCONFIGURED_FLAG = Symbol('unconfiguredProvider')

/**
 * Sentinel provider returned when no host provider is injected. Carries a
 * flag so the Agent can fail fast at run entry (before any listener is
 * attached or the user message is persisted) instead of failing on the
 * first LLM call.
 */
export function unconfiguredProvider(): LLMProvider {
  const fail = (): never => {
    throw new Error(
      'No LLMProvider configured. Pass options.provider (host-provided provider required).',
    )
  }
  const provider: LLMProvider = {
    apiType: 'anthropic-messages' as ApiType,
    createMessage: fail,
    [UNCONFIGURED_FLAG]: true,
  } as LLMProvider
  return provider
}

/** True when the provider is the unconfigured placeholder, not a host injection. */
export function isUnconfiguredProvider(provider: LLMProvider): boolean {
  return (provider as any)[UNCONFIGURED_FLAG] === true
}
