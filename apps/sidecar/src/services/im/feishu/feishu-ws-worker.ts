import * as lark from "@larksuiteoapi/node-sdk";
import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImWorker } from "../provider-registry";
import type { ImRuntimeAccount } from "../im-config-manager";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { getFeishuBotOpenId, getFeishuChatUserCount } from "./feishu-api";
import { resolveImGroupAccess } from "../im-group-policy";
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
  /** 群准入增强注入（测试）；生产走 REST API 缓存实现 */
  getBotOpenId?: (input: { appId: string; appSecret: string }) => Promise<string | null>;
  getChatUserCount?: (input: { appId: string; appSecret: string; chatId: string }) => Promise<number | null>;
}

interface FeishuMessage {
  chat_id?: string;
  chat_type?: "p2p" | "group";
  message_type?: string;
  content?: string; // JSON 字符串,如 {"text":"@_user_1 hello"}
  message_id?: string;
  parent_id?: string;
  mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
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
 *
 * 群聊准入不在 parse 内硬拒：这里只提取提及线索（mentions open_id、
 * 是否含 @ 标记），由 worker 结合机器人身份做精确判定（#405）。
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
  const hasMentionMarkup = /<at[\s>]/.test(rawText);
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
    ...(message.parent_id ? { parentMessageId: message.parent_id } : {}),
    ...(Array.isArray(message.mentions) && message.mentions.length > 0
      ? {
          mentions: message.mentions.map((mention) => ({
            ...(mention.key ? { key: mention.key } : {}),
            ...(mention.id?.open_id ? { openId: mention.id.open_id } : {}),
            ...(mention.name ? { name: mention.name } : {})
          }))
        }
      : {}),
    hasMentionMarkup
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
  const getBotOpenId = input.getBotOpenId ?? getFeishuBotOpenId;
  const getChatUserCount = input.getChatUserCount ?? getFeishuChatUserCount;
  const appId = input.account.accountKey ?? "";
  const appSecret = input.account.token ?? "";
  let client: FeishuWsClient | null = null;
  let running = false;

  // 机器人身份进程内缓存：失败不缓存（下条消息重试），成功后恒定
  let botOpenIdPromise: Promise<string | null> | null = null;
  const ensureBotOpenId = (): Promise<string | null> => {
    if (!botOpenIdPromise) {
      botOpenIdPromise = getBotOpenId({ appId, appSecret });
    }
    return botOpenIdPromise;
  };

  /**
   * 群聊准入精确判定（#405）：open_id 匹配 @ 机器人；单人群免 @；
   * 身份不可得退回 @ 标记启发式。
   */
  async function gateGroupAccess(parsed: InboundImRouteMessage): Promise<InboundImRouteMessage | null> {
    if (parsed.peerKind !== "group") return parsed;
    const botOpenId = await ensureBotOpenId();
    const botMentioned =
      botOpenId === null
        ? null
        : (parsed.mentions ?? []).some((mention) => mention.openId === botOpenId);
    const chatUserCount = await getChatUserCount({ appId, appSecret, chatId: parsed.peerId });
    const access = resolveImGroupAccess({
      hasMentionMarkup: parsed.hasMentionMarkup ?? false,
      botMentioned,
      chatUserCount
    });
    if (!access.accepted) {
      log.info("群消息未触发机器人，忽略", {
        accountId: input.account.id,
        peerId: parsed.peerId,
        reason: access.reason
      });
      return null;
    }
    return parsed;
  }

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
              // 单聊无门控保持同步派发；群聊经异步精确判定后路由
              const routed = parsed.peerKind === "dm"
                ? routeMessage(parsed)
                : gateGroupAccess(parsed).then((gated) => (gated ? routeMessage(gated) : undefined));
              void routed.catch((error: unknown) => {
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
