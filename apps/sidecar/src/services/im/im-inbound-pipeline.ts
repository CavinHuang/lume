import type { InboundImRouteMessage } from "./im-message-router";
import { routeInboundImMessage } from "./im-message-router";
import { hasSeenImMessage, rememberImMessage } from "./im-seen-message-store";
import { createLogger } from "../infra/logger";

const log = createLogger("im-pipeline");

/**
 * 入站消息整形管线：防抖合并 + 运行协调。
 *
 * 两层语义：
 * 1. ScopedQueue —— 同一会话(peer)在静默窗口内的连发消息合并为一个批量消息，
 *   只触发一次 agent 运行；运行期间新消息只累积不打断，结束后重新进入静默窗口。
 * 2. RunCoordinator —— 同一会话严格串行，全局并发上限防止多会话同时打满 runtime。
 *
 * 斜杠命令（/ 开头）不排队，直接透传路由器（审批等控制面操作不能被长运行阻塞）。
 */

export interface ImInboundPipelineOptions {
  /** 静默窗口毫秒数，窗口内连发合并 */
  quietWindowMs?: number;
  /** 全局并发运行上限 */
  maxConcurrentRuns?: number;
  /** 路由函数（默认真实路由器，测试注入） */
  routeMessage?: (message: InboundImRouteMessage) => Promise<{ threadId: string }>;
  /** 已见判定注入（默认真实 store，测试注入） */
  hasSeen?: (provider: InboundImRouteMessage["provider"], accountId: string, messageId: string) => boolean;
  /** 已见标记注入（默认真实 store，测试注入） */
  remember?: (provider: InboundImRouteMessage["provider"], accountId: string, messageId: string) => void;
  /** 定时器注入（测试用） */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface ScopeState {
  buffer: InboundImRouteMessage[];
  /** 运行进行中：新消息只累积，不启动静默窗口 */
  blocked: boolean;
  timer?: unknown;
}

function scopeKeyOf(message: InboundImRouteMessage): string {
  return `${message.provider}:${message.accountId}:${message.peerKind}:${message.peerId}`;
}

/** 批量合并：文本空行拼接、媒体内容拼接、标量字段取最后一条非空值。 */
export function mergeImMessageBatch(batch: InboundImRouteMessage[]): InboundImRouteMessage {
  const head = batch[0];
  if (!head) {
    throw new Error("mergeImMessageBatch: 空批量");
  }
  if (batch.length === 1) {
    // 单条也剥掉 messageId：已见标记由管线负责（成功后逐条 remember），
    // 避免路由器只记住批内最后一条导致其余成员可被重投重复处理。
    return { ...head, messageId: undefined };
  }
  const lastOf = <T>(pick: (m: InboundImRouteMessage) => T): T | undefined => {
    for (let i = batch.length - 1; i >= 0; i -= 1) {
      const item = batch[i];
      if (!item) continue;
      const value = pick(item);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    provider: head.provider,
    accountId: head.accountId,
    accountLabel: lastOf((m) => m.accountLabel),
    workspaceId: lastOf((m) => m.workspaceId),
    peerKind: head.peerKind,
    peerId: head.peerId,
    peerName: lastOf((m) => m.peerName),
    senderId: lastOf((m) => m.senderId),
    text: batch.map((m) => m.text.trim()).filter(Boolean).join("\n\n"),
    contents: batch.some((m) => m.contents?.length)
      ? batch.flatMap((m) => m.contents ?? [])
      : undefined,
    contextToken: lastOf((m) => m.contextToken),
    messageId: undefined
  };
}

export interface ImInboundPipeline {
  enqueue: (message: InboundImRouteMessage) => void;
  /** 测试与命令直通辅助：丢弃指定会话当前累积的普通消息（如 /new 等会话级命令执行时调用） */
  discardPending: (message: Pick<InboundImRouteMessage, "provider" | "accountId" | "peerKind" | "peerId">) => number;
}

export function createImInboundPipeline(options: ImInboundPipelineOptions = {}): ImInboundPipeline {
  const quietWindowMs = options.quietWindowMs ?? 600;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 3;
  const routeMessage = options.routeMessage ?? routeInboundImMessage;
  const hasSeen = options.hasSeen ?? hasSeenImMessage;
  const remember = options.remember ?? rememberImMessage;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const scopes = new Map<string, ScopeState>();
  // 在途消息 id：入队即标记（覆盖静默窗口内的同窗重复），成功后转持久 store，失败回滚允许重投重试
  const inflightIds = new Set<string>();
  const inflightKeyOf = (provider: string, accountId: string, messageId: string) =>
    `${provider}:${accountId}:${messageId}`;

  let activeRuns = 0;
  // 全局 FIFO 等待队列：释放槽位时唤醒最早等待的会话
  const slotWaiters: Array<() => void> = [];

  const acquireSlot = (): Promise<() => void> => {
    return new Promise((resolve) => {
      const grant = () => {
        activeRuns += 1;
        resolve(() => {
          activeRuns -= 1;
          const next = slotWaiters.shift();
          if (next) next();
        });
      };
      if (activeRuns < maxConcurrentRuns) {
        grant();
        return;
      }
      slotWaiters.push(grant);
    });
  };

  const armQuietWindow = (state: ScopeState) => {
    if (state.timer !== undefined) {
      clearTimer(state.timer);
    }
    state.timer = setTimer(() => {
      state.timer = undefined;
      void flushScope(state);
    }, quietWindowMs);
  };

  const flushScope = async (state: ScopeState) => {
    if (state.blocked || state.timer !== undefined || state.buffer.length === 0) {
      return;
    }
    const batch = state.buffer.splice(0);
    const merged = mergeImMessageBatch(batch);
    state.blocked = true;
    let release: (() => void) | undefined;
    try {
      release = await acquireSlot();
      await routeMessage(merged);
      for (const item of batch) {
        if (item.messageId) {
          remember(item.provider, item.accountId, item.messageId);
          inflightIds.delete(inflightKeyOf(item.provider, item.accountId, item.messageId));
        }
      }
    } catch (error) {
      // 不标记已见且回滚在途标记：平台重投后可在下个窗口重试（与路由器“成功后才标记”一致）
      for (const item of batch) {
        if (item.messageId) {
          inflightIds.delete(inflightKeyOf(item.provider, item.accountId, item.messageId));
        }
      }
      log.error("IM 入站批量路由失败", {
        provider: merged.provider,
        accountId: merged.accountId,
        peerId: merged.peerId,
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      release?.();
      state.blocked = false;
    }
    // 运行期间到达的消息重新进入静默窗口，而不是立即再触发一次运行
    if (state.buffer.length > 0) {
      armQuietWindow(state);
    }
  };

  const scopeStateOf = (message: InboundImRouteMessage): ScopeState => {
    const key = scopeKeyOf(message);
    let state = scopes.get(key);
    if (!state) {
      state = { buffer: [], blocked: false };
      scopes.set(key, state);
    }
    return state;
  };

  return {
    enqueue: (message) => {
      // 斜杠命令是控制面操作（审批、后续会话命令），不能被静默窗口或运行中的批量阻塞
      if (message.text.trim().startsWith("/")) {
        void routeMessage(message).catch((error: unknown) => {
          log.error("IM 命令直通路由失败", {
            provider: message.provider,
            peerId: message.peerId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        return;
      }
      if (
        message.messageId &&
        (inflightIds.has(inflightKeyOf(message.provider, message.accountId, message.messageId)) ||
          hasSeen(message.provider, message.accountId, message.messageId))
      ) {
        log.info("重复消息，跳过入队", {
          provider: message.provider,
          accountId: message.accountId,
          messageId: message.messageId
        });
        return;
      }
      const state = scopeStateOf(message);
      state.buffer.push(message);
      if (message.messageId) {
        inflightIds.add(inflightKeyOf(message.provider, message.accountId, message.messageId));
      }
      if (!state.blocked) {
        armQuietWindow(state);
      }
    },
    discardPending: (message) => {
      const state = scopes.get(
        `${message.provider}:${message.accountId}:${message.peerKind}:${message.peerId}`
      );
      if (!state) return 0;
      const dropped = state.buffer.length;
      state.buffer.length = 0;
      if (state.timer !== undefined) {
        clearTimer(state.timer);
        state.timer = undefined;
      }
      return dropped;
    }
  };
}

/** 进程级单例：runtime manager 将 worker 的 routeMessage 指向这里 */
export const imInboundPipeline = createImInboundPipeline();
