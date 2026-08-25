/**
 * Session State Manager
 *
 * 管理会话状态，用于 runtime 统计
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getSessionStatesPath } from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";

const log = createLogger("session-state");

/**
 * 会话状态
 */
export interface SessionState {
  /** 会话 ID */
  sessionId: string;
  /** 当前 token 使用量 */
  totalTokens: number;
  /** 上下文窗口大小 */
  contextWindow: number;
  /** 压缩次数 */
  compactionCount: number;
  /** 会话创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/**
 * 会话状态管理器
 */
class SessionStateManager {
  private states: Map<string, SessionState> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const path = getSessionStatesPath();
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, SessionState>;
      for (const [id, state] of Object.entries(data)) {
        this.states.set(id, state);
      }
    } catch {
      // 读取失败忽略，从空状态开始
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, SessionState> = {};
      for (const [id, state] of this.states) {
        data[id] = state;
      }
      writeFileSync(getSessionStatesPath(), JSON.stringify(data), "utf-8");
    } catch (error) {
      // 持久化失败不影响主流程，但必须留痕——否则"清理已落盘"的日志与磁盘事实相反（#615 review round5）
      log.warn("会话状态落盘失败", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 创建或获取会话状态
   */
  getOrCreate(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        totalTokens: 0,
        contextWindow: 200000,
        compactionCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.states.set(sessionId, state);
      log.debug("创建会话状态", { sessionId: sessionId.slice(0, 8) });
    }
    return state;
  }

  /**
   * 更新 token 使用量
   */
  updateTokens(sessionId: string, totalTokens: number, contextWindow?: number): SessionState | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    state.totalTokens = totalTokens;
    if (contextWindow) {
      state.contextWindow = contextWindow;
    }
    state.updatedAt = Date.now();

    log.debug("更新 token 使用量", {
      sessionId: sessionId.slice(0, 8),
      totalTokens,
      contextWindow: state.contextWindow,
    });

    return state;
  }

  /**
   * 增加压缩计数
   */
  incrementCompaction(sessionId: string): SessionState | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    state.compactionCount += 1;
    state.updatedAt = Date.now();
    this.saveToDisk();

    log.info("压缩计数增加", {
      sessionId: sessionId.slice(0, 8),
      compactionCount: state.compactionCount,
    });

    return state;
  }

  /**
   * 删除会话状态
   */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
    log.debug("删除会话状态", { sessionId: sessionId.slice(0, 8) });
  }

  /**
   * 获取所有会话状态
   */
  getAll(): SessionState[] {
    return Array.from(this.states.values());
  }

  /**
   * 清理过期会话状态（超过 24 小时未更新）
   */
  cleanupExpired(): number {
    const { next, cleaned } = pruneExpiredSessionStates(
      Object.fromEntries(this.states),
      Date.now()
    );
    if (cleaned === 0) return 0;

    this.states.clear();
    for (const [sessionId, state] of Object.entries(next)) {
      this.states.set(sessionId, state);
    }
    // 清理结果必须落盘（#615）：否则磁盘文件单调累积，每次重启全量读回后原样再来
    this.saveToDisk();
    log.info("清理过期会话状态", { count: cleaned });
    return cleaned;
  }
}

/**
 * 过期判定纯逻辑（独立导出以便测试——单例在模块加载时读盘，直接测实例会受
 * preload 时序与 LUME_CONFIG_DIR 环境影响）。
 */
export function pruneExpiredSessionStates(
  states: Record<string, SessionState>,
  now: number,
  maxAgeMs = 24 * 60 * 60 * 1000
): { next: Record<string, SessionState>; cleaned: number } {
  const next: Record<string, SessionState> = {};
  let cleaned = 0;
  for (const [sessionId, state] of Object.entries(states)) {
    if (now - state.updatedAt > maxAgeMs) {
      cleaned += 1;
      continue;
    }
    next[sessionId] = state;
  }
  return { next, cleaned };
}

// 单例实例
const sessionStateManager = new SessionStateManager();

/**
 * 获取会话状态管理器实例
 */
export function getSessionStateManager(): SessionStateManager {
  return sessionStateManager;
}

// 定期清理过期会话状态（每小时执行一次）
setInterval(() => {
  sessionStateManager.cleanupExpired();
}, 60 * 60 * 1000);
