import type { ImProviderDefinition } from "../provider-registry";
import { registerImProvider } from "../provider-registry";
import { createWecomWsWorker } from "./wecom-ws-worker";
import { getWecomClient } from "./wecom-client-pool";

/**
 * 企业微信 IM provider:
 * - createWorker: WebSocket 长连接入站(AI 机器人 message.text → routeInboundImMessage),
 *   worker 启动时把 wsClient 注册进连接池。
 * - sendText: 出站**复用入站长连 wsClient**(SDK 无 REST 出站),从连接池按 accountId 取出;
 *   sendMessage 无纯文本体 → 用 markdown 体裁剪文本。
 * - sendMedia: 暂不支持(SendMediaMsgBody 需先 uploadMedia 三步分片上传,后续按需扩展)。
 */
export const wecomProvider: ImProviderDefinition = {
  provider: "wecom",
  createWorker: (account, deps) =>
    createWecomWsWorker({
      account,
      routeMessage: deps?.routeMessage,
      updateAccount: deps?.updateAccount,
    }),
  sendText: async (input) => {
    const wsClient = getWecomClient(input.account.id);
    if (!wsClient) {
      return { ok: false, error: "企业微信长连接未建立(worker 未运行或已停止),无法回复" };
    }
    try {
      await wsClient.sendMessage(input.peerId, {
        msgtype: "markdown",
        markdown: { content: input.text },
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerImProvider(wecomProvider);
