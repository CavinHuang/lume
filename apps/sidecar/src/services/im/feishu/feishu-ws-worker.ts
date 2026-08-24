import * as lark from "@larksuiteoapi/node-sdk";
import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImWorker } from "../provider-registry";
import type { ImRuntimeAccount } from "../im-config-manager";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-worker-feishu");

/**
 * 飞书 WSClient 结构子类型(测试可注入伪实现)。
 * 字段对齐 @larksuiteoapi/node-sdk:
 * - start({eventDispatcher}) 返回 Promise<void>,WSClient 内部建长连订阅事件;
 * - 停止为 close({force?})(无 stop/disconnect)。
 */
export interface FeishuWsClient {
  start(params: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

export interface CreateFeishuWsWorkerInput {
  account: ImRuntimeAccount;
  routeMessage?: (message: InboundImRouteMessage) => Promise<void>;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
  /** 测试注入伪 client;生产省略走默认 lark.WSClient 工厂。 */
  createClient?: (appId: string, appSecret: string) => FeishuWsClient;
}

interface FeishuMessage {
  chat_id?: string;
  chat_type?: "p2p" | "group";
  message_type?: string;
  content?: string; // JSON 字符串,如 {"text":"@_user_1 hello"}
  message_id?: string;
}

interface FeishuReceiveEventData {
  message?: FeishuMessage;
  sender?: { sender_id?: { open_id?: string; user_id?: string } };
}

/** 清理飞书 @ 用户占位符(如 @_user_1)。 */
function stripFeishuMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 解析飞书 im.message.receive_v1 事件 → 统一入站路由消息。
 * content 为 JSON 字符串 {"text":"..."};@ 占位符需清理。仅处理文本消息。
 */
export function parseFeishuEvent(
  event: unknown,
  account: ImRuntimeAccount,
): InboundImRouteMessage | null {
  const data = event as FeishuReceiveEventData | null | undefined;
  const message = data?.message;
  if (!message) return null;
  if (message.message_type && message.message_type !== "text") return null;
  let rawText = "";
  if (message.content) {
    try {
      rawText = String(JSON.parse(message.content).text ?? "");
    } catch {
      rawText = "";
    }
  }
  // 群聊 @ 门控：绑定群内任何成员的任何文本都触发完整 run 会造成回复风暴。
  // 启发式要求消息带 @ 提及（通常即 @ 机器人）；按 open_id 精确匹配需注入
  // 机器人自身身份，留作升级点（#405）。
  if (message.chat_type !== "p2p" && !/<at[\s>]/.test(rawText)) return null;
  const text = stripFeishuMentions(rawText);
  if (!text) return null;
  return {
    provider: "feishu",
    accountId: account.id,
    accountLabel: account.label,
    workspaceId: account.workspaceId,
    peerKind: message.chat_type === "p2p" ? "dm" : "group",
    peerId: message.chat_id ?? "unknown",
    senderId: data?.sender?.sender_id?.open_id,
    text,
    messageId: message.message_id,
  };
}

function defaultCreateClient(appId: string, appSecret: string): FeishuWsClient {
  return new lark.WSClient({ appId, appSecret });
}

export function createFeishuWsWorker(input: CreateFeishuWsWorkerInput): ImWorker {
  const routeMessage: (message: InboundImRouteMessage) => Promise<void> =
    input.routeMessage ?? (async (m) => {
      await routeInboundImMessage(m);
    });
  const appId = input.account.accountKey ?? "";
  const appSecret = input.account.token ?? "";
  let client: FeishuWsClient | null = null;
  let running = false;

  return {
    start() {
      if (running) return;
      if (!appId || !appSecret) {
        log.error("缺少 App ID/App Secret,无法启动", { accountId: input.account.id });
        void input.updateAccount?.(input.account.id, {
          status: "auth_required",
          lastError: "缺少 App ID/App Secret",
        });
        return;
      }
      running = true;
      const wsClient = (input.createClient ?? defaultCreateClient)(appId, appSecret);
      client = wsClient;
      const dispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data) => {
          try {
            const parsed = parseFeishuEvent(data, input.account);
            if (parsed) {
              log.info("收到飞书消息", { accountId: input.account.id, peerId: parsed.peerId });
              void routeMessage(parsed).catch((error: unknown) => {
                log.error("飞书入站路由失败", {
                  accountId: input.account.id,
                  error: error instanceof Error ? error.message : String(error)
                });
              });
            }
          } catch (error) {
            log.error("处理飞书事件出错", {
              accountId: input.account.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      void wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
        log.error("飞书 WSClient 启动失败", {
          accountId: input.account.id,
          error: error instanceof Error ? error.message : String(error),
        });
        running = false;
        void input.updateAccount?.(input.account.id, {
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
      });
    },
    stop() {
      running = false;
      client?.close();
      client = null;
      log.info("飞书 worker 停止", { accountId: input.account.id });
    },
    isRunning() {
      return running;
    },
  };
}
