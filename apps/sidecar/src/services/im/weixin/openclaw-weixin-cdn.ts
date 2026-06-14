import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { OpenClawWeixinAccountAuth } from "./openclaw-weixin-api";
import type { WeixinUploadedMedia, WeixinUploadMediaTypeValue } from "./openclaw-weixin-media-types";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-cdn");

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** AES-128-ECB with PKCS7 padding — matches Tencent OpenClaw CDN encryption. */
export function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const padLen = 16 - (plaintext.length % 16);
  const padded = Buffer.alloc(plaintext.length + padLen, padLen);
  plaintext.copy(padded);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/** Ciphertext size for a given plaintext size (AES-128-ECB with PKCS7 padding). */
export function aesEcbPaddedSize(rawSize: number): number {
  const remainder = rawSize % 16;
  return rawSize + (16 - remainder);
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const json = await response.json();
    return json && typeof json === "object" && !Array.isArray(json)
      ? json as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildHeaders(account: OpenClawWeixinAccountAuth): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${account.token}`,
  };
}

const MEDIA_TYPE_LABELS: Record<number, string> = {
  1: "image",
  2: "video",
  3: "file",
  4: "voice",
};

export async function uploadMediaToWeixinCdn(input: {
  fileData: Buffer;
  mediaType: WeixinUploadMediaTypeValue;
  toUserId: string;
  account: OpenClawWeixinAccountAuth;
  fetchImpl?: FetchLike;
}): Promise<WeixinUploadedMedia> {
  const fetchFn = input.fetchImpl ?? fetch;
  const { fileData, mediaType, toUserId, account } = input;

  const rawsize = fileData.length;
  const rawfilemd5 = createHash("md5").update(fileData).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);
  const label = MEDIA_TYPE_LABELS[mediaType] ?? String(mediaType);

  log.info("开始上传媒体", { mediaType: label, toUserId, rawSize: rawsize, encSize: filesize, filekeyPrefix: filekey.slice(0, 8) });

  // 1. Get upload URL
  const baseUrl = account.baseUrl.replace(/\/+$/, "");
  log.debug("请求上传地址", { baseUrl });
  const uploadUrlResp = await fetchFn(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: "POST",
    headers: buildHeaders(account),
    body: JSON.stringify({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    }),
  });
  const uploadUrlPayload = await readPayload(uploadUrlResp);
  const uploadFullUrl = asString(uploadUrlPayload.upload_full_url);
  const uploadParam = asString(uploadUrlPayload.upload_param);

  if (!uploadFullUrl && !uploadParam) {
    log.error("获取上传地址失败", { status: uploadUrlResp.status, body: uploadUrlPayload });
    throw new Error("getuploadurl returned no upload URL");
  }
  log.info("获取上传地址成功", { hasUploadFullUrl: !!uploadFullUrl, hasUploadParam: !!uploadParam });

  // 2. Encrypt file
  const encrypted = aesEcbEncrypt(fileData, aeskey);
  log.debug("AES 加密完成", { encryptedSize: encrypted.length });

  // 3. Upload to CDN — POST raw ciphertext as application/octet-stream.
  // CDN returns the download param via the `x-encrypted-param` response header
  // (not a JSON body). Matches upstream Tencent openclaw-weixin protocol.
  const cdnTargetUrl = uploadFullUrl ?? `${baseUrl}/upload?${uploadParam}`;
  log.debug("上传到 CDN", { targetPrefix: cdnTargetUrl.slice(0, 60) });

  const cdnResponse = await fetchFn(cdnTargetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });

  if (cdnResponse.status !== 200) {
    const errMsg = cdnResponse.headers.get("x-error-message") ?? `status ${cdnResponse.status}`;
    log.error("CDN 上传失败", { status: cdnResponse.status, errMsg });
    throw new Error(`CDN upload failed (${cdnResponse.status}): ${errMsg}`);
  }

  const downloadParam = cdnResponse.headers.get("x-encrypted-param");
  if (!downloadParam) {
    log.error("CDN 响应缺少下载参数 header", { status: cdnResponse.status });
    throw new Error("CDN upload response missing x-encrypted-param header");
  }

  log.info("CDN 上传完成", { status: cdnResponse.status });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
