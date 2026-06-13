import type { ToolDefinition } from "@lume/agent-sdk";
import type { ImThreadBinding } from "@lume/shared";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getImThreadBindingByThreadId } from "../../../im/im-thread-binding-store";
import { sendBoundImTextMessage, sendBoundImMediaMessage } from "../../../im/im-send-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export interface CreateImToolsInput {
  threadId: string;
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
          throw new Error("当前线程未绑定 IM 会话，无法发送。");
        }
        const text = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
        if (!text) {
          throw new Error("text 必填");
        }
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
- image_url: Download an image from a URL and send it
- file_path: Read a local file and send it as an attachment

Provide exactly one of image_url or file_path. You may optionally include a caption.`,
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of an image to download and send via WeChat." },
          file_path: { type: "string", description: "Local file path to send as attachment." },
          caption: { type: "string", description: "Optional caption text to send before the media." },
        },
      },
      async call(args) {
        const binding = getImThreadBindingByThreadId(input.threadId);
        if (!binding) {
          throw new Error("当前线程未绑定 IM 会话，无法发送。");
        }

        const imageUrl = typeof args.image_url === "string" && args.image_url.trim() ? args.image_url.trim() : undefined;
        const filePath = typeof args.file_path === "string" && args.file_path.trim() ? args.file_path.trim() : undefined;
        const caption = typeof args.caption === "string" && args.caption.trim() ? args.caption.trim() : undefined;

        if (!imageUrl && !filePath) {
          throw new Error("必须提供 image_url 或 file_path 之一。");
        }

        const sendMediaMessage = input.sendMediaMessage ?? sendBoundImMediaMessage;

        // Image via URL
        if (imageUrl) {
          const response = await fetch(imageUrl);
          if (!response.ok) {
            throw new Error(`下载图片失败: ${response.status} ${response.statusText}`);
          }
          const fileData = Buffer.from(await response.arrayBuffer());
          await sendMediaMessage({
            binding,
            mediaType: "image",
            fileData,
            fileName: extractFileName(imageUrl, "image.jpg"),
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

        // File via local path
        if (filePath) {
          const fileData = readFileSync(filePath);
          await sendMediaMessage({
            binding,
            mediaType: "file",
            fileData,
            fileName: basename(filePath),
            caption,
          });
          return {
            ok: true,
            type: "file",
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
