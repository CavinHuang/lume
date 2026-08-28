import type { LumeRuntimeEvent } from "@lume/shared";
import { initialImRunCardState, reduceImRunCardEvent, type ImRunCardState } from "./feishu-card-state";
import { renderImRunCard } from "./feishu-card-renderer";
import { getSharedFeishuClient, type FeishuRestClient } from "./feishu-api";
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
 * 已知限制：进程崩溃/强杀时未完成运行的卡片会停留在「正在处理」状态，
 * 客户端无法收尾（需平台侧超时或用户 /stop 后新运行覆盖）。
 */

export interface FeishuCardStreamOptions {
  appId: string;
  appSecret: string;
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
  let closed = false;
  let sending = false;
  let dirty = false;
  let timer: unknown;
  // 连续整轮推送失败次数：达到阈值判定通道降级，调用方应回退文本投递
  let consecutiveUpdateFailures = 0;
  const DEGRADED_FAILURE_THRESHOLD = 3;
  let terminalFallbackNotified = false;

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
    for (let attempt = 0; attempt <= UPDATE_RETRY_MAX; attempt += 1) {
      if (closed) return false;
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimer(() => resolve(), UPDATE_RETRY_BASE_MS * attempt));
        if (closed) return false;
      }
      try {
        sequence += 1;
        const result = await withTimeout(
          client.cardkit.v1.card.update({
            data: {
              sequence,
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
        await withTimeout(
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
      } catch (error) {
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
      closed = true;
      activeCardStreams.delete(stream);
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    abortInterrupted: (reason?: string): Promise<void> => {
      if (closed || !cardId) {
        closed = true;
        activeCardStreams.delete(stream);
        return Promise.resolve();
      }
      state = {
        ...state,
        status: "interrupted",
        endedAtMs: Date.now(),
        error: reason ?? "sidecar 关停，运行中断"
      };
      return requestFlush(true)
        .catch(() => undefined)
        .finally(() => {
          closed = true;
          activeCardStreams.delete(stream);
          if (timer !== undefined) {
            clearTimer(timer);
            timer = undefined;
          }
        });
    }
  };
  activeCardStreams.add(stream);
  return stream;
}
