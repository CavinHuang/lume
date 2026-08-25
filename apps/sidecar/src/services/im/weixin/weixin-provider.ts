import type {
  ImProviderDefinition,
  ImSendInput,
  ImSendMediaInput,
  ImSendResult,
  ImCreateWorkerDeps,
} from "../provider-registry";
import { registerImProvider } from "../provider-registry";
import { createOpenClawWeixinWorker } from "./openclaw-weixin-worker";
import { createOpenClawWeixinApi } from "./openclaw-weixin-api";
import { uploadMediaToWeixinCdn } from "./openclaw-weixin-cdn";
import { createLogger } from "../../infra/logger";

const log = createLogger("im:weixin-provider");

const MEDIA_TYPE_TO_UPLOAD_TYPE = {
  image: 1,
  video: 2,
  file: 3,
} as const;

// 从 im-send-service.ts 的 sendBoundImTextMessage 搬运，行为保持不变；
// 仅改为返回 ImSendResult，由 send-service 统一转换为 throw。
async function sendText(input: ImSendInput): Promise<ImSendResult> {
  try {
    log.info("发送文本消息", { peerId: input.peerId, peerKind: input.peerKind, textLength: input.text.length });
    const api = createOpenClawWeixinApi({
      baseUrl: input.account.baseUrl,
      token: input.account.token,
      uin: input.account.uin,
    });
    await api.sendText({
      peerId: input.peerId,
      peerKind: input.peerKind,
      text: input.text,
      contextToken: input.contextToken,
    });
    log.info("文本消息发送完成", { peerId: input.peerId });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 从 im-send-service.ts 的 sendBoundImMediaMessage 搬运，行为保持不变；
// media kind 分发（uploadMediaToWeixinCdn + api.sendImage/sendVideo/sendFile）原样保留。
async function sendMedia(input: ImSendMediaInput): Promise<ImSendResult> {
  try {
    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
    if (input.fileData.length > MAX_FILE_SIZE) {
      return { ok: false, error: `文件过大 (${Math.round(input.fileData.length / 1024 / 1024)}MB)，微信限制 25MB` };
    }

    log.info("发送媒体消息", { peerId: input.peerId, peerKind: input.peerKind, mediaType: input.mediaType, fileSize: input.fileData.length, fileName: input.fileName });

    const api = createOpenClawWeixinApi({
      baseUrl: input.account.baseUrl,
      token: input.account.token,
      uin: input.account.uin,
    });

    const uploaded = await uploadMediaToWeixinCdn({
      fileData: input.fileData,
      mediaType: MEDIA_TYPE_TO_UPLOAD_TYPE[input.mediaType],
      toUserId: input.peerId,
      account: { baseUrl: input.account.baseUrl, token: input.account.token, uin: input.account.uin },
    });

    log.debug("媒体上传完成，开始发送", { mediaType: input.mediaType, filekey: uploaded.filekey.slice(0, 8) });

    const sendParams = {
      peerId: input.peerId,
      peerKind: input.peerKind,
      uploaded,
      caption: input.caption,
      contextToken: input.contextToken,
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

    log.info("媒体消息发送完成", { peerId: input.peerId, mediaType: input.mediaType });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const weixinProvider: ImProviderDefinition = {
  provider: "weixin",
  createWorker: (account, deps?: ImCreateWorkerDeps) =>
    createOpenClawWeixinWorker({
      account,
      routeMessage: deps?.routeMessage,
      updateAccount: deps?.updateAccount,
    }),
  sendText,
  sendMedia,
};

// 模块加载即注册：由 im-runtime-manager.ts 顶部 import 触发，
// 早于 sidecar 的 startEnabledAccounts()，确保 worker 首次创建时 weixin 已在注册表。
registerImProvider(weixinProvider);
