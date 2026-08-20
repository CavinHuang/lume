import type { ToolDefinition } from "@lume/agent-sdk";
import type { ImThreadBinding } from "@lume/shared";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { getImThreadBindingByThreadId } from "../../../im/im-thread-binding-store";
import { sendBoundImTextMessage, sendBoundImMediaMessage } from "../../../im/im-send-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { createLogger } from "../../../infra/logger";
import { isPathWithinRoot } from "../../permissions/permission-rules";
import { WikiSafeHttpFetchService } from "../../../wiki/safe-http-fetch";

const log = createLogger("im-tool");

/** URL 图片抓取上限：IM 平台媒体上传普遍在 10MB 量级，超限直接拒绝。 */
const IM_URL_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** 本地文件发送上限：对齐附件限额（AGENT_ATTACHMENT_LIMITS.maxFileBytes）。 */
const IM_FILE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** 复用 wiki 的安全抓取（DNS 全公网校验+固定 IP 连接+大小上限）；忽略代理 fail-closed 策略，保持 fetch 直连语义。 */
const imMediaFetcher = new WikiSafeHttpFetchService();

export interface CreateImToolsInput {
  threadId: string;
  /** 线程文件根目录（lumeWorkDir/files，image_gen 等产物落点）；与工具 ctx.cwd 共同构成 file_path 允许根。 */
  filesRoot?: string;
  /** URL 媒体安全抓取器；测试经构造器 DI 注入（node:http+dns 无法用 globalThis.fetch mock）。 */
  mediaFetcher?: WikiSafeHttpFetchService;
  sendTextMessage?: (input: {
    binding: ImThreadBinding;
    text: string;
  }) => Promise<{ ok: true } | { ok: boolean }>;
  sendMediaMessage?: (input: {
    binding: ImThreadBinding;
    mediaType: "image" | "video" | "file";
    fileData: Buffer;
    fileName: string;
    caption?: string;
  }) => Promise<{ ok: true } | { ok: boolean }>;
}

function extractFileName(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").pop();
    return last && last.length > 0 ? last : fallback;
  } catch {
    return fallback;
  }
}

export function createSdkImTools(input: CreateImToolsInput): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "send_im_message",
      description: "Send a text reply to the IM conversation bound to this Lume thread. The destination is fixed by the current thread binding and cannot be overridden.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text message to send.", minLength: 1 }
        },
        required: ["text"]
      },
      async call(args) {
        const binding = getImThreadBindingByThreadId(input.threadId);
        if (!binding) {
          log.warn("发送文本失败：线程未绑定 IM 会话", { threadId: input.threadId });
          throw new Error("当前线程未绑定 IM 会话，无法发送。");
        }
        const text = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
        if (!text) {
          throw new Error("text 必填");
        }
        log.info("工具调用 send_im_message", { threadId: input.threadId, peerId: binding.peerId, textLength: text.length });
        const sendTextMessage = input.sendTextMessage ?? sendBoundImTextMessage;
        await sendTextMessage({ binding, text });
        return {
          ok: true,
          provider: binding.provider,
          accountId: binding.accountId,
          peerKind: binding.peerKind,
          peerId: binding.peerId,
          warning: "已发送到绑定的 IM 会话；请勿在当前线程中声称已发送给其他联系人。",
        };
      },
    }),
    createSdkJsonResultTool({
      name: "send_im_media",
      description: `Send an image or file to the IM conversation bound to this Lume thread. Use this when you need to share a generated image, chart, diagram, or file with the user on the other end. The destination is fixed by the current thread binding.

Supports:
- image_url: Download an image from a public http(s) URL and send it (private-network addresses are blocked, max 10MB)
- file_path: Read a local file and send it as an attachment (must be inside the workspace or the thread files root, max 25MB)

Provide exactly one of image_url or file_path. You may optionally include a caption.`,
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of an image to download and send via WeChat." },
          file_path: { type: "string", description: "Local file path to send as attachment." },
          caption: { type: "string", description: "Optional caption text to send before the media." },
        },
      },
      async call(args, context) {
        const binding = getImThreadBindingByThreadId(input.threadId);
        if (!binding) {
          log.warn("发送媒体失败：线程未绑定 IM 会话", { threadId: input.threadId });
          throw new Error("当前线程未绑定 IM 会话，无法发送。");
        }

        const imageUrl = typeof args.image_url === "string" && args.image_url.trim() ? args.image_url.trim() : undefined;
        const filePath = typeof args.file_path === "string" && args.file_path.trim() ? args.file_path.trim() : undefined;
        const caption = typeof args.caption === "string" && args.caption.trim() ? args.caption.trim() : undefined;

        if (imageUrl && filePath) {
          throw new Error("image_url 与 file_path 只能提供一个。");
        }
        if (!imageUrl && !filePath) {
          throw new Error("必须提供 image_url 或 file_path 之一。");
        }

        log.info("工具调用 send_im_media", { threadId: input.threadId, peerId: binding.peerId, hasImageUrl: !!imageUrl, hasFilePath: !!filePath, hasCaption: !!caption });

        const sendMediaMessage = input.sendMediaMessage ?? sendBoundImMediaMessage;

        // Image via URL — 安全抓取：scheme/端口/DNS 私网校验 + 固定 IP 连接 + 大小上限
        if (imageUrl) {
          let fetched;
          try {
            fetched = await (input.mediaFetcher ?? imMediaFetcher).fetch(imageUrl, { maxBytes: IM_URL_MEDIA_MAX_BYTES, proxyPolicy: "ignore" });
          } catch (error) {
            throw new Error(`下载图片失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          const fileData = Buffer.from(fetched.body);
          await sendMediaMessage({
            binding,
            mediaType: "image",
            fileData,
            fileName: extractFileName(fetched.finalUrl, "image.jpg"),
            caption,
          });
          return {
            ok: true,
            type: "image",
            provider: binding.provider,
            accountId: binding.accountId,
            peerId: binding.peerId,
          };
        }

        // File via local path — 仅允许工作区（ctx.cwd）或线程文件根内的文件，realpath 防符号链接逃逸
        if (filePath) {
          const resolved = await realpath(filePath).catch(() => null);
          if (!resolved) {
            throw new Error(`文件不存在: ${filePath}`);
          }
          const allowedRoots = await Promise.all(
            [context.cwd, input.filesRoot]
              .filter((root): root is string => Boolean(root))
              .map((root) => realpath(root).catch(() => null)),
          );
          if (!allowedRoots.some((root) => root !== null && isPathWithinRoot(resolved, root))) {
            throw new Error("file_path 仅允许工作区或线程文件根目录内的文件。");
          }
          const info = await stat(resolved);
          if (info.size > IM_FILE_MEDIA_MAX_BYTES) {
            throw new Error(`文件超过 ${Math.floor(IM_FILE_MEDIA_MAX_BYTES / 1024 / 1024)}MB 上限。`);
          }
          const fileData = await readFile(resolved);
          const ext = basename(resolved).split(".").pop()?.toLowerCase() ?? "";
          const mediaType: "image" | "file" =
            ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)
              ? "image"
              : "file";
          await sendMediaMessage({
            binding,
            mediaType,
            fileData,
            fileName: basename(resolved),
            caption,
          });
          return {
            ok: true,
            type: mediaType,
            provider: binding.provider,
            accountId: binding.accountId,
            peerId: binding.peerId,
          };
        }

        throw new Error("未提供有效的媒体参数。");
      },
    })
  ];
}
