/**
 * 人工稳定层 —— sync-models 脚本永不写入此文件。
 * 仅放：中文 description / aliases / 国产缺口模型 / 字段修正。
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

/**
 * Task 4 将填充真实内容。当前为空骨架，保证 model-meta.ts 接线后行为等价于纯 generated。
 */
export const MODEL_OVERRIDES: Record<string, ModelOverride> = {}
