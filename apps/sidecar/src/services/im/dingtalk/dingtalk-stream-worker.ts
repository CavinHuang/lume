import { DWClient, EventAck, type DWClientDownStream, type EventAckData } from "dingtalk-stream";
import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImWorker } from "../provider-registry";
import type { ImRuntimeAccount } from "../im-config-manager";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { redactSensitiveText } from "../im-log-redaction";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-worker-dingtalk");

/**
 * 钉钉 Stream 客户端结构子类型(测试可注入伪实现)。
 * 字段对齐 dingtalk-stream SDK 实测:
 * - registerAllEventListener 回调**同步**返回 EventAckData(非 async Promise);
 * - 启动为 connect()(无 start),停止为 disconnect()(无 stop/close)。
 */
export interface DingtalkStreamClient {
  registerAllEventListener(handler: (event: DWClientDownStream) => EventAckData): void;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface CreateDingtalkStreamWorkerInput {
  account: ImRuntimeAccount;
  routeMessage?: (message: InboundImRouteMessage) => Promise<void>;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
  /** 测试注入伪 client;生产省略走默认 DWClient 工厂。 */
  createClient?: (clientId: string, clientSecret: string) => DingtalkStreamClient;
}

interface DingtalkImEventData {
  conversationId?: string;
  conversationType?: string; // "1" 单聊 / "2" 群
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  text?: { content?: string };
  sessionWebhook?: string;
  msgId?: string;
  conversationName?: string;
}

/**
 * 提取事件 data 字段。SDK 实测 DWClientDownStream.data 为 JSON **字符串**;
 * 测试可传 object,此处两者兼容。
 */
function extractEventData(event: unknown): DingtalkImEventData | null {
  const raw = (event as { data?: unknown })?.data;
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as DingtalkImEventData) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as DingtalkImEventData;
  return null;
}

/** 解析钉钉 Stream IM 事件 → 统一入站路由消息。 */
export function parseDingtalkEvent(
  event: unknown,
  account: ImRuntimeAccount,
): InboundImRouteMessage | null {
  const data = extractEventData(event);
  if (!data) return null;
  const rawText = data.text?.content?.trim();
  if (!rawText) return null;
  // 群聊 @ 门控（#405，启发式同 feishu/wecom）
  if (data.conversationType !== "1" && !rawText.includes("@")) return null;
  // 钉钉机器人文案常带 @机器人 前缀,简单清理
  const text = rawText.replace(/^@\S+\s*/, "").trim() || rawText;
  return {
    provider: "dingtalk",
    accountId: account.id,
    accountLabel: account.label,
    workspaceId: account.workspaceId,
    peerKind: data.conversationType === "1" ? "dm" : "group",
    peerId: data.conversationId ?? data.senderStaffId ?? "unknown",
    peerName: data.conversationName ?? data.senderNick,
    senderId: data.senderStaffId ?? data.senderId,
    text,
    contextToken: data.sessionWebhook, // 出站回复用(存入 thread binding)
    messageId: data.msgId,
  };
}

function defaultCreateClient(clientId: string, clientSecret: string): DingtalkStreamClient {
  return new DWClient({ clientId, clientSecret });
}

export function createDingtalkStreamWorker(input: CreateDingtalkStreamWorkerInput): ImWorker {
  const routeMessage: (message: InboundImRouteMessage) => Promise<void> =
    input.routeMessage ?? (async (m) => {
      await routeInboundImMessage(m);
    });
  const clientId = input.account.accountKey ?? "";
  const clientSecret = input.account.token ?? "";
  let client: DingtalkStreamClient | null = null;
  let running = false;

  return {
    start() {
      if (running) return;
      if (!clientId || !clientSecret) {
        log.error("缺少 ClientId/ClientSecret,无法启动", { accountId: input.account.id });
        void input.updateAccount?.(input.account.id, { status: "auth_required", lastError: "缺少 ClientId/ClientSecret" });
        return;
      }
      running = true;
      const streamClient = (input.createClient ?? defaultCreateClient)(clientId, clientSecret);
      client = streamClient;
      // SDK 回调签名同步返回 EventAckData;异步路由 fire-and-forget,立即 ack 避免服务端 60s 重试
      streamClient.registerAllEventListener((event) => {
        try {
          const parsed = parseDingtalkEvent(event, input.account);
          if (parsed) {
            log.info("收到钉钉消息", { accountId: input.account.id, peerId: parsed.peerId });
            void routeMessage(parsed).catch((error: unknown) => {
              log.error("钉钉入站路由失败", {
                accountId: input.account.id,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
        } catch (error) {
          log.error("处理钉钉事件出错", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
        }
        return { status: EventAck.SUCCESS };
      });
      void streamClient.connect().catch((error) => {
        log.error("DWClient 启动失败", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
        running = false;
        void input.updateAccount?.(input.account.id, { status: "error", lastError: redactSensitiveText(error instanceof Error ? error.message : String(error)) });
      });
    },
    stop() {
      running = false;
      client?.disconnect();
      client = null;
      log.info("钉钉 worker 停止", { accountId: input.account.id });
    },
    isRunning() {
      return running;
    },
  };
}
