import type { ImThreadBinding } from "@lume/shared";
import { getImRuntimeAccount } from "./im-config-manager";
import { getImProvider } from "./provider-registry";

export interface SendBoundImTextMessageInput {
  binding: ImThreadBinding;
  text: string;
}

export async function sendBoundImTextMessage(input: SendBoundImTextMessageInput): Promise<{ ok: true }> {
  const def = getImProvider(input.binding.provider);
  const account = getImRuntimeAccount(input.binding.accountId);
  const result = await def.sendText({
    account,
    peerId: input.binding.peerId,
    peerKind: input.binding.peerKind,
    text: input.text,
    contextToken: input.binding.contextToken,
  });
  if (!result.ok) throw new Error(result.error ?? "发送失败");
  return { ok: true };
}

export interface SendBoundImMediaInput {
  binding: ImThreadBinding;
  mediaType: "image" | "video" | "file";
  fileData: Buffer;
  fileName: string;
  caption?: string;
}

export async function sendBoundImMediaMessage(input: SendBoundImMediaInput): Promise<{ ok: true }> {
  const def = getImProvider(input.binding.provider);
  if (!def.sendMedia) {
    throw new Error(`${input.binding.provider} 渠道暂不支持发送媒体`);
  }
  const account = getImRuntimeAccount(input.binding.accountId);
  const result = await def.sendMedia({
    account,
    peerId: input.binding.peerId,
    peerKind: input.binding.peerKind,
    contextToken: input.binding.contextToken,
    mediaType: input.mediaType,
    fileData: input.fileData,
    fileName: input.fileName,
    caption: input.caption,
  });
  if (!result.ok) throw new Error(result.error ?? "发送失败");
  return { ok: true };
}
