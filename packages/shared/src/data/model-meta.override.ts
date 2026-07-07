/**
 * 人工稳定层 —— sync-models 脚本永不写入此文件。
 * 1) 人工定制：补中文 description / aliases（generated 覆盖同 id，仅补字段）
 * 2) 国产缺口：models.dev 白名单未收录（generated 无，作 standalone 条目）
 */

/** 对 generated 条目的覆盖项；全字段可选。 */
export interface ModelOverride {
  displayName?: string
  contextWindow?: number
  capabilities?: Partial<{ vision: boolean; toolUse: boolean; reasoning: boolean }>
  pricing?: { input: number; output: number }
  description?: string
  aliases?: string[]
}

export const MODEL_OVERRIDES: Record<string, ModelOverride> = {
  // ── 1. 人工定制（generated 覆盖，补 description / aliases）──
  'claude-haiku-4-5-20251001': {
    aliases: ['claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
  },
  'claude-sonnet-4-5': { aliases: ['claude-3-5-sonnet-20241022'] },
  'gpt-4o': { aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06'] },
  'gpt-4o-mini': { aliases: ['gpt-4o-mini-2024-07-18'] },
  'gpt-4.1-mini': { aliases: ['openai/gpt-4.1-mini'] },
  'o3': { aliases: ['o3-2025-04-16'] },
  'o3-mini': { aliases: ['o3-mini-2025-01-31'] },
  'o4-mini': { aliases: ['o4-mini-2025-04-16'] },
  'gemini-2.5-pro': {
    // models.dev 报 1_048_576（2^20）；保持原公开值 1_000_000 以维持 UI "1M" 显示与公开 API 行为
    contextWindow: 1_000_000,
    description: '超长上下文窗口',
    aliases: ['gemini-2.5-pro-preview-05-06'],
  },
  // 同上：models.dev 报 1_048_576，保持 1_000_000 与原硬编码 / UI "1M" 显示一致
  'gemini-2.5-flash': { contextWindow: 1_000_000, aliases: ['gemini-2.5-flash-preview-05-20'] },
  'gemini-2.0-flash': { contextWindow: 1_000_000 },
  'deepseek-chat': { aliases: ['deepseek-v3'] },
  'step-3.7-flash': { description: '阶跃星辰旗舰多模态推理模型，支持三档推理强度' },
  'step-3.5-flash-2603': { description: '针对高频 Agent 场景优化，Token 效率提升、推理速度更快' },
  'step-3.5-flash': { description: '196B MoE 架构，高速推理，专为智能体和代码任务优化' },

  // ── 2. 国产缺口（generated 无，standalone）──
  // generated 用不同 id（claude-sonnet-4-5 / opus-4-x / deepseek-reasoner），这些 dated/alias id 作 standalone
  'claude-sonnet-4-20250514': {
    displayName: 'Claude Sonnet 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 3, output: 15 },
    description: '擅长代码和日常任务',
    aliases: ['claude-sonnet-4', 'claude-3-5-sonnet', 'claude-3-5-sonnet-20241022', 'claude-3.5-sonnet', 'anthropic/claude-sonnet-4-5'],
  },
  'claude-opus-4-20250514': {
    displayName: 'Claude Opus 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 15, output: 75 },
    description: '最强推理能力',
    aliases: ['claude-opus-4', 'claude-3-opus', 'claude-3-opus-20240229'],
  },
  'deepseek-r1': {
    displayName: 'DeepSeek R1',
    contextWindow: 128_000,
    capabilities: { reasoning: true },
    pricing: { input: 0.55, output: 2.19 },
    aliases: ['deepseek-reasoner'],
  },
  // 豆包 / 字节
  'doubao-pro-32k': { displayName: 'Doubao Pro 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'doubao-pro-128k': { displayName: 'Doubao Pro 128K', contextWindow: 128_000, capabilities: { toolUse: true } },
  'doubao-lite-32k': { displayName: 'Doubao Lite 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'doubao-1.5-pro': { displayName: 'Doubao 1.5 Pro', contextWindow: 128_000, capabilities: { vision: true, toolUse: true, reasoning: true } },
  'doubao-1.5-lite': { displayName: 'Doubao 1.5 Lite', contextWindow: 128_000, capabilities: { toolUse: true } },
  // Moonshot / Kimi
  'moonshot-v1-8k': { displayName: 'Moonshot V1 8K', contextWindow: 8_000, capabilities: { toolUse: true } },
  'moonshot-v1-32k': { displayName: 'Moonshot V1 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'moonshot-v1-128k': { displayName: 'Moonshot V1 128K', contextWindow: 128_000, capabilities: { toolUse: true } },
  'kimi-latest': { displayName: 'Kimi Latest', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['kimi'] },
  // GLM 老款（models.dev 仅收录 glm-4.5+）
  'glm-4-plus': { displayName: 'GLM-4 Plus', contextWindow: 128_000, capabilities: { vision: true, toolUse: true } },
  'glm-4-air': { displayName: 'GLM-4 Air', contextWindow: 128_000, capabilities: { vision: true, toolUse: true } },
  'glm-4-airx': { displayName: 'GLM-4 AirX', contextWindow: 8_000, capabilities: { toolUse: true } },
  'glm-4-long': { displayName: 'GLM-4 Long', contextWindow: 1_000_000, capabilities: { toolUse: true } },
  'glm-4-flash': { displayName: 'GLM-4 Flash', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['glm-4-flash-250414'] },
  'glm-4-flashx': { displayName: 'GLM-4 FlashX', contextWindow: 128_000, capabilities: { toolUse: true } },
  'glm-4v': { displayName: 'GLM-4V', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['glm-4v-plus', 'glm-4v-flash'] },
  'glm-z1-air': { displayName: 'GLM-Z1 Air', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true } },
  'glm-z1-airx': { displayName: 'GLM-Z1 AirX', contextWindow: 8_000, capabilities: { toolUse: true, reasoning: true } },
  'glm-z1-flash': { displayName: 'GLM-Z1 Flash', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true } },
  'glm-5-turbo': {
    displayName: 'GLM-5 Turbo',
    contextWindow: 200_000,
    capabilities: { toolUse: true, reasoning: true },
  },
  // Qwen 老款（qwen-max/plus/turbo/vl-max 由 generated 覆盖）
  'qwen-long': { displayName: 'Qwen Long', contextWindow: 1_000_000, capabilities: { toolUse: true } },
  'qwq-32b': { displayName: 'QwQ 32B', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true }, aliases: ['qwq'] },
  // 阶跃（step-3.5/3.7 由 generated 覆盖）
  'step-router-v1': { displayName: 'Step Router V1', contextWindow: 131_072, capabilities: { toolUse: true, reasoning: true }, description: '智能路由模型，自动在 deepseek-v4-pro 与 step-3.5-flash 之间切换' },
  // MiniMax（models.dev 仅收录 MiniMax-M2 系列）
  'minimax-text-01': { displayName: 'MiniMax Text 01', contextWindow: 1_000_000, capabilities: { toolUse: true } },
}
