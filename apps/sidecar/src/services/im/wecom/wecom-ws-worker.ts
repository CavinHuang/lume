import { WSClient } from "@wecom/aibot-node-sdk";
import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImWorker } from "../provider-registry";
import type { ImRuntimeAccount } from "../im-config-manager";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { registerWecomClient, unregisterWecomClient } from "./wecom-client-pool";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-worker-wecom");

export interface CreateWecomWsWorkerInput {
  account: ImRuntimeAccount;
  routeMessage?: (message: InboundImRouteMessage) => Promise<void> | void;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
  /** 测试注入伪 client;生产省略走默认 WSClient 工厂。 */
  createClient?: (botId: string, secret: string) => WSClient;
}

interface WecomTextBody {
  chatid?: string;
  chattype?: "single" | "group";
  from?: { userid?: string };
  text?: { content?: string };
}

/**
 * 解析企微 message.text 事件帧 → 统一入站路由消息。
 * 帧结构:{ headers: { req_id }, body: { chatid?, chattype, from:{userid}, text:{content} } }。
 */
export function parseWecomEvent(
  frame: unknown,
  account: ImRuntimeAccount,
): InboundImRouteMessage | null {
  const f = frame as { body?: WecomTextBody; headers?: { req_id?: string } } | null | undefined;
  const body = f?.body;
  if (!body) return null;
  const rawText = body.text?.content?.trim();
  if (!rawText) return null;
  // 群聊 @ 门控（#405，启发式同 feishu/dingtalk）
  if (body.chattype === "group" && !rawText.includes("@")) return null;
  // 企微 @ 机器人前缀清理
  const text = rawText.replace(/^@\S+\s*/, "").trim() || rawText;
  return {
    provider: "wecom",
    accountId: account.id,
    accountLabel: account.label,
    workspaceId: account.workspaceId,
    peerKind: body.chattype === "group" ? "group" : "dm",
    // 单聊无 chatid → 以 userid 作为 sendMessage 的会话标识(SDK 文档:单聊填 userid)
    peerId: body.chatid ?? body.from?.userid ?? "unknown",
    senderId: body.from?.userid,
    text,
    messageId: f?.headers?.req_id,
  };
}

function defaultCreateClient(botId: string, secret: string): WSClient {
  return new WSClient({ botId, secret });
}

export function createWecomWsWorker(input: CreateWecomWsWorkerInput): ImWorker {
  const routeMessage = input.routeMessage ?? routeInboundImMessage;
  const botId = input.account.accountKey ?? "";
  const secret = input.account.token ?? "";
  let client: WSClient | null = null;
  let running = false;

  return {
    start() {
      if (running) return;
      if (!botId || !secret) {
        log.error("缺少 Bot ID/Secret,无法启动", { accountId: input.account.id });
        void input.updateAccount?.(input.account.id, {
          status: "auth_required",
          lastError: "缺少 Bot ID/Secret",
        });
        return;
      }
      running = true;
      const wsClient = (input.createClient ?? defaultCreateClient)(botId, secret);
      client = wsClient;
      // 企微出站复用入站长连,启动时把 wsClient 注册进连接池供 sendText 使用
      registerWecomClient(input.account.id, wsClient);
      wsClient.on("message.text", (data) => {
        try {
          const parsed = parseWecomEvent(data, input.account);
          if (parsed) {
            log.info("收到企微消息", { accountId: input.account.id, peerId: parsed.peerId });
            void routeMessage(parsed);
          }
        } catch (error) {
          log.error("处理企微事件出错", {
            accountId: input.account.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      try {
        wsClient.connect();
      } catch (error) {
        log.error("企微 WSClient 启动失败", {
          accountId: input.account.id,
          error: error instanceof Error ? error.message : String(error),
        });
        running = false;
        unregisterWecomClient(input.account.id);
        void input.updateAccount?.(input.account.id, {
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    },
    stop() {
      running = false;
      client?.disconnect();
      unregisterWecomClient(input.account.id);
      client = null;
      log.info("企微 worker 停止", { accountId: input.account.id });
    },
    isRunning() {
      return running;
    },
  };
}
