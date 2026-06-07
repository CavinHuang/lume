
/**
 * Provider 适配器注册表
 *
 * 集中管理所有已注册的供应商适配器，
 * 通过 ProviderType 查找对应的适配器实例。
 */

import type { ProviderType } from '@lume/shared'
import type { ProviderAdapter } from './types'
import { AnthropicAdapter } from './anthropic-adapter'
import { OpenAIAdapter } from './openai-adapter'
import { DeepSeekAdapter } from './deepseek-adapter'
import { GoogleAdapter } from './google-adapter'
import { OpenAIResponsesAdapter } from './openai-responses-adapter'

// 导出所有类型和工具
export * from './types'
export * from './sse-reader'
export * from './url-utils'

// 导出适配器类
export { AnthropicAdapter } from './anthropic-adapter'
export { OpenAIAdapter } from './openai-adapter'
export { DeepSeekAdapter } from './deepseek-adapter'
export { GoogleAdapter } from './google-adapter'
export { OpenAIResponsesAdapter } from './openai-responses-adapter'

/** 供应商适配器注册表 */
const adapterRegistry = new Map<ProviderType, ProviderAdapter>([
  ['anthropic', new AnthropicAdapter()],
  ['anthropic-compatible', new AnthropicAdapter()],
  ['openai', new OpenAIAdapter()],
  ['openrouter', new OpenAIAdapter()],    // OpenRouter 使用 OpenAI 兼容协议
  ['deepseek', new DeepSeekAdapter()],    // DeepSeek 使用独立 provider SDK
  ['moonshot', new OpenAIAdapter()],      // Moonshot/Kimi 使用 OpenAI 兼容协议
  ['zai', new OpenAIAdapter()],           // Z.ai 使用 OpenAI 兼容协议
  ['zai-coding-plan', new OpenAIAdapter()], // Zai Coding Plan 使用 OpenAI 兼容协议
  ['minimax', new OpenAIAdapter()],       // MiniMax 使用 OpenAI 兼容协议
  ['minimax-cn', new OpenAIAdapter()],    // MiniMax CN 使用 OpenAI 兼容协议
  ['doubao', new OpenAIAdapter()],        // 豆包使用 OpenAI 兼容协议
  ['qwen', new OpenAIAdapter()],          // 通义千问使用 OpenAI 兼容协议
  ['qwen-portal', new OpenAIAdapter()],   // Qwen Portal 使用 OpenAI 兼容协议
  ['kimi-coding', new OpenAIAdapter()],   // Kimi Coding 使用 OpenAI 兼容协议
  ['opencode', new OpenAIAdapter()],      // OpenCode 统一走 OpenAI 兼容协议
  ['custom', new OpenAIAdapter()],        // 自定义也使用 OpenAI 兼容协议
  ['google', new GoogleAdapter()],
  ['aliyun-coding-plan', new OpenAIAdapter()],
  ['volcengine-coding-plan', new OpenAIAdapter()],
  ['minimax-token-plan', new AnthropicAdapter()],
  ['xiaomi-token-plan', new OpenAIAdapter()],
])

/** OpenAI Responses API 适配器实例（按需使用） */
const responsesAdapter = new OpenAIResponsesAdapter()

/**
 * 根据供应商类型获取适配器
 *
 * @param provider 供应商类型
 * @param openaiApiMode OpenAI API 模式（仅当 provider 为 'openai' 时有效）
 * @returns 对应的适配器实例
 * @throws Error 如果供应商类型不支持
 */
export function getAdapter(provider: ProviderType, openaiApiMode?: 'chat-completions' | 'responses'): ProviderAdapter {
  if (provider === 'openai' && openaiApiMode === 'responses') {
    return responsesAdapter
  }
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new Error(`不支持的供应商: ${provider}`)
  }
  return adapter
}
