import type { LumeRuntimeEvent } from "@lume/shared";
import { initialImRunCardState, reduceImRunCardEvent, type ImRunCardState } from "./feishu-card-state";
import { renderImRunCard } from "./feishu-card-renderer";
import { getSharedFeishuClient, type FeishuRestClient } from "./feishu-api";
import { getImAccount, getImRuntimeAccount } from "../im-config-manager";
import {
  checkpointActiveFeishuCard,
  listActiveFeishuCards,
  registerActiveFeishuCard,
  removeActiveFeishuCard,
  reserveActiveFeishuCardSequenceBlock
} from "./feishu-card-recovery-store";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-feishu-card");

/**
 * 飞书流式卡片会话：一次 agent 运行对应一张可实时更新的卡片。
 *
 * 流程：open() 创建 CardKit 卡片实体并以 interactive 消息发到会话 →
 * 运行事件经 reducer 更新本地状态，节流（throttle）后全量 card.update 推送
 * （sequence 递增；全量更新使终态头部变色生效）→ 终态事件触发强制刷新并停止更新。
 *
 * 失败降级：单次更新失败退避重试；重试耗尽丢帧仅记日志；开卡失败由调用方
 * 回退纯文本投递。卡片通道任何故障不影响路由与回复送达。
 *
 * 强杀无法执行进程内回调：活跃卡片会落 0600 状态快照，并在下次启动时
 * 用同一账号凭据补写中断终态。
 */

export interface FeishuCardStreamOptions {
  appId: string;
  appSecret: string;
  /** 仅生产传入：用于不落密钥的跨重启卡片收尾。 */
  accountId?: string;
  /** 目标会话 chat_id */
  chatId: string;
  /** 推送节流毫秒数（默认 400ms：窗口内合并，周期性发出最新状态） */
  throttleMs?: number;
  /** 测试注入伪 client；生产走共享缓存 client */
  client?: FeishuRestClient;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 终态强刷失败（回复内容只在卡上、用户看不到）时通知调用方文本兜底，每次运行至多一次 */
  onTerminalFlushFailed?: () => void;
}

export interface FeishuCardStream {
  /** 创建卡片实例并发送首条消息；失败返回 false（调用方放弃卡片通道） */
  open(): Promise<boolean>;
  apply(event: LumeRuntimeEvent): void;
  /** 当前状态（测试观察用） */
  readonly state: ImRunCardState;
  /** 卡片通道是否已降级（连续多轮推送失败）：true 时调用方应回退文本投递 */
  readonly degraded: boolean;
  close(): void;
  /** #598：置中断终态并立即推送（优雅关停时不再把卡片留在「正在处理」）；完成后自关 */
  abortInterrupted(reason?: string): Promise<void>;
}

/** #598：活跃卡片流登记表——优雅关停时统一收尾，避免卡片停留「正在处理」 */
const activeCardStreams = new Set<FeishuCardStream>();

/** #598：把全部活跃运行卡片置为中断终态（用于 sidecar 优雅退出）。 */
export function abortActiveFeishuRunCards(reason?: string): Promise<void> {
  return Promise.allSettled([...activeCardStreams].map((stream) => stream.abortInterrupted(reason))).then(() => undefined);
}

const UPDATE_RETRY_MAX = 2;
const UPDATE_RETRY_BASE_MS = 200;
/** 单次更新的 HTTP 超时：防止挂起请求永久占住发送锁 */
const UPDATE_TIMEOUT_MS = 10_000;
/** 运行态快照最多每 5 秒落一次；sequence 另按 1000 个一块预留，避免高频写盘。 */
const RECOVERY_CHECKPOINT_INTERVAL_MS = 5_000;

function isBusinessError(result: unknown): string | null {
  if (result && typeof result === "object") {
    const code = (result as { code?: unknown }).code;
    if (typeof code === "number" && code !== 0) {
      const msg = (result as { msg?: unknown }).msg;
      return `飞书业务错误码 ${code}${typeof msg === "string" ? `: ${msg}` : ""}`;
    }
  }
  return null;
}

export function createFeishuCardStream(options: FeishuCardStreamOptions): FeishuCardStream {
  const throttleMs = options.throttleMs ?? 400;
  const client = options.client ?? getSharedFeishuClient(options.appId, options.appSecret);
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state = initialImRunCardState(Date.now());
  let cardId: string | undefined;
  let sequence = 0;
  let sequenceCeiling = 0;
  let recoveryTracked = false;
  let lastRecoveryCheckpointAt = 0;
  let closed = false;
  let sending = false;
  let dirty = false;
  let timer: unknown;
  // 连续整轮推送失败次数：达到阈值判定通道降级，调用方应回退文本投递
  let consecutiveUpdateFailures = 0;
  const DEGRADED_FAILURE_THRESHOLD = 3;
  let terminalFallbackNotified = false;

  const reserveSequenceIfNeeded = (): number => {
    if (recoveryTracked && cardId && sequence >= sequenceCeiling) {
      const reserved = reserveActiveFeishuCardSequenceBlock(cardId);
      if (reserved) {
        sequence = reserved.sequence;
        sequenceCeiling = reserved.ceiling;
        return sequence;
      }
    }
    sequence += 1;
    return sequence;
  };

  const checkpointRecoveryState = (force = false): void => {
    if (!recoveryTracked || !cardId) return;
    const now = Date.now();
    if (!force && now - lastRecoveryCheckpointAt < RECOVERY_CHECKPOINT_INTERVAL_MS) return;
    if (checkpointActiveFeishuCard(cardId, state)) lastRecoveryCheckpointAt = now;
  };

  const stopTracking = (removeRecoveryEntry: boolean): void => {
    closed = true;
    activeCardStreams.delete(stream);
    if (removeRecoveryEntry && cardId) removeActiveFeishuCard(cardId);
    recoveryTracked = false;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const handle = setTimer(() => reject(new Error(`${label} 超时(${timeoutMs}ms)`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimer(handle);
          resolve(value);
        },
        (error: unknown) => {
          clearTimer(handle);
          reject(error);
        }
      );
    });
  };

  const pushCurrent = async (): Promise<boolean> => {
    const target = cardId;
    if (!target) return false;
    checkpointRecoveryState(state.status !== "running");
    for (let attempt = 0; attempt <= UPDATE_RETRY_MAX; attempt += 1) {
      if (closed) return false;
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimer(() => resolve(), UPDATE_RETRY_BASE_MS * attempt));
        if (closed) return false;
      }
      try {
        const nextSequence = reserveSequenceIfNeeded();
        const result = await withTimeout(
          client.cardkit.v1.card.update({
            data: {
              sequence: nextSequence,
              card: { type: "card_json", data: JSON.stringify(renderImRunCard(state)) }
            },
            path: { card_id: target }
          }),
          UPDATE_TIMEOUT_MS,
          "卡片更新"
        );
        // SDK 对 HTTP 200 的业务错误不 reject，须显式检查 code
        const businessError = isBusinessError(result);
        if (businessError) {
          throw new Error(businessError);
        }
        checkpointRecoveryState();
        return true;
      } catch (error) {
        // 重试耗尽只记日志丢帧：本地状态保留，下个窗口继续推最新状态
        if (attempt === UPDATE_RETRY_MAX) {
          log.warn("卡片更新失败（已重试）", {
            cardId: target,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    return false;
  };

  const sendCurrent = (): Promise<boolean> => {
    if (!cardId || closed) return Promise.resolve(false);
    sending = true;
    return pushCurrent()
      .then((ok) => {
        consecutiveUpdateFailures = ok ? 0 : consecutiveUpdateFailures + 1;
        if (ok && state.status !== "running") stopTracking(true);
        return ok;
      })
      .finally(() => {
        sending = false;
        // 发送期间有新状态落地：运行中回到节流队列，终态立即补发
        if (dirty && !closed && cardId) {
          void requestFlush(state.status !== "running");
        }
      });
  };

  const requestFlush = (immediate: boolean): Promise<void> => {
    dirty = true;
    if (closed || !cardId || sending) return Promise.resolve();
    if (!immediate) {
      // 节流（非防抖）：已有排队窗口时直接复用，持续事件流按固定周期刷出
      if (timer === undefined) {
        timer = setTimer(() => {
          timer = undefined;
          dirty = false;
          void sendCurrent();
        }, throttleMs);
      }
      return Promise.resolve();
    }
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    dirty = false;
    return sendCurrent().then((ok) => {
      if (!ok && state.status !== "running") {
        log.error("终态卡片刷新失败，卡片可能停留在处理中状态", { chatId: options.chatId });
        // 终态刷不出 = 回复内容只在卡上、用户永远看不到：通知调用方文本兜底
        if (!terminalFallbackNotified) {
          terminalFallbackNotified = true;
          options.onTerminalFlushFailed?.();
        }
      }
    });
  };

  const stream: FeishuCardStream = {
    open: async (): Promise<boolean> => {
      try {
        const created = await withTimeout(
          client.cardkit.v1.card.create({
            data: {
              type: "card_doc",
              data: JSON.stringify(renderImRunCard(state))
            }
          }),
          UPDATE_TIMEOUT_MS,
          "卡片创建"
        );
        const businessError = isBusinessError(created);
        if (businessError) {
          log.warn("创建流式卡片被拒，回退文本回复", { chatId: options.chatId, error: businessError });
          return false;
        }
        cardId = created.data?.card_id;
        if (!cardId) {
          log.warn("创建卡片未返回 card_id，放弃卡片通道");
          return false;
        }
        if (options.accountId) {
          recoveryTracked = registerActiveFeishuCard({
            cardId,
            accountId: options.accountId,
            chatId: options.chatId,
            state
          });
          if (recoveryTracked) {
            const reserved = reserveActiveFeishuCardSequenceBlock(cardId);
            if (reserved) {
              sequence = reserved.sequence - 1;
              sequenceCeiling = reserved.ceiling;
              lastRecoveryCheckpointAt = Date.now();
            } else {
              removeActiveFeishuCard(cardId);
              recoveryTracked = false;
            }
          }
        }
        const sent = await withTimeout(
          client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: options.chatId,
              msg_type: "interactive",
              content: JSON.stringify({ type: "card", data: { card_id: cardId } })
            }
          }),
          UPDATE_TIMEOUT_MS,
          "卡片消息发送"
        );
        const sendBusinessError = isBusinessError(sent);
        if (sendBusinessError) throw new Error(sendBusinessError);
      } catch (error) {
        if (cardId) removeActiveFeishuCard(cardId);
        recoveryTracked = false;
        log.warn("创建流式卡片失败，回退文本回复", {
          chatId: options.chatId,
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
      // open 期间已积累的事件在这里补发出去
      if (dirty && !closed) {
        await requestFlush(state.status !== "running");
      }
      return true;
    },
    apply: (event) => {
      if (closed) return;
      const previous = state;
      state = reduceImRunCardEvent(state, event);
      if (!cardId) {
        // open 未完成：先标脏，open 成功后统一补发
        dirty = true;
        return;
      }
      const becameTerminal = state.status !== "running" && previous.status === "running";
      // 无变化（含终态后的迟到事件被 reducer 冻结）不触发推送
      if (!becameTerminal && state === previous) {
        return;
      }
      void requestFlush(state.status !== "running");
    },
    get state() {
      return state;
    },
    get degraded() {
      return consecutiveUpdateFailures >= DEGRADED_FAILURE_THRESHOLD;
    },
    close: () => {
      stopTracking(true);
    },
    abortInterrupted: (reason?: string): Promise<void> => {
      if (closed || !cardId) {
        stopTracking(true);
        return Promise.resolve();
      }
      if (state.status === "running") {
        state = {
          ...state,
          status: "interrupted",
          endedAtMs: Date.now(),
          error: reason ?? "sidecar 关停，运行中断"
        };
      }
      return requestFlush(true)
        .catch(() => undefined)
        .finally(() => {
          // 刷新失败时保留恢复条目，供下次启动继续收尾。
          stopTracking(state.status !== "running" && !recoveryTracked);
        });
    }
  };
  activeCardStreams.add(stream);
  return stream;
}

export interface RecoverFeishuRunCardsResult {
  recovered: number;
  failed: number;
  discarded: number;
}

export interface RecoverFeishuRunCardsDeps {
  getClient?: (appId: string, appSecret: string) => FeishuRestClient;
}

let recoveryInFlight: Promise<RecoverFeishuRunCardsResult> | null = null;

/** 强杀/崩溃后的补偿：密钥就位后把上次遗留的 running 卡片改为中断终态。 */
export function recoverInterruptedFeishuRunCards(
  deps: RecoverFeishuRunCardsDeps = {}
): Promise<RecoverFeishuRunCardsResult> {
  if (recoveryInFlight) return recoveryInFlight;
  const run = (async (): Promise<RecoverFeishuRunCardsResult> => {
    const result: RecoverFeishuRunCardsResult = { recovered: 0, failed: 0, discarded: 0 };
    for (const entry of listActiveFeishuCards()) {
      const account = getImAccount(entry.accountId);
      if (!account || account.provider !== "feishu") {
        removeActiveFeishuCard(entry.cardId);
        result.discarded += 1;
        continue;
      }
      try {
        const runtimeAccount = getImRuntimeAccount(entry.accountId);
        const appId = runtimeAccount.accountKey?.trim();
        if (!appId || !runtimeAccount.token) throw new Error("飞书账号缺少凭据");
        const recoveredState: ImRunCardState = entry.state.status === "running"
          ? {
              ...entry.state,
              status: "interrupted",
              endedAtMs: Date.now(),
              error: "上次进程异常退出，运行已中断"
            }
          : entry.state;
        checkpointActiveFeishuCard(entry.cardId, recoveredState);
        const reserved = reserveActiveFeishuCardSequenceBlock(entry.cardId);
        if (!reserved) throw new Error("无法预留卡片更新 sequence");
        const client = (deps.getClient ?? getSharedFeishuClient)(appId, runtimeAccount.token);
        const update = client.cardkit.v1.card.update({
          data: {
            sequence: reserved.sequence,
            card: { type: "card_json", data: JSON.stringify(renderImRunCard(recoveredState)) }
          },
          path: { card_id: entry.cardId }
        });
        let timeout: ReturnType<typeof setTimeout>;
        const response = await Promise.race([
          update,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`卡片恢复更新超时(${UPDATE_TIMEOUT_MS}ms)`)), UPDATE_TIMEOUT_MS);
          })
        ]).finally(() => clearTimeout(timeout));
        const businessError = isBusinessError(response);
        if (businessError) throw new Error(businessError);
        removeActiveFeishuCard(entry.cardId);
        result.recovered += 1;
      } catch (error) {
        result.failed += 1;
        log.warn("遗留飞书卡片收尾失败，保留到下次启动重试", {
          cardId: entry.cardId,
          accountId: entry.accountId,
          chatId: entry.chatId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return result;
  })();
  recoveryInFlight = run.finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}
