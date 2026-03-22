/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-tools\nano-banana-tool.ts
 * Adaptation:
 * - Chat 模式先对齐最小生图闭环（请求 Gemini Image Generation + 保存图片附件）。
 * - 暂不引入多轮 thought signature 历史复用。
 */

import { randomUUID } from "node:crypto";
import type { ChatToolTestResult, FileAttachment } from "@lume/shared";
import { isImageAttachment, readAttachmentAsBase64, saveAttachment } from "./attachment-service";

export const NANO_BANANA_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const NANO_BANANA_DEFAULT_MODEL = "gemini-3.1-flash-image-preview";

interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
}

interface GeminiResponsePayload {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface NanoBananaGenerateInput {
  conversationId: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  useReferenceImages?: boolean;
  currentAttachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
}

export interface NanoBananaGenerateResult {
  text: string;
  attachments?: FileAttachment[];
}

function toImageExtByMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/gif") return ".gif";
  return ".png";
}

function collectReferenceImageParts(input: NanoBananaGenerateInput): Array<{ inlineData: { mimeType: string; data: string } }> {
  const allAttachments: FileAttachment[] = [
    ...(input.previousUserAttachments ?? []),
    ...(input.previousAssistantAttachments ?? []),
    ...(input.currentAttachments ?? [])
  ];

  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const attachment of allAttachments) {
    if (!isImageAttachment(attachment.mediaType)) continue;
    try {
      parts.push({
        inlineData: {
          mimeType: attachment.mediaType,
          data: readAttachmentAsBase64(attachment.localPath)
        }
      });
    } catch (error) {
      console.warn(`[Nano Banana] 读取参考图失败: ${attachment.localPath}`, error);
    }
  }
  return parts;
}

function buildNanoBananaRequestBody(input: NanoBananaGenerateInput): Record<string, unknown> {
  const referenceParts = input.useReferenceImages ? collectReferenceImageParts(input) : [];
  const userParts = [...referenceParts, { text: input.prompt }];
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"]
  };
  const imageConfig: Record<string, unknown> = {};

  if (input.aspectRatio && input.aspectRatio !== "1:1") {
    imageConfig.aspectRatio = input.aspectRatio;
  }
  if (input.imageSize && input.imageSize !== "auto") {
    imageConfig.imageSize = input.imageSize;
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }

  return {
    contents: [{ role: "user", parts: userParts }],
    generationConfig
  };
}

function parseNanoBananaResponse(input: NanoBananaGenerateInput, payload: GeminiResponsePayload): NanoBananaGenerateResult {
  if (payload.error?.message) {
    throw new Error(`Gemini API 错误: ${payload.error.message}`);
  }

  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const savedAttachments: FileAttachment[] = [];
  const textParts: string[] = [];

  for (const part of parts) {
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData.mimeType && inlineData.mimeType.startsWith("image/")) {
      const filename = `nano-banana-${randomUUID().slice(0, 8)}${toImageExtByMediaType(inlineData.mimeType)}`;
      const { attachment } = saveAttachment({
        conversationId: input.conversationId,
        filename,
        mediaType: inlineData.mimeType,
        data: inlineData.data
      });
      savedAttachments.push(attachment);
      continue;
    }
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      textParts.push(part.text.trim());
    }
  }

  if (savedAttachments.length > 0) {
    return {
      text: `图片已成功生成（${savedAttachments.length} 张）${textParts.length > 0 ? `\n\n${textParts.join("\n")}` : ""}`,
      attachments: savedAttachments
    };
  }

  if (textParts.length > 0) {
    return { text: textParts.join("\n") };
  }

  throw new Error("未生成图片内容");
}

export async function generateNanoBananaImage(
  input: NanoBananaGenerateInput,
  credentials: Record<string, string>
): Promise<NanoBananaGenerateResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("参数缺失: prompt");
  }

  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Nano Banana 未配置 API Key");
  }

  const baseUrl = credentials.baseUrl?.trim() || NANO_BANANA_DEFAULT_BASE_URL;
  const model = credentials.model?.trim() || NANO_BANANA_DEFAULT_MODEL;
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = buildNanoBananaRequestBody(input);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json() as GeminiResponsePayload;
  return parseNanoBananaResponse(input, payload);
}

export async function testNanoBananaConnection(credentials: Record<string, string>): Promise<ChatToolTestResult> {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) {
    return { success: false, message: "请先填写 Gemini API Key" };
  }

  const baseUrl = credentials.baseUrl?.trim() || NANO_BANANA_DEFAULT_BASE_URL;
  const model = credentials.model?.trim() || NANO_BANANA_DEFAULT_MODEL;
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Lume-Chat/1.0 (+nano-banana-test)"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        generationConfig: {
          maxOutputTokens: 10
        }
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, message: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` };
    }
    return { success: true, message: `连接成功，模型 ${model} 可用` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `连接失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
