import type { ImProviderDefinition } from "../provider-registry";
import { registerImProvider } from "../provider-registry";
import { createDingtalkStreamWorker } from "./dingtalk-stream-worker";
import { sendDingtalkText } from "./dingtalk-api";

/**
 * 钉钉 IM provider:
 * - createWorker: Stream 长连接入站(机器人消息 → routeInboundImMessage)
 * - sendText: 出站回复 POST sessionWebhook(入站存为 contextToken)
 * - sendMedia: 暂不支持(sessionWebhook 可发 markdown/link,后续按需扩展)
 */
export const dingtalkProvider: ImProviderDefinition = {
  provider: "dingtalk",
  createWorker: (account, deps) =>
    createDingtalkStreamWorker({
      account,
      routeMessage: deps?.routeMessage,
      updateAccount: deps?.updateAccount,
    }),
  sendText: async (input) => sendDingtalkText({ text: input.text, contextToken: input.contextToken }),
};

registerImProvider(dingtalkProvider);
