import type { LumeRuntimeEvent } from "@lume/shared";
import { initialImRunCardState, reduceImRunCardEvent, type ImRunCardState } from "./feishu-card-state";
import { renderImRunCard } from "./feishu-card-renderer";
import { getSharedFeishuClient, type FeishuRestClient } from "./feishu-api";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-feishu-card");

/**
 * 飞书流式卡片会话：一次 agent 运行对应一张可实时更新的卡片。
 *
 * 流程：open() 创建 CardKit 卡片实例并以 interactive 消息发到会话 →
 * 运行事件经 reducer 更新本地状态，节流合并后 card.update 推送（sequence 递增）→
 * 终态事件触发强制刷新并停止后续更新。
 *
 * 所有失败仅记日志降级：卡片通道故障不影响路由与文本兜底回复。
 */

export interface FeishuCardStreamOptions {
  appId: string;
  appSecret: string;
  /** 目标会话 chat_id */
  chatId: string;
  /** 更新节流毫秒数（默认 400ms，最后一个状态胜出） */
  throttleMs?: number;
  /** 测试注入伪 client；生产走共享缓存 client */
  client?: FeishuRestClient;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FeishuCardStream {
  /** 创建卡片实例并发送首条消息；失败返回 false（调用方放弃卡片通道） */
  open(): Promise<boolean>;
  apply(event: LumeRuntimeEvent): void;
  /** 当前状态（测试观察用） */
  readonly state: ImRunCardState;
  close(): void;
}

const UPDATE_RETRY_MAX = 2;
const UPDATE_RETRY_BASE_MS = 200;

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

  const sendCurrent = async (): Promise<void> => {
    if (!cardId || closed) return;
    sending = true;
    try {
      for (let attempt = 0; attempt <= UPDATE_RETRY_MAX; attempt += 1) {
        if (attempt > 0) {
          await new Promise<void>((resolve) => setTimer(() => resolve(), UPDATE_RETRY_BASE_MS * attempt));
        }
        try {
          sequence += 1;
          await client.cardkit.v1.card.update({
            data: {
              card_id: cardId,
              elements: renderImRunCard(state).body.elements,
              sequence
            }
          });
          break;
        } catch (error) {
          // 重试用新 sequence，避免服务端拒绝过期序号；重试耗尽只记日志丢帧
          if (attempt === UPDATE_RETRY_MAX) {
            log.warn("卡片更新失败（已重试）", {
              cardId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    } finally {
      sending = false;
      // 发送期间有新状态落地：运行中回到节流队列，终态立即补发
      if (dirty && !closed && cardId) {
        void requestFlush(state.status !== "running");
      }
    }
  };

  const requestFlush = (immediate: boolean): Promise<void> => {
    dirty = true;
    if (closed || !cardId || sending) return Promise.resolve();
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (!immediate) {
      if (timer === undefined && throttleMs >= 0) {
        timer = setTimer(() => {
          timer = undefined;
          dirty = false;
          void sendCurrent();
        }, throttleMs);
      }
      return Promise.resolve();
    }
    dirty = false;
    return sendCurrent();
  };

  return {
    open: async (): Promise<boolean> => {
      try {
        const rendered = renderImRunCard(state);
        const created = await client.cardkit.v1.card.create({
          data: {
            type: "card_doc",
            elements: rendered.body.elements
          }
        });
        cardId = created.data?.card_id;
        if (!cardId) {
          log.warn("创建卡片未返回 card_id，放弃卡片通道");
          return false;
        }
        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: options.chatId,
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: cardId } })
          }
        });
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
      state = reduceImRunCardEvent(state, event);
      if (!cardId) {
        // open 未完成：先标脏，open 成功后统一补发
        dirty = true;
        return;
      }
      void requestFlush(state.status !== "running");
    },
    get state() {
      return state;
    },
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    }
  };
}
