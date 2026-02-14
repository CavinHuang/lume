/**
 * Memory Flush Types
 *
 * 复用自 OpenClaw 的 memory-flush 设计
 * 参考: openclaw/src/auto-reply/reply/memory-flush.ts
 */

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
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  "If nothing to store, reply with NO_REPLY.",
].join(" ")

/**
 * 默认 Memory Flush 系统提示词
 */
export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  "You may reply, but usually NO_REPLY is correct.",
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
