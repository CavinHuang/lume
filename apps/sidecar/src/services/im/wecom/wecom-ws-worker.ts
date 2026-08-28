import { WSClient } from "@wecom/aibot-node-sdk";
import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImWorker } from "../provider-registry";
import type { ImRuntimeAccount } from "../im-config-manager";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { getImMirrorEntryByChat } from "../im-mirror-store";
import { registerWecomClient, unregisterWecomClient } from "./wecom-client-pool";
import { redactSensitiveText } from "../im-log-redaction";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-worker-wecom");

export interface CreateWecomWsWorkerInput {
  account: ImRuntimeAccount;
  routeMessage?: (message: InboundImRouteMessage) => Promise<void>;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
  /** 测试注入伪 client;生产省略走默认 WSClient 工厂。 */
  createClient?: (botId: string, secret: string) => WSClient;
  /** 断线判死宽限毫秒数（默认 60s，SDK 重连预算内自愈则恢复） */
  disconnectGraceMs?: number;
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
  /** #544 镜像群谓词：命中即免 @ 放行（无公共上游，各 worker 各自插桩） */
  isMirrorChat?: (peerId: string) => boolean,
): InboundImRouteMessage | null {
  const f = frame as { body?: WecomTextBody; headers?: { req_id?: string } } | null | undefined;
  const body = f?.body;
  if (!body) return null;
  const rawText = body.text?.content?.trim();
  if (!rawText) return null;
  const peerId = body.chatid ?? body.from?.userid ?? "unknown";
  // 群聊 @ 门控（#405）；#598 词边界收紧：企微平台无结构化 at 字段，@ 须位于
  // 文本开头或空白后，"a@b.com" 这类内嵌 @ 不算 at；镜像群豁免（#544）
  if (
    body.chattype === "group" &&
    !/(^|\s)@\S/.test(rawText) &&
    !(isMirrorChat?.(peerId) ?? false)
  ) {
    return null;
  }
  // 企微 @ 机器人前缀清理
  const text = rawText.replace(/^@\S+\s*/, "").trim() || rawText;
  return {
    provider: "wecom",
    accountId: account.id,
    accountLabel: account.label,
    workspaceId: account.workspaceId,
    peerKind: body.chattype === "group" ? "group" : "dm",
    // 单聊无 chatid → 以 userid 作为 sendMessage 的会话标识(SDK 文档:单聊填 userid)
    peerId,
    senderId: body.from?.userid,
    text,
    messageId: f?.headers?.req_id,
  };
}

function defaultCreateClient(botId: string, secret: string): WSClient {
  return new WSClient({ botId, secret });
}

export function createWecomWsWorker(input: CreateWecomWsWorkerInput): ImWorker {
  const routeMessage: (message: InboundImRouteMessage) => Promise<void> =
    input.routeMessage ?? (async (m) => {
      await routeInboundImMessage(m);
    });
  const botId = input.account.accountKey ?? "";
  const secret = input.account.token ?? "";
  const disconnectGraceMs = input.disconnectGraceMs ?? 60_000;
  let client: WSClient | null = null;
  let running = false;
  // 代际令牌：stop→start 快速切换后，旧 client 迟到的异步事件不得影响新会话
  let generation = 0;

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
      generation += 1;
      const gen = generation;
      let deathTimer: unknown;
      let degraded = false;

      const clearDeathTimer = () => {
        if (deathTimer !== undefined) {
          clearTimeout(deathTimer as ReturnType<typeof setTimeout>);
          deathTimer = undefined;
        }
      };
      // 断线宽限窗口：disconnected/error 在瞬断时也会发（SDK 会自动重连），
      // 不能见断即判死；窗口内 connected/authenticated 到来则恢复，超窗判死
      const markConnectionLost = () => {
        if (gen !== generation || !running || deathTimer !== undefined) return;
        degraded = true;
        deathTimer = setTimeout(() => {
          deathTimer = undefined;
          if (gen !== generation || !running) return;
          running = false;
          unregisterWecomClient(input.account.id);
          log.error("企微长连接断开且未恢复，账号转入 error 态", { accountId: input.account.id });
          void input.updateAccount?.(input.account.id, {
            status: "error",
            lastError: "长连接断开且重连未恢复",
          });
        }, disconnectGraceMs);
      };
      const markConnectionAlive = () => {
        if (gen !== generation || !running) return;
        clearDeathTimer();
        if (degraded) {
          degraded = false;
          log.info("企微长连接已恢复", { accountId: input.account.id });
        }
      };

      const wsClient = (input.createClient ?? defaultCreateClient)(botId, secret);
      client = wsClient;
      // 企微出站复用入站长连,启动时把 wsClient 注册进连接池供 sendText 使用
      registerWecomClient(input.account.id, wsClient);
      wsClient.on("message.text", (data) => {
        try {
          const parsed = parseWecomEvent(
            data,
            input.account,
            (peerId) => getImMirrorEntryByChat(input.account.id, peerId) !== null
          );
          if (parsed) {
            log.info("收到企微消息", { accountId: input.account.id, peerId: parsed.peerId });
            void routeMessage(parsed).catch((error: unknown) => {
              log.error("企微入站路由失败", {
                accountId: input.account.id,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
        } catch (error) {
          log.error("处理企微事件出错", {
            accountId: input.account.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      // eventemitter3 对无监听的 "error" 不抛异常——不挂监听会永久假活：
      // running 仍 true、UI 显示运行中、入站永不再来
      wsClient.on("error", () => markConnectionLost());
      wsClient.on("disconnected", () => markConnectionLost());
      wsClient.on("connected", () => markConnectionAlive());
      wsClient.on("authenticated", () => markConnectionAlive());
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
          lastError: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        });
      }
    },
    stop() {
      // 代际递增使旧 client 迟到的异步事件（断开/错误回调）失效
      generation += 1;
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
