/**
 * Memory Flush Types
 *
 * 复用自 OpenClaw 的 memory-flush 设计
 * 参考来源: 早期 memory flush 设计
 */

import type { MemoryKind, MemoryScope } from "./memory";

// ===== 常量 =====

/**
 * 默认 Memory Flush 软阈值（token 数）
 *
 * 当剩余 token 低于此值时触发 Memory Flush
 */
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000

/**
 * 默认 Memory Flush 提示词
 */
export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Extract durable memories from this session.",
  "Return JSON only.",
  "Schema: {\"entries\":[{\"kind\":\"decision | preference | fact | episode | lesson | milestone\",\"title\":\"...\",\"content\":\"...\",\"importance\":1,\"tags\":[\"...\"]}]}",
  "Only include memories that will matter in future collaboration.",
  "If nothing should be stored, return {\"entries\":[]}.",
].join(" ")

/**
 * 默认 Memory Flush 系统提示词
 */
export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; extract structured durable memories.",
  "Return JSON only and do not write markdown directly.",
].join(" ")

/**
 * 静默回复令牌
 */
export const SILENT_REPLY_TOKEN = "NO_REPLY"

// ===== 配置类型 =====

/**
 * Memory Flush 配置
 */
export interface MemoryFlushConfig {
  /** 是否启用 */
  enabled: boolean
  /** 软阈值（token 数），当剩余 token 低于此值时触发 */
  softThresholdTokens: number
  /** 用户提示词 */
  prompt: string
  /** 系统提示词 */
  systemPrompt: string
  /** 底层保留 token 数 */
  reserveTokensFloor: number
}

/**
 * Memory Flush 判断参数
 */
export interface MemoryFlushCheckParams {
  /** 会话条目 */
  entry?: {
    /** 当前总 token 数 */
    totalTokens?: number
    /** 压缩次数 */
    compactionCount?: number
    /** 上次 Memory Flush 时的压缩次数 */
    memoryFlushCompactionCount?: number
  }
  /** 上下文窗口 token 数 */
  contextWindowTokens: number
  /** 底层保留 token 数 */
  reserveTokensFloor: number
  /** 软阈值 token 数 */
  softThresholdTokens: number
}

export interface MemoryFlushEntry {
  kind: MemoryKind
  scope?: MemoryScope
  title?: string
  content: string
  summary?: string
  importance: 1 | 2 | 3 | 4 | 5
  confidence?: number
  tags?: string[]
  entities?: string[]
  topics?: string[]
  sourceMessageIds?: string[]
}

export interface MemoryFlushPayload {
  workspaceSlug: string
  sessionId: string
  entries: MemoryFlushEntry[]
}

/**
 * Memory Flush 执行结果
 */
export interface MemoryFlushResult {
  /** 是否执行了 Memory Flush */
  executed: boolean
  /** 执行原因 */
  reason?: string
  /** 生成的提示词 */
  prompt?: string
  /** 生成的系统提示词 */
  systemPrompt?: string
  /** 结构化记忆 payload */
  payload?: MemoryFlushPayload
  /** 成功保存条数 */
  savedCount?: number
  /** 跳过条数 */
  skippedCount?: number
}

// ===== 工具函数类型 =====

/**
 * 解析 Memory Flush 设置的配置输入
 */
export interface ResolveMemoryFlushConfigInput {
  /** 是否启用 */
  enabled?: boolean
  /** 软阈值 token 数 */
  softThresholdTokens?: number
  /** 用户提示词 */
  prompt?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 底层保留 token 数 */
  reserveTokensFloor?: number
}

/**
 * 解析 Memory Flush 上下文窗口 token 数的输入
 */
export interface ResolveMemoryFlushContextWindowInput {
  /** 模型 ID */
  modelId?: string
  /** Agent 配置的上下文 token 数 */
  agentCfgContextTokens?: number
}
