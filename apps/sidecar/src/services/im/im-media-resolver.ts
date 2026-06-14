import type { ImMessageContent } from "@lume/shared";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResolveMediaOptions {
  fetchImpl?: FetchLike;
  /** CDN base URL，用于把 encrypt_query_param 拼成可下载 URL（消息未带 full_url 时） */
  cdnBaseUrl?: string;
  /** 保存媒体到线程附件目录，返回相对 threadPath；注入后 resolver 会下载并保存，把 content.url/downloadUrl 指向本地路径。 */
  saveMedia?: (input: { filename: string; data: Buffer; mediaType: string }) => Promise<string | undefined>;
}

export async function resolveMediaContents(
  contents: ImMessageContent[],
  options?: ResolveMediaOptions
): Promise<ImMessageContent[]> {
  return Promise.all(
    contents.map((content, index) => {
      if (content.type === "image" && content.url) {
        return resolveImageContent(content, index, options);
      }
      if (content.type === "file" && content.downloadUrl) {
        return resolveFileContent(content, index, options);
      }
      return Promise.resolve(content);
    })
  );
}

async function resolveImageContent(
  content: ImMessageContent & { type: "image" },
  index: number,
  options?: ResolveMediaOptions
): Promise<ImMessageContent> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const downloadUrl = resolveDownloadUrl(content.url, options?.cdnBaseUrl);
  if (!downloadUrl) {
    return { type: "text", text: "[图片: 下载失败]" };
  }
  try {
    const response = await fetchFn(downloadUrl);
    if (!response.ok) {
      return { type: "text", text: "[图片: 下载失败]" };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (options?.saveMedia) {
      const mediaType = normalizeImageMediaType(response.headers.get("content-type"));
      const ext = imageExtensionFor(mediaType);
      const threadPath = await options.saveMedia({
        filename: `im-image-${index}.${ext}`,
        data,
        mediaType,
      });
      if (threadPath) {
        return { ...content, url: threadPath };
      }
    }
    return content;
  } catch {
    return { type: "text", text: "[图片: 下载失败]" };
  }
}

async function resolveFileContent(
  content: ImMessageContent & { type: "file" },
  index: number,
  options?: ResolveMediaOptions
): Promise<ImMessageContent> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const downloadUrl = resolveDownloadUrl(content.downloadUrl, options?.cdnBaseUrl);
  if (!downloadUrl) {
    return { type: "text", text: `[文件: ${content.fileName}（下载失败）]` };
  }
  if (!options?.saveMedia) {
    return content;
  }
  try {
    const response = await fetchFn(downloadUrl);
    if (!response.ok) {
      return { type: "text", text: `[文件: ${content.fileName}（下载失败）]` };
    }
    const data = Buffer.from(await response.arrayBuffer());
    const mediaType = deriveFileMediaType(content.fileName);
    const threadPath = await options.saveMedia({
      filename: content.fileName || `im-file-${index}`,
      data,
      mediaType,
    });
    if (threadPath) {
      return { ...content, downloadUrl: threadPath };
    }
    return content;
  } catch {
    return { type: "text", text: `[文件: ${content.fileName}（下载失败）]` };
  }
}

function resolveDownloadUrl(rawUrl: string | undefined, cdnBaseUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (cdnBaseUrl) {
    return `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(rawUrl)}`;
  }
  return undefined;
}

const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function normalizeImageMediaType(raw: string | null): string {
  const type = (raw ?? "").split(";")[0]?.trim().toLowerCase();
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
