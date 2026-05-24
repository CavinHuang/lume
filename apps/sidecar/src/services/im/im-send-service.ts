import type { ImThreadBinding } from "@lume/shared";
import { getImRuntimeAccount } from "./im-config-manager";
import { createOpenClawWeixinApi } from "./weixin/openclaw-weixin-api";

export interface SendBoundImTextMessageInput {
  binding: ImThreadBinding;
  text: string;
}

export async function sendBoundImTextMessage(input: SendBoundImTextMessageInput): Promise<{ ok: true }> {
  if (input.binding.provider !== "weixin") {
    throw new Error(`暂不支持的 IM 平台: ${input.binding.provider}`);
  }
  const account = getImRuntimeAccount(input.binding.accountId);
  const api = createOpenClawWeixinApi({
    baseUrl: account.baseUrl,
    token: account.token,
    uin: account.uin
  });
  await api.sendText({
    peerId: input.binding.peerId,
    peerKind: input.binding.peerKind,
    text: input.text,
    contextToken: input.binding.contextToken
  });
  return { ok: true };
}
