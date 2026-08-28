import type { InboundImRouteMessage } from "./im-message-router";
import { routeInboundImMessage } from "./im-message-router";
import { hasSeenImMessage, rememberImMessage, rememberImMessages } from "./im-seen-message-store";
import { IM_CONTROL_COMMAND_NAMES } from "./im-chat-commands";
import { createLogger } from "../infra/logger";

const log = createLogger("im-pipeline");

/**
 * 入站消息整形管线：防抖合并 + 运行协调。
 *
 * 两层语义：
 * 1. ScopedQueue —— 同一会话(peer)在静默窗口内的连发消息合并为一个批量消息，
 *   只触发一次 agent 运行；运行期间新消息只累积不打断，结束后重新进入静默窗口。
 * 2. RunCoordinator —— 同一会话严格串行，全局并发上限防止多会话同时打满 runtime；
 *   单次路由超时（watchdog）防止挂死运行占满全局槽位。
 *
 * 斜杠命令白名单不排队直通路由：控制面操作不能被长运行阻塞，但仍在入队时
 * 抢占 messageId，避免平台并发重投重复执行命令。
 *
 * enqueue 返回的 Promise 在该消息所在批量路由落定后 resolve/reject：
 * 微信长轮询 worker await 它保持「失败不推 cursor → 下轮重投」的 at-least-once
 * 语义；WS 三渠道 worker void 掉即可。注意防抖窗口内的消息驻留内存，进程崩溃
 * 即丢（微信 cursor 未推进的部分由重投兜底），这是防抖合并的固有权衡。
 */

/**
 * 控制面/会话命令白名单：命中即绕过静默窗口直通路由。
 * 命令名单一来源见 im-chat-commands 的 IM_CONTROL_COMMAND_NAMES。
 */
const CONTROL_COMMAND_RE = new RegExp(
  `^\\/(?:${IM_CONTROL_COMMAND_NAMES.join("|")})(?:@\\S+)?(?:\\s|$)`,
  "i"
);

/** 单会话缓冲条数上限：阻塞期刷屏的内存护栏 */
const MAX_BUFFER_PER_SCOPE = 200;

export interface ImInboundPipelineOptions {
  /** 静默窗口毫秒数，窗口内连发合并 */
  quietWindowMs?: number;
  /** 全局并发运行上限 */
  maxConcurrentRuns?: number;
  /** 单次路由超时毫秒数；超时按失败处理释放槽位（底层运行不中断） */
  runTimeoutMs?: number;
  /** 路由函数（默认真实路由器，测试注入） */
  routeMessage?: (message: InboundImRouteMessage) => Promise<{ threadId: string }>;
  /** 已见判定注入（默认真实 store，测试注入） */
  hasSeen?: (provider: InboundImRouteMessage["provider"], accountId: string, messageId: string) => boolean;
  /** 已见标记注入（默认真实 store，测试注入） */
  remember?: (provider: InboundImRouteMessage["provider"], accountId: string, messageId: string) => void;
  /** 批量已见标记注入（默认真实 store 批量接口，一次落盘） */
  rememberMany?: (items: Array<{ provider: InboundImRouteMessage["provider"]; accountId: string; messageId: string }>) => void;
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

interface CompletionDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function scopeKeyOf(message: InboundImRouteMessage): string {
  return `${message.provider}:${message.accountId}:${message.peerKind}:${message.peerId}`;
}

function createDeferred(): CompletionDeferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 批量合并：文本空行拼接、媒体内容拼接、标量字段取最后一条非空值。
 * 群聊且批内含多个发送者时逐段带发送者前缀并清空 merged.senderId，
 * 避免下游统一前缀把整段文本归到最后一个发送者名下。
 */
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
  const senderIds = new Set(
    batch.map((m) => m.senderId?.trim() ?? "").filter(Boolean)
  );
  const multiSender = head.peerKind === "group" && senderIds.size > 1;
  const text = batch
    .map((m) => {
      const trimmed = m.text.trim();
      if (!trimmed) return "";
      return multiSender && m.senderId?.trim() ? `${m.senderId.trim()}: ${trimmed}` : trimmed;
    })
    .filter(Boolean)
    .join("\n\n");
  return {
    provider: head.provider,
    accountId: head.accountId,
    accountLabel: lastOf((m) => m.accountLabel),
    workspaceId: lastOf((m) => m.workspaceId),
    peerKind: head.peerKind,
    peerId: head.peerId,
    peerName: lastOf((m) => m.peerName),
    senderId: multiSender ? undefined : lastOf((m) => m.senderId),
    text,
    contents: batch.some((m) => m.contents?.length)
      ? batch.flatMap((m) => m.contents ?? [])
      : undefined,
    contextToken: lastOf((m) => m.contextToken),
    // 引用上下文取最后一条的 parent（接力回复场景以最新引用为准）
    parentMessageId: lastOf((m) => m.parentMessageId),
    messageId: undefined
  };
}

export interface ImInboundPipeline {
  /**
   * 入队一条入站消息。返回的 Promise 在该消息所属批量路由成功后 resolve、
   * 失败/超时后 reject（重复 messageId 的调用共享同一 Promise）。
   * 不关心结果的调用方（WS worker）可 void 掉。
   */
  enqueue: (message: InboundImRouteMessage) => Promise<void>;
}

export function createImInboundPipeline(options: ImInboundPipelineOptions = {}): ImInboundPipeline {
  const quietWindowMs = options.quietWindowMs ?? 600;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 3;
  const runTimeoutMs = options.runTimeoutMs ?? 10 * 60 * 1000;
  const routeMessage = options.routeMessage ?? routeInboundImMessage;
  const hasSeen = options.hasSeen ?? hasSeenImMessage;
  const remember = options.remember ?? rememberImMessage;
  // 批量结算：优先批量接口（一次落盘）；仅注入单条 remember 时退化为循环（测试兼容）
  const rememberMany = options.rememberMany
    ?? (options.remember
      ? (items: Array<{ provider: InboundImRouteMessage["provider"]; accountId: string; messageId: string }>) =>
        items.forEach((item) => remember(item.provider, item.accountId, item.messageId))
      : rememberImMessages);
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const scopes = new Map<string, ScopeState>();
  // 在途消息 id：入队即标记（覆盖静默窗口内的同窗重复投递），成功后转持久 store，
  // 失败回滚允许平台重投重试（与路由器“成功后才标记”一致）
  const inflightIds = new Set<string>();
  const inflightKeyOf = (provider: string, accountId: string, messageId: string) =>
    `${provider}:${accountId}:${messageId}`;
  // 每条入队消息的完成信号（微信渠道 await 以驱动 cursor 语义）；key 为在途 id key 或消息对象本身
  const completions = new Map<string | InboundImRouteMessage, CompletionDeferred>();

  const completionKeyOf = (message: InboundImRouteMessage): string | InboundImRouteMessage =>
    message.messageId ? inflightKeyOf(message.provider, message.accountId, message.messageId) : message;

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

  const settleBatch = (batch: InboundImRouteMessage[], error?: unknown) => {
    for (const item of batch) {
      const key = inflightKeyOf(item.provider, item.accountId, item.messageId ?? "");
      completions.get(key)?.[error ? "reject" : "resolve"](error);
      completions.delete(key);
      completions.get(item)?.[error ? "reject" : "resolve"](error);
      completions.delete(item);
    }
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
      await new Promise<{ threadId: string }>((resolve, reject) => {
        const watchdog =
          runTimeoutMs > 0
            ? setTimer(() => reject(new Error(`IM 入站路由超时(${runTimeoutMs}ms)，释放槽位`)), runTimeoutMs)
            : undefined;
        routeMessage(merged).then(
          (value) => {
            if (watchdog !== undefined) clearTimer(watchdog);
            resolve(value);
          },
          (error: unknown) => {
            if (watchdog !== undefined) clearTimer(watchdog);
            reject(error);
          }
        );
      });
      for (const item of batch) {
        if (item.messageId) {
          inflightIds.delete(inflightKeyOf(item.provider, item.accountId, item.messageId));
        }
      }
      // 批量标记已见：一次落盘，避免逐条全量重写 seen-store
      rememberMany(
        batch
          .filter((item) => item.messageId)
          .map((item) => ({ provider: item.provider, accountId: item.accountId, messageId: item.messageId! }))
      );
      settleBatch(batch);
    } catch (error) {
      // 不标记已见且回滚在途标记：平台重投后可在下个窗口重试
      for (const item of batch) {
        if (item.messageId) {
          inflightIds.delete(inflightKeyOf(item.provider, item.accountId, item.messageId));
        }
      }
      settleBatch(batch, error);
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
    // 运行期间到达的消息重新进入静默窗口，而不是立即再触发一次运行；
    // 空闲 scope 释放条目，避免历史会话在进程生命周期内缓慢累积
    if (state.buffer.length > 0) {
      armQuietWindow(state);
    } else if (state.timer === undefined) {
      scopes.delete(scopeKeyOf(merged));
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

  const enqueue = (message: InboundImRouteMessage): Promise<void> => {
    // 斜杠控制面命令直通：不被静默窗口/运行阻塞，也不参与管线去重（路由器自带幂等）。
    // 失败只记日志不 reject：命令（如 /approve 回执）发送失败不应作为毒丸消息
    // 阻塞微信渠道的 cursor 推进，否则整个账号的后续消息被卡死在队头
    if (CONTROL_COMMAND_RE.test(message.text.trim())) {
      const commandKey = message.messageId
        ? inflightKeyOf(message.provider, message.accountId, message.messageId)
        : undefined;
      if (commandKey && (inflightIds.has(commandKey) || hasSeen(message.provider, message.accountId, message.messageId!))) {
        log.info("重复命令，跳过路由", {
          provider: message.provider,
          accountId: message.accountId,
          messageId: message.messageId
        });
        return Promise.resolve();
      }
      if (commandKey) inflightIds.add(commandKey);
      void routeMessage(message)
        .catch((error: unknown) => {
          log.error("IM 命令直通路由失败", {
            provider: message.provider,
            peerId: message.peerId,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          if (commandKey) inflightIds.delete(commandKey);
        });
      return Promise.resolve();
    }
    const existingKey =
      message.messageId ? inflightKeyOf(message.provider, message.accountId, message.messageId) : undefined;
    if (
      existingKey &&
      (inflightIds.has(existingKey) || hasSeen(message.provider, message.accountId, message.messageId!))
    ) {
      log.info("重复消息，跳过入队", {
        provider: message.provider,
        accountId: message.accountId,
        messageId: message.messageId
      });
      const existing = completions.get(existingKey);
      if (existing) return existing.promise;
      return Promise.resolve();
    }
    const deferred = createDeferred();
    completions.set(completionKeyOf(message), deferred);
    const state = scopeStateOf(message);
    state.buffer.push(message);
    // 缓冲软上限：阻塞期刷屏防内存无界累积（丢最旧并告警；被丢消息未 remember，
    // 平台重投仍可处理，但主动丢弃本身不在补偿范围）
    if (state.buffer.length > MAX_BUFFER_PER_SCOPE) {
      const dropped = state.buffer.shift();
      if (dropped) {
        if (dropped.messageId) {
          inflightIds.delete(inflightKeyOf(dropped.provider, dropped.accountId, dropped.messageId));
        }
        // 被丢消息的完成信号必须落定：否则 awaiter 永久挂起、completions 泄漏
        const droppedCompletion = completions.get(completionKeyOf(dropped));
        completions.delete(completionKeyOf(dropped));
        droppedCompletion?.reject(new Error("会话缓冲超限，消息被丢弃"));
      }
      log.warn("IM 会话缓冲超限，丢弃最旧消息", {
        provider: message.provider,
        peerId: message.peerId,
        limit: MAX_BUFFER_PER_SCOPE
      });
    }
    if (existingKey) {
      inflightIds.add(existingKey);
    }
    if (!state.blocked) {
      armQuietWindow(state);
    }
    return deferred.promise;
  };

  return { enqueue };
}

/** 进程级单例：runtime manager 将 worker 的 routeMessage 指向这里 */
export const imInboundPipeline = createImInboundPipeline();
