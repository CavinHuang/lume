/**
 * Memory Flush Service
 *
 * 复用自 OpenClaw 的 memory-flush 设计
 * 参考: openclaw/src/auto-reply/reply/memory-flush.ts
 *
 * 职责：
 * - 判断是否需要执行 Memory Flush
 * - 生成 Memory Flush 提示词
 * - 管理会话的 Memory Flush 状态
 */

import type {
  MemoryFlushConfig,
  MemoryFlushCheckParams,
  MemoryFlushResult,
} from "@lume/shared";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
  SILENT_REPLY_TOKEN,
} from "@lume/shared";

// ===== 默认配置 =====

/**
 * 默认压缩保留 token 底线
 */
const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 16000;

// ===== 工具函数 =====

/**
 * 标准化非负整数
 */
function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

/**
 * 确保提示词包含静默回复提示
 */
function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

// ===== 配置解析 =====

/**
 * Memory Flush 配置输入
 */
export interface MemoryFlushConfigInput {
  enabled?: boolean;
  softThresholdTokens?: number;
  prompt?: string;
  systemPrompt?: string;
  reserveTokensFloor?: number;
}

/**
 * 解析 Memory Flush 配置
 */
export function resolveMemoryFlushConfig(input?: MemoryFlushConfigInput): MemoryFlushConfig | null {
  const enabled = input?.enabled ?? true;
  if (!enabled) {
    return null;
  }

  const softThresholdTokens =
    normalizeNonNegativeInt(input?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  const prompt = input?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT;
  const systemPrompt = input?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;
  const reserveTokensFloor =
    normalizeNonNegativeInt(input?.reserveTokensFloor) ?? DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR;

  return {
    enabled,
    softThresholdTokens,
    prompt: ensureNoReplyHint(prompt),
    systemPrompt: ensureNoReplyHint(systemPrompt),
    reserveTokensFloor,
  };
}

// ===== 上下文窗口解析 =====

/**
 * 上下文窗口解析输入
 */
export interface ContextWindowInput {
  modelId?: string;
  agentCfgContextTokens?: number;
}

/**
 * 默认上下文窗口 token 数
 */
const DEFAULT_CONTEXT_TOKENS = 200000;

/**
 * 模型上下文窗口映射
 *
 * 已知模型的上下文窗口大小
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude 4 系列
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5-20251001': 200000,
  // Claude 3.5 系列
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-haiku-20241022': 200000,
  // Claude 3 系列
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  // GPT-4 系列
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  // Gemini 系列
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-2.0-flash': 1000000,
};

/**
 * 查找模型的上下文窗口大小
 */
function lookupContextTokens(modelId?: string): number | null {
  if (!modelId) return null;

  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[modelId]) {
    return MODEL_CONTEXT_WINDOWS[modelId];
  }

  // 模糊匹配（处理带日期后缀的模型 ID）
  const normalizedModelId = modelId.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalizedModelId.includes(key.toLowerCase().split('-').slice(0, 3).join('-'))) {
      return value;
    }
  }

  return null;
}

/**
 * 解析上下文窗口 token 数
 */
export function resolveContextWindowTokens(input: ContextWindowInput): number {
  return (
    lookupContextTokens(input.modelId) ??
    input.agentCfgContextTokens ??
    DEFAULT_CONTEXT_TOKENS
  );
}

// ===== Memory Flush 判断 =====

/**
 * 判断是否需要执行 Memory Flush
 *
 * 触发条件：
 * 1. Token 使用量接近上下文窗口限制
 * 2. 当前压缩周期内尚未执行过 Memory Flush
 */
export function shouldRunMemoryFlush(params: MemoryFlushCheckParams): boolean {
  const totalTokens = params.entry?.totalTokens;
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }

  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));

  // 计算阈值：上下文窗口 - 保留 token - 软阈值
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);

  // 阈值为 0 或负数时不触发
  if (threshold <= 0) {
    return false;
  }

  // Token 使用量未达到阈值
  if (totalTokens < threshold) {
    return false;
  }

  // 检查是否已在当前压缩周期执行过
  const compactionCount = params.entry?.compactionCount ?? 0;
  const lastFlushAt = params.entry?.memoryFlushCompactionCount;

  if (typeof lastFlushAt === "number" && lastFlushAt === compactionCount) {
    return false;
  }

  return true;
}

// ===== Memory Flush 执行 =====

/**
 * Memory Flush 服务
 */
export class MemoryFlushService {
  private config: MemoryFlushConfig | null;

  constructor(configInput?: MemoryFlushConfigInput) {
    this.config = resolveMemoryFlushConfig(configInput);
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config !== null;
  }

  /**
   * 获取配置
   */
  getConfig(): MemoryFlushConfig | null {
    return this.config;
  }

  /**
   * 检查是否需要执行 Memory Flush
   */
  check(params: MemoryFlushCheckParams): MemoryFlushResult {
    if (!this.config) {
      return {
        executed: false,
        reason: 'Memory Flush 未启用',
      };
    }

    if (!shouldRunMemoryFlush(params)) {
      return {
        executed: false,
        reason: '未达到触发阈值',
      };
    }

    return {
      executed: true,
      reason: 'Token 使用量接近上下文窗口限制',
      prompt: this.config.prompt,
      systemPrompt: this.config.systemPrompt,
    };
  }

  /**
   * 获取 Memory Flush 提示词
   */
  getPrompt(): string {
    return this.config?.prompt ?? DEFAULT_MEMORY_FLUSH_PROMPT;
  }

  /**
   * 获取 Memory Flush 系统提示词
   */
  getSystemPrompt(): string {
    return this.config?.systemPrompt ?? DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;
  }
}

// ===== 单例导出 =====

let defaultService: MemoryFlushService | null = null;

/**
 * 获取默认 Memory Flush 服务实例
 */
export function getMemoryFlushService(configInput?: MemoryFlushConfigInput): MemoryFlushService {
  if (!defaultService) {
    defaultService = new MemoryFlushService(configInput);
  }
  return defaultService;
}

/**
 * 重置默认 Memory Flush 服务实例（用于测试）
 */
export function resetMemoryFlushService(): void {
  defaultService = null;
}
