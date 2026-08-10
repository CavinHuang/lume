import type { ImProviderDefinition } from "../provider-registry";
import { registerImProvider } from "../provider-registry";
import { createFeishuWsWorker } from "./feishu-ws-worker";
import { sendFeishuText } from "./feishu-api";

/**
 * 飞书 IM provider:
 * - createWorker: WSClient 长连接入站(im.message.receive_v1 → routeInboundImMessage)。
 * - sendText: 出站走 REST client.im.v1.message.create(receive_id=chat_id),与入站 WSClient 分离;
 *   凭据(accountKey=appId,token=appSecret)按 appId 缓存 Client。
 * - contextToken: 飞书出站不需会话级 token(用 app 凭据换 tenant_access_token),忽略。
 */
export const feishuProvider: ImProviderDefinition = {
  provider: "feishu",
  createWorker: (account, deps) =>
    createFeishuWsWorker({
      account,
      routeMessage: deps?.routeMessage,
      updateAccount: deps?.updateAccount,
    }),
  sendText: async (input) =>
    sendFeishuText({
      appId: input.account.accountKey ?? "",
      appSecret: input.account.token ?? "",
      peerId: input.peerId,
      text: input.text,
    }),
};

registerImProvider(feishuProvider);
