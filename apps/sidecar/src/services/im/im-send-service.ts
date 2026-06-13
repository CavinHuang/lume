import type { ImThreadBinding } from "@lume/shared";
import { getImRuntimeAccount } from "./im-config-manager";
import { createOpenClawWeixinApi } from "./weixin/openclaw-weixin-api";
import { uploadMediaToWeixinCdn } from "./weixin/openclaw-weixin-cdn";

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

  return { ok: true };
}
