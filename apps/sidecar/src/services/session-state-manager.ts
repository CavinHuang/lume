/**
 * Session State Manager
 *
 * 管理会话状态，用于 Memory Flush 和 Heartbeat 功能
 */

import type { MemoryFlushCheckParams, MemoryFlushResult } from "@lume/shared";
import { getMemoryFlushService } from "./memory-flush-service";
import { getHeartbeatService } from "./heartbeat-service";
import { createLogger } from "./logger";

const log = createLogger("session-state");

/**
 * 会话状态
 */
export interface SessionState {
  /** 会话 ID */
  sessionId: string;
  /** 工作区 slug */
  workspaceSlug?: string;
  /** 当前 token 使用量 */
  totalTokens: number;
  /** 上下文窗口大小 */
  contextWindow: number;
  /** 压缩次数 */
  compactionCount: number;
  /** 上次 Memory Flush 时的压缩次数 */
  memoryFlushCompactionCount: number | null;
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

  /**
   * 创建或获取会话状态
   */
  getOrCreate(sessionId: string, workspaceSlug?: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        workspaceSlug,
        totalTokens: 0,
        contextWindow: 200000, // 默认 200k
        compactionCount: 0,
        memoryFlushCompactionCount: null,
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
  updateTokens(sessionId: string, inputTokens: number, contextWindow?: number): SessionState | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    state.totalTokens = inputTokens;
    if (contextWindow) {
      state.contextWindow = contextWindow;
    }
    state.updatedAt = Date.now();

    log.debug("更新 token 使用量", {
      sessionId: sessionId.slice(0, 8),
      totalTokens: inputTokens,
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

    log.info("压缩计数增加", {
      sessionId: sessionId.slice(0, 8),
      compactionCount: state.compactionCount,
    });

    return state;
  }

  /**
   * 标记 Memory Flush 已执行
   */
  markMemoryFlushExecuted(sessionId: string): SessionState | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    state.memoryFlushCompactionCount = state.compactionCount;
    state.updatedAt = Date.now();

    log.info("Memory Flush 已执行", {
      sessionId: sessionId.slice(0, 8),
      atCompaction: state.compactionCount,
    });

    return state;
  }

  /**
   * 检查是否需要执行 Memory Flush
   */
  checkMemoryFlush(sessionId: string): MemoryFlushResult {
    const state = this.states.get(sessionId);
    if (!state) {
      return { executed: false, reason: "会话状态不存在" };
    }

    const memoryFlushService = getMemoryFlushService();
    if (!memoryFlushService.isEnabled()) {
      return { executed: false, reason: "Memory Flush 未启用" };
    }

    const params: MemoryFlushCheckParams = {
      entry: {
        totalTokens: state.totalTokens,
        compactionCount: state.compactionCount,
        memoryFlushCompactionCount: state.memoryFlushCompactionCount ?? undefined,
      },
      contextWindowTokens: state.contextWindow,
      reserveTokensFloor: memoryFlushService.getConfig()?.reserveTokensFloor ?? 8000,
      softThresholdTokens: memoryFlushService.getConfig()?.softThresholdTokens ?? 4000,
    };

    return memoryFlushService.check(params);
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
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 小时
    let cleaned = 0;

    for (const [sessionId, state] of this.states) {
      if (now - state.updatedAt > maxAge) {
        this.states.delete(sessionId);
        cleaned += 1;
      }
    }

    if (cleaned > 0) {
      log.info("清理过期会话状态", { count: cleaned });
    }

    return cleaned;
  }
}

// 单例实例
const sessionStateManager = new SessionStateManager();

/**
 * 获取会话状态管理器实例
 */
export function getSessionStateManager(): SessionStateManager {
  return sessionStateManager;
}

// ===== Heartbeat 集成 =====

/**
 * 启动会话的心跳定时器
 */
export function startSessionHeartbeat(
  sessionId: string,
  workspaceSlug: string,
  onHeartbeat: () => void | Promise<void>
): void {
  const heartbeatService = getHeartbeatService();

  if (!heartbeatService.isEnabled()) {
    log.debug("Heartbeat 未启用", { sessionId: sessionId.slice(0, 8) });
    return;
  }

  if (!heartbeatService.shouldRunHeartbeat(workspaceSlug)) {
    log.debug("HEARTBEAT.md 为空或不存在，跳过心跳", {
      sessionId: sessionId.slice(0, 8),
      workspaceSlug,
    });
    return;
  }

  heartbeatService.startTimer(workspaceSlug, async () => {
    log.info("执行心跳检查", { sessionId: sessionId.slice(0, 8), workspaceSlug });
    try {
      await onHeartbeat();
      heartbeatService.updateState(workspaceSlug, "completed");
    } catch (error) {
      log.error("心跳执行失败", { sessionId: sessionId.slice(0, 8), error: String(error) });
      heartbeatService.updateState(workspaceSlug, `error: ${error}`);
    }
  });

  log.info("心跳定时器已启动", {
    sessionId: sessionId.slice(0, 8),
    workspaceSlug,
    interval: heartbeatService.getIntervalMs() / 1000 / 60 + "m",
  });
}

/**
 * 停止会话的心跳定时器
 */
export function stopSessionHeartbeat(workspaceSlug: string): void {
  const heartbeatService = getHeartbeatService();
  heartbeatService.stopTimer(workspaceSlug);
  log.info("心跳定时器已停止", { workspaceSlug });
}

// 定期清理过期会话状态（每小时执行一次）
setInterval(() => {
  sessionStateManager.cleanupExpired();
}, 60 * 60 * 1000);
