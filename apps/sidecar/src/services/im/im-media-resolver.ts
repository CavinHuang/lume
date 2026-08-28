import type { ImMessageContent } from "@lume/shared";
import { SafeHttpFetchService } from "../infra/safe-http-fetch";
import { aesEcbDecrypt, parseAesKey } from "./weixin/openclaw-weixin-cdn";

/** 入站媒体上限：对端可发平台上限内的大文件，全量进内存（Buffer+base64 ≈ ×2）会放大峰值（#405）。 */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * #598：入站媒体统一走安全抓取（DNS 公网校验 + 固定 IP 连接 + maxBytes 截断），
 * 不再裸 fetch 对端投喂的 URL；代理策略对齐 IM 媒体下载直连语义。
 */
const mediaSafeFetcher = new SafeHttpFetchService();

/** 若带 aesKey，则按腾讯 CDN 协议 AES-128-ECB 解密；否则视为明文原样返回。 */
function decryptIfEncrypted(data: Buffer, aesKey: string | undefined): Buffer {
  if (!aesKey) return data;
  return aesEcbDecrypt(data, parseAesKey(aesKey));
}

export interface ResolveMediaOptions {
  /** 安全抓取器；测试经构造器 DI 注入（node:dns 无法用 globalThis.fetch mock）。 */
  safeFetch?: SafeHttpFetchService;
  /** CDN base URL，用于把 encrypt_query_param 拼成可下载 URL（消息未带 full_url 时）；也是全 URL 的同源白名单 */
  cdnBaseUrl?: string;
  /** 保存媒体到线程附件目录，返回相对 threadPath；注入后 resolver 会下载并保存，把 content.url/downloadUrl 指向本地路径。 */
  saveMedia?: (input: { filename: string; data: Buffer; mediaType: string }) => Promise<string | undefined>;
}

export async function resolveMediaContents(
  contents: ImMessageContent[],
  options?: ResolveMediaOptions
): Promise<ImMessageContent[]> {
  const safeFetch = options?.safeFetch ?? mediaSafeFetcher;
  return Promise.all(
    contents.map((content, index) => {
      if (content.type === "image" && content.url) {
        return resolveImageContent(content, index, { safeFetch, options });
      }
      if (content.type === "file" && content.downloadUrl) {
        return resolveFileContent(content, index, { safeFetch, options });
      }
      return Promise.resolve(content);
    })
  );
}

interface ResolveContext {
  safeFetch: SafeHttpFetchService;
  options?: ResolveMediaOptions;
}

async function resolveImageContent(
  content: ImMessageContent & { type: "image" },
  index: number,
  ctx: ResolveContext
): Promise<ImMessageContent> {
  const downloadUrl = resolveDownloadUrl(content.url, ctx.options?.cdnBaseUrl);
  if (!downloadUrl) {
    return { type: "text", text: "[图片: 下载失败]" };
  }
  try {
    const result = await ctx.safeFetch.fetch(downloadUrl, { maxBytes: MAX_MEDIA_BYTES, proxyPolicy: "ignore" });
    const data = Buffer.from(result.body);
    if (ctx.options?.saveMedia) {
      const mediaType = normalizeImageMediaType(result.contentType);
      const ext = imageExtensionFor(mediaType);
      const threadPath = await ctx.options.saveMedia({
        filename: `im-image-${index}.${ext}`,
        data: decryptIfEncrypted(data, content.aesKey),
        mediaType,
      });
      if (threadPath) {
        return { ...content, url: threadPath };
      }
    }
    return content;
  } catch (error) {
    if (isTooLargeError(error)) return { type: "text", text: "[图片: 过大，未下载]" };
    return { type: "text", text: "[图片: 下载失败]" };
  }
}

async function resolveFileContent(
  content: ImMessageContent & { type: "file" },
  index: number,
  ctx: ResolveContext
): Promise<ImMessageContent> {
  if (!ctx.options?.saveMedia) {
    return content;
  }
  const downloadUrl = resolveDownloadUrl(content.downloadUrl, ctx.options.cdnBaseUrl);
  if (!downloadUrl) {
    return { type: "text", text: `[文件: ${content.fileName}（下载失败）]` };
  }
  try {
    const result = await ctx.safeFetch.fetch(downloadUrl, { maxBytes: MAX_MEDIA_BYTES, proxyPolicy: "ignore" });
    const data = Buffer.from(result.body);
    const mediaType = deriveFileMediaType(content.fileName);
    const threadPath = await ctx.options.saveMedia({
      filename: content.fileName || `im-file-${index}`,
      data: decryptIfEncrypted(data, content.aesKey),
      mediaType,
    });
    if (threadPath) {
      return { ...content, downloadUrl: threadPath };
    }
    return content;
  } catch (error) {
    if (isTooLargeError(error)) return { type: "text", text: `[文件: ${content.fileName}（过大，未下载）]` };
    return { type: "text", text: `[文件: ${content.fileName}（下载失败）]` };
  }
}

/**
 * #598 宿主白名单：消息自带的全 URL 仅允许与账号 CDN base 同源（对端只能引用
 * 自己渠道 CDN 的资源，无法让 sidecar 抓任意/内网 URL）；相对加密参数经
 * cdnBaseUrl 拼接后天然同源。无 cdnBaseUrl 时全 URL fail-closed。
 */
function resolveDownloadUrl(rawUrl: string | undefined, cdnBaseUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  if (/^https?:\/\//i.test(rawUrl)) {
    if (!cdnBaseUrl) return undefined;
    try {
      if (new URL(rawUrl).host !== new URL(cdnBaseUrl).host) return undefined;
    } catch {
      return undefined;
    }
    return rawUrl;
  }
  if (cdnBaseUrl) {
    return `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(rawUrl)}`;
  }
  return undefined;
}

function isTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("超过大小限制");
}

const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function normalizeImageMediaType(raw: string): string {
  const type = raw.split(";")[0]?.trim().toLowerCase();
  return type && type.startsWith("image/") ? type : "image/jpeg";
}

function imageExtensionFor(mediaType: string): string {
  const ext = mediaType.slice("image/".length);
  return ext === "jpeg" ? "jpg" : (ext || "jpg");
}

function deriveFileMediaType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MEDIA_BY_EXT[ext] ?? "application/octet-stream";
}
