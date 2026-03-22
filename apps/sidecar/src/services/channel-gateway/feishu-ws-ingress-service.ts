/**
 * 飞书 WebSocket 长连接 Ingress 服务
 *
 * 使用 @larksuiteoapi/node-sdk 的 WSClient 与飞书开放平台建立 WebSocket 全双工通道，
 * 自动接收事件推送，无需公网 IP 或内网穿透。
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelGatewayIngressStatus, ChannelInboundEvent } from "@lume/shared";
import { getFeishuGatewayConfig } from "./feishu-config-manager";
import { parsePostContent, parseTextContent } from "./feishu-message-parser";
import { simulateChannelGatewayIngress } from "./gateway-service";

let wsClient: Lark.WSClient | null = null;
let connected = false;

export function getFeishuWsIngressStatus(): ChannelGatewayIngressStatus {
  return {
    running: Boolean(wsClient),
    connectionMode: "websocket",
    port: null,
    webhookPath: "",
    webhookUrl: null,
    wsConnected: connected
  };
}

export async function startFeishuWsIngressServer(): Promise<ChannelGatewayIngressStatus> {
  if (wsClient) return getFeishuWsIngressStatus();

  const config = getFeishuGatewayConfig();
  if (!config.appId.trim() || !config.appSecret.trim()) {
    throw new Error("飞书 appId/appSecret 未配置，无法启动 WebSocket 长连接");
  }

  const domain = config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      try {
        const message = data.message as
          | { chat_id?: string; message_id?: string; message_type?: string; content?: string; parent_id?: string }
          | undefined;
        const sender = data.sender as
          | { sender_id?: { open_id?: string; user_id?: string; union_id?: string } }
          | undefined;

        if (!message?.chat_id || !message?.message_id) return;

        let text = "";
        if (message.message_type === "text") {
          text = parseTextContent(message.content);
        } else if (message.message_type === "post") {
          text = parsePostContent(message.content);
        } else {
          return;
        }
        if (!text) return;

        const event: ChannelInboundEvent = {
          id: (data.event_id as string) || message.message_id,
          provider: "feishu",
          externalChatId: message.chat_id,
          externalUserId:
            sender?.sender_id?.open_id
            || sender?.sender_id?.user_id
            || sender?.sender_id?.union_id
            || undefined,
          externalMessageId: message.message_id,
          text,
          receivedAt: Date.now(),
          metadata: {
            eventType: "im.message.receive_v1",
            messageType: message.message_type,
            ...(message.parent_id ? { parentMessageId: message.parent_id } : {})
          }
        };

        if (config.defaultWorkspaceId) {
          event.workspaceId = config.defaultWorkspaceId;
        }

        // fire-and-forget: 飞书 WebSocket 要求 3 秒内返回，实际处理异步进行
        void simulateChannelGatewayIngress({ event }).catch((error) => {
          console.error("[渠道网关] WebSocket 事件处理失败:", error);
        });
      } catch (error) {
        console.error("[渠道网关] WebSocket 消息解析失败:", error);
      }
    }
  });

  wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info
  });

  await wsClient.start({ eventDispatcher });
  connected = true;

  return getFeishuWsIngressStatus();
}

export async function stopFeishuWsIngressServer(): Promise<void> {
  if (!wsClient) return;
  // SDK 无显式 close 方法，通过置空引用让 GC 回收连接
  wsClient = null;
  connected = false;
}
