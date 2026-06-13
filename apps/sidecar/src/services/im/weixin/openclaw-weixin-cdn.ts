import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { OpenClawWeixinAccountAuth } from "./openclaw-weixin-api";
import type { WeixinUploadedMedia, WeixinUploadMediaTypeValue } from "./openclaw-weixin-media-types";

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

  // 1. Get upload URL
  const baseUrl = account.baseUrl.replace(/\/+$/, "");
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
    throw new Error("getuploadurl returned no upload URL");
  }

  // 2. Encrypt file
  const encrypted = aesEcbEncrypt(fileData, aeskey);

  // 3. Upload to CDN
  const cdnTargetUrl = uploadFullUrl ?? `${baseUrl}/upload?${uploadParam}`;
  const formData = new FormData();
  formData.append("filekey", filekey);
  formData.append("filedata", new Blob([encrypted]));

  const cdnResponse = await fetchFn(cdnTargetUrl, {
    method: "POST",
    body: formData,
  });
  const cdnResult = await readPayload(cdnResponse);
  const downloadParam = asString(cdnResult.downloadParam)
    ?? asString(cdnResult.encrypt_query_param)
    ?? "";

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
