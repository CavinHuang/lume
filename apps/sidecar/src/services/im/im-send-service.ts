import type { ImThreadBinding } from "@lume/shared";
import { getImRuntimeAccount } from "./im-config-manager";
import { createOpenClawWeixinApi } from "./weixin/openclaw-weixin-api";
import { uploadMediaToWeixinCdn } from "./weixin/openclaw-weixin-cdn";
import { createLogger } from "../infra/logger";

const log = createLogger("im-send");

export interface SendBoundImTextMessageInput {
  binding: ImThreadBinding;
  text: string;
}

export async function sendBoundImTextMessage(input: SendBoundImTextMessageInput): Promise<{ ok: true }> {
  if (input.binding.provider !== "weixin") {
    throw new Error(`暂不支持的 IM 平台: ${input.binding.provider}`);
  }
  log.info("发送文本消息", { accountId: input.binding.accountId, peerId: input.binding.peerId, peerKind: input.binding.peerKind, textLength: input.text.length });
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
  log.info("文本消息发送完成", { accountId: input.binding.accountId, peerId: input.binding.peerId });
  return { ok: true };
}

export interface SendBoundImMediaInput {
  binding: ImThreadBinding;
  mediaType: "image" | "video" | "file";
  fileData: Buffer;
  fileName: string;
  caption?: string;
}

const MEDIA_TYPE_TO_UPLOAD_TYPE = {
  image: 1,
  video: 2,
  file: 3,
} as const;

export async function sendBoundImMediaMessage(input: SendBoundImMediaInput): Promise<{ ok: true }> {
  if (input.binding.provider !== "weixin") {
    throw new Error(`暂不支持的 IM 平台: ${input.binding.provider}`);
  }

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
  if (input.fileData.length > MAX_FILE_SIZE) {
    throw new Error(`文件过大 (${Math.round(input.fileData.length / 1024 / 1024)}MB)，微信限制 25MB`);
  }

  log.info("发送媒体消息", { accountId: input.binding.accountId, peerId: input.binding.peerId, peerKind: input.binding.peerKind, mediaType: input.mediaType, fileSize: input.fileData.length, fileName: input.fileName });

  const account = getImRuntimeAccount(input.binding.accountId);
  const api = createOpenClawWeixinApi({
    baseUrl: account.baseUrl,
    token: account.token,
    uin: account.uin,
  });

  const uploaded = await uploadMediaToWeixinCdn({
    fileData: input.fileData,
    mediaType: MEDIA_TYPE_TO_UPLOAD_TYPE[input.mediaType],
    toUserId: input.binding.peerId,
    account: { baseUrl: account.baseUrl, token: account.token, uin: account.uin },
  });

  log.debug("媒体上传完成，开始发送", { mediaType: input.mediaType, filekey: uploaded.filekey.slice(0, 8) });

  const sendParams = {
    peerId: input.binding.peerId,
    peerKind: input.binding.peerKind,
    uploaded,
    caption: input.caption,
    contextToken: input.binding.contextToken,
  };

  switch (input.mediaType) {
    case "image":
      await api.sendImage!(sendParams);
      break;
    case "video":
      await api.sendVideo!(sendParams);
      break;
    case "file":
      await api.sendFile!({ ...sendParams, fileName: input.fileName });
      break;
  }

  log.info("媒体消息发送完成", { accountId: input.binding.accountId, peerId: input.binding.peerId, mediaType: input.mediaType });
  return { ok: true };
}
