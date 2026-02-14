/**
 * Heartbeat Types
 *
 * 复用自 OpenClaw 的 heartbeat 设计
 * 参考: openclaw/src/auto-reply/heartbeat.ts
 */

// ===== 常量 =====

/**
 * 心跳令牌
 */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK"

/**
 * 默认心跳提示词
 */
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. " +
  "Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."

/**
 * 默认心跳间隔
 */
export const DEFAULT_HEARTBEAT_EVERY = "30m"

/**
 * 默认心跳确认最大字符数
 */
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300

// ===== 配置类型 =====

/**
 * Heartbeat 配置
 */
export interface HeartbeatConfig {
  /** 是否启用 */
  enabled: boolean
  /** 心跳间隔（如 "30m", "1h"） */
  interval: string
  /** 心跳提示词 */
  prompt: string
  /** 最大确认字符数 */
  maxAckChars: number
}

/**
 * 心跳剥离模式
 */
export type StripHeartbeatMode = 'heartbeat' | 'message'

/**
 * 心跳剥离选项
 */
export interface StripHeartbeatOptions {
  /** 剥离模式 */
  mode?: StripHeartbeatMode
  /** 最大确认字符数 */
  maxAckChars?: number
}

/**
 * 心跳剥离结果
 */
export interface StripHeartbeatResult {
  /** 是否应跳过（即只有 HEARTBEAT_OK） */
  shouldSkip: boolean
  /** 剥离后的文本 */
  text: string
  /** 是否执行了剥离 */
  didStrip: boolean
}

// ===== 心跳检查类型 =====

/**
 * 心跳检查输入
 */
export interface HeartbeatCheckInput {
  /** 工作区路径 */
  workspacePath: string
  /** 心跳文件内容（可选，用于预读取） */
  heartbeatContent?: string | null
}

/**
 * 心跳检查结果
 */
export interface HeartbeatCheckResult {
  /** 是否需要执行心跳 */
  shouldRun: boolean
  /** 原因 */
  reason?: string
  /** 心跳提示词 */
  prompt?: string
}
