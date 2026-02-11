/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\packages\core\src\providers\index.ts
 * Adaptation:
 * - Replaced shared import scope `@proma/shared` -> `@lume/shared`.
 */

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
import { GoogleAdapter } from './google-adapter'

// 导出所有类型和工具
export * from './types'
export * from './sse-reader'
export * from './url-utils'

// 导出适配器类
export { AnthropicAdapter } from './anthropic-adapter'
export { OpenAIAdapter } from './openai-adapter'
export { GoogleAdapter } from './google-adapter'

/** 供应商适配器注册表 */
const adapterRegistry = new Map<ProviderType, ProviderAdapter>([
  ['anthropic', new AnthropicAdapter()],
  ['openai', new OpenAIAdapter()],
  ['deepseek', new OpenAIAdapter()],      // DeepSeek 使用 OpenAI 兼容协议
  ['moonshot', new OpenAIAdapter()],      // Moonshot/Kimi 使用 OpenAI 兼容协议
  ['zhipu', new OpenAIAdapter()],         // 智谱 AI 使用 OpenAI 兼容协议
  ['minimax', new OpenAIAdapter()],       // MiniMax 使用 OpenAI 兼容协议
  ['doubao', new OpenAIAdapter()],        // 豆包使用 OpenAI 兼容协议
  ['qwen', new OpenAIAdapter()],          // 通义千问使用 OpenAI 兼容协议
  ['custom', new OpenAIAdapter()],        // 自定义也使用 OpenAI 兼容协议
  ['google', new GoogleAdapter()],
])

/**
 * 根据供应商类型获取适配器
 *
 * @param provider 供应商类型
 * @returns 对应的适配器实例
 * @throws Error 如果供应商类型不支持
 */
export function getAdapter(provider: ProviderType): ProviderAdapter {
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new Error(`不支持的供应商: ${provider}`)
  }
  return adapter
}
