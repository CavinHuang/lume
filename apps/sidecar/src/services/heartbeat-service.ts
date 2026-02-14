/**
 * Heartbeat Service
 *
 * 复用自 OpenClaw 的 heartbeat 设计
 * 参考: openclaw/src/auto-reply/heartbeat.ts
 *
 * 职责：
 * - 管理心跳定时器
 * - 检查 HEARTBEAT.md 内容
 * - 剥离心跳令牌
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HeartbeatConfig,
  StripHeartbeatMode,
  StripHeartbeatOptions,
  StripHeartbeatResult,
} from "@lume/shared";
import {
  HEARTBEAT_TOKEN,
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_EVERY,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
} from "@lume/shared";
import { getAgentWorkspacePath } from "./config-paths";

// ===== 配置解析 =====

/**
 * Heartbeat 配置输入
 */
export interface HeartbeatConfigInput {
  enabled?: boolean;
  interval?: string;
  prompt?: string;
  maxAckChars?: number;
}

/**
 * 解析心跳间隔字符串
 *
 * 支持格式：
 * - "30s" - 30 秒
 * - "5m" - 5 分钟
 * - "1h" - 1 小时
 */
export function parseHeartbeatInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    return 30 * 60 * 1000; // 默认 30 分钟
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      return 30 * 60 * 1000;
  }
}

/**
 * 解析 Heartbeat 配置
 */
export function resolveHeartbeatConfig(input?: HeartbeatConfigInput): HeartbeatConfig {
  const enabled = input?.enabled ?? true;
  const interval = input?.interval || DEFAULT_HEARTBEAT_EVERY;
  const prompt = input?.prompt?.trim() || HEARTBEAT_PROMPT;
  const maxAckChars = input?.maxAckChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;

  return {
    enabled,
    interval,
    prompt,
    maxAckChars,
  };
}

// ===== HEARTBEAT.md 内容检查 =====

/**
 * 检查 HEARTBEAT.md 内容是否"有效为空"
 *
 * 有效为空意味着文件只包含：
 * - 空白
 * - 注释行（以 # 开头的行）
 * - 空行
 *
 * 这允许在无任务配置时跳过心跳 API 调用
 */
export function isHeartbeatContentEffectivelyEmpty(
  content: string | undefined | null
): boolean {
  if (content === undefined || content === null) {
    return false; // 文件不存在，返回 false 让 LLM 决定
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行
    if (!trimmed) {
      continue;
    }

    // 跳过 markdown 标题行（# 后跟空格或 EOL）
    // 注意：不跳过 "#TODO" 或 "#hashtag" 这类可能的内容
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }

    // 跳过空的 markdown 列表项（如 "- [ ]" 或 "* [ ]" 或只是 "- "）
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }

    // 找到非空、非注释的行 - 有可操作内容
    return false;
  }

  // 所有行都是空的或注释
  return true;
}

// ===== 心跳令牌剥离 =====

/**
 * 在文本边缘剥离令牌
 */
function stripTokenAtEdges(raw: string, token: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;

  while (changed) {
    changed = false;
    const next = text.trim();

    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }

    if (next.endsWith(token)) {
      const before = next.slice(0, Math.max(0, next.length - token.length));
      text = before.trimEnd();
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/**
 * 剥离轻量级标记
 *
 * 使 HEARTBEAT_OK 在包装在 HTML/Markdown 中时仍能被剥离
 * 例如：<b>HEARTBEAT_OK</b> 或 **HEARTBEAT_OK**
 */
function stripMarkup(text: string): string {
  return text
    // 移除 HTML 标签
    .replace(/<[^>]*>/g, " ")
    // 解码常见的 nbsp 变体
    .replace(/&nbsp;/gi, " ")
    // 移除边缘的 markdown 包装
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
}

/**
 * 剥离心跳令牌
 *
 * 处理 HEARTBEAT_OK 响应
 */
export function stripHeartbeatToken(
  raw?: string,
  opts: StripHeartbeatOptions = {}
): StripHeartbeatResult {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS
  );

  // 标准化轻量级标记
  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken =
    trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);

  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed, HEARTBEAT_TOKEN);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized, HEARTBEAT_TOKEN);

  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;

  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();

  // 心跳模式下，短响应视为跳过
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

// ===== Heartbeat 服务 =====

/**
 * 心跳状态
 */
export interface HeartbeatState {
  lastHeartbeatAt: number;
  lastCheckResult: string;
}

/**
 * Heartbeat 服务
 */
export class HeartbeatService {
  private config: HeartbeatConfig;
  private intervalMs: number;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private states: Map<string, HeartbeatState> = new Map();

  constructor(configInput?: HeartbeatConfigInput) {
    this.config = resolveHeartbeatConfig(configInput);
    this.intervalMs = parseHeartbeatInterval(this.config.interval);
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 获取配置
   */
  getConfig(): HeartbeatConfig {
    return this.config;
  }

  /**
   * 获取心跳间隔（毫秒）
   */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * 读取工作区的 HEARTBEAT.md 内容
   */
  readHeartbeatFile(workspaceSlug: string): string | null {
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const heartbeatPath = join(workspacePath, "HEARTBEAT.md");

    if (!existsSync(heartbeatPath)) {
      return null;
    }

    try {
      return readFileSync(heartbeatPath, "utf-8");
    } catch (error) {
      console.error(`[Heartbeat] 读取文件失败: ${heartbeatPath}`, error);
      return null;
    }
  }

  /**
   * 检查是否应该执行心跳
   */
  shouldRunHeartbeat(workspaceSlug: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const heartbeatContent = this.readHeartbeatFile(workspaceSlug);

    // 文件不存在时不执行（让 LLM 自行决定）
    if (heartbeatContent === null) {
      return false;
    }

    // 文件内容有效为空时跳过
    if (isHeartbeatContentEffectivelyEmpty(heartbeatContent)) {
      return false;
    }

    return true;
  }

  /**
   * 获取心跳提示词
   */
  getPrompt(): string {
    return this.config.prompt;
  }

  /**
   * 获取上次心跳时间
   */
  getLastHeartbeatAt(workspaceSlug: string): number | null {
    const state = this.states.get(workspaceSlug);
    return state?.lastHeartbeatAt ?? null;
  }

  /**
   * 更新心跳状态
   */
  updateState(workspaceSlug: string, result: string): void {
    this.states.set(workspaceSlug, {
      lastHeartbeatAt: Date.now(),
      lastCheckResult: result,
    });
  }

  /**
   * 启动心跳定时器
   */
  startTimer(
    workspaceSlug: string,
    callback: () => void | Promise<void>
  ): void {
    if (this.timers.has(workspaceSlug)) {
      return;
    }

    const timer = setInterval(async () => {
      if (this.shouldRunHeartbeat(workspaceSlug)) {
        await callback();
      }
    }, this.intervalMs);

    this.timers.set(workspaceSlug, timer);
    console.log(`[Heartbeat] 已启动定时器: ${workspaceSlug} (间隔: ${this.config.interval})`);
  }

  /**
   * 停止心跳定时器
   */
  stopTimer(workspaceSlug: string): void {
    const timer = this.timers.get(workspaceSlug);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(workspaceSlug);
      console.log(`[Heartbeat] 已停止定时器: ${workspaceSlug}`);
    }
  }

  /**
   * 停止所有定时器
   */
  stopAllTimers(): void {
    for (const [workspaceSlug] of this.timers) {
      this.stopTimer(workspaceSlug);
    }
  }
}

// ===== 单例导出 =====

let defaultService: HeartbeatService | null = null;

/**
 * 获取默认 Heartbeat 服务实例
 */
export function getHeartbeatService(configInput?: HeartbeatConfigInput): HeartbeatService {
  if (!defaultService) {
    defaultService = new HeartbeatService(configInput);
  }
  return defaultService;
}

/**
 * 重置默认 Heartbeat 服务实例（用于测试）
 */
export function resetHeartbeatService(): void {
  if (defaultService) {
    defaultService.stopAllTimers();
    defaultService = null;
  }
}
