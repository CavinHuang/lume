import type { ChatMessage, FileAttachment } from "@lume/shared";
import { isImageAttachment } from "./attachment-service";

// ─── Keyword patterns ───

const NANO_BANANA_KEYWORD_PATTERN =
  /图片|图像|配图|海报|插画|封面|壁纸|logo|生图|绘图|画一张|生成图|这张图|这幅图|改图|修图|image|poster|illustration|cover|draw|render/iu;
const NANO_BANANA_EDIT_KEYWORD_PATTERN =
  /修改|编辑|重绘|重做|优化|继续|基于|参考|换|改成|replace|edit|modify|adjust|reference/iu;
const NANO_BANANA_CONTINUATION_KEYWORD_PATTERN =
  /继续|延续|保持|同风格|一样|再来|沿用|继续这张|continue|keep style|same style|another version|iterate/iu;
const NANO_BANANA_REPLACE_SUBJECT_KEYWORD_PATTERN =
  /替换主体|换主体|换成|替换成|replace subject|swap subject|change subject/iu;
const NANO_BANANA_ENABLE_TEXT_OVERLAY_PATTERN =
  /加(上)?(标题)?文字|添加(标题)?文字|带文字|加(上)?标题|标题文案|slogan|caption|add text|with text/iu;
const NANO_BANANA_ENABLE_PEOPLE_PATTERN =
  /加入(一个)?人物|加(入)?一个人|有人物|带人物|with (a )?(person|people)|include (a )?(person|people)/iu;
const NANO_BANANA_ENABLE_WATERMARK_PATTERN =
  /加(上)?水印|带水印|with watermark|add watermark/iu;

// ─── Default style / constraint system prompt constants ───

const DEFAULT_STYLE_GUIDANCE =
  "Generate a high quality image with balanced composition and lighting. " +
  "Follow the user's style instructions if provided; otherwise, use a clean and professional style.";

const DEFAULT_CONSTRAINT_GUIDANCE =
  "Unless the user explicitly requests otherwise: " +
  "no watermark, no text overlay, no people in the scene. " +
  "Preserve subject identity when editing unless the user asks for subject replacement.";

// ─── Utility helpers ───

function hasImageAttachments(attachments?: FileAttachment[]): boolean {
  return attachments?.some((item) => isImageAttachment(item.mediaType)) ?? false;
}

function shouldRunNanoBanana(userMessage: string, attachments?: FileAttachment[]): boolean {
  if (attachments?.some((item) => isImageAttachment(item.mediaType))) {
    return true;
  }
  return NANO_BANANA_KEYWORD_PATTERN.test(userMessage.trim());
}

// ─── Public API ───

export function shouldRunNanoBananaForChat(userMessage: string, attachments?: FileAttachment[]): boolean {
  return shouldRunNanoBanana(userMessage, attachments);
}

export function shouldUseReferenceImagesForNanoBanana(input: {
  userMessage: string;
  currentAttachments?: FileAttachment[];
  previousUserAttachments?: FileAttachment[];
  previousAssistantAttachments?: FileAttachment[];
}): boolean {
  if (hasImageAttachments(input.currentAttachments)) {
    return true;
  }
  const hasPreviousImage = hasImageAttachments(input.previousUserAttachments) || hasImageAttachments(input.previousAssistantAttachments);
  if (!hasPreviousImage) return false;
  return NANO_BANANA_EDIT_KEYWORD_PATTERN.test(input.userMessage);
}

export function inferNanoBananaAspectRatio(userMessage: string): string | undefined {
  const text = userMessage.toLowerCase();
  if (text.includes("16:9") || text.includes("横版")) return "16:9";
  if (text.includes("9:16") || text.includes("竖版")) return "9:16";
  if (text.includes("4:3")) return "4:3";
  if (text.includes("3:4")) return "3:4";
  if (text.includes("1:1") || text.includes("方图") || text.includes("正方形")) return "1:1";
  return undefined;
}

export function inferNanoBananaImageSize(userMessage: string): string | undefined {
  const text = userMessage.toLowerCase();
  if (text.includes("4k") || text.includes("4096")) return "4K";
  if (text.includes("2k") || text.includes("2048")) return "2K";
  if (text.includes("1k") || text.includes("1024")) return "1K";
  return undefined;
}

/**
 * Build an enhanced prompt for NanoBanana image generation.
 *
 * Simplified from the previous rule-engine approach: now appends static
 * style/constraint guidance as a system-level suffix. The LLM-backed
 * image generation service is responsible for interpreting the user's
 * style and constraint intent from the prompt text itself.
 */
export function buildNanoBananaEnhancedPrompt(
  userMessage: string,
  _options?: { messageHistory?: ChatMessage[]; useReferenceImages?: boolean }
): string {
  const base = userMessage.trim();
  if (!base) return base;

  const sections = [base];

  // Append static guidance so the image model has reasonable defaults
  sections.push(`[Style guidance] ${DEFAULT_STYLE_GUIDANCE}`);
  sections.push(`[Constraint guidance] ${DEFAULT_CONSTRAINT_GUIDANCE}`);

  return sections.join("\n\n");
}
