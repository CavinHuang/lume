import type { ChatMessage, FileAttachment } from "@lume/shared";
import { isImageAttachment } from "./attachment-service";

type NanoBananaConstraintGroup = "watermark" | "textOverlay" | "people" | "subjectIdentity";

interface NanoBananaHintRule {
  pattern: RegExp;
  key: string;
  hint: string;
  group?: NanoBananaConstraintGroup | "renderingStyle";
  polarity?: "allow" | "forbid";
}

interface NanoBananaConstraintPreference {
  watermark?: "allow" | "forbid";
  textOverlay?: "allow" | "forbid";
  people?: "allow" | "forbid";
  subjectIdentity?: "allow" | "forbid";
}

interface NanoBananaIntentMemory {
  styleEntries: NanoBananaHintRule[];
  constraintEntries: NanoBananaHintRule[];
  lastImagePrompt?: string;
}

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

const NANO_BANANA_STYLE_HINT_RULES: NanoBananaHintRule[] = [
  { pattern: /写实|realistic|photoreal/i, key: "style-photoreal", hint: "photorealistic, highly detailed", group: "renderingStyle" },
  { pattern: /插画|illustration|插图/i, key: "style-illustration", hint: "digital illustration style", group: "renderingStyle" },
  { pattern: /水彩|watercolor/i, key: "style-watercolor", hint: "watercolor texture, soft edges", group: "renderingStyle" },
  { pattern: /动漫|anime|二次元/i, key: "style-anime", hint: "anime style, vivid linework", group: "renderingStyle" },
  { pattern: /赛博朋克|cyberpunk/i, key: "style-cyberpunk", hint: "cyberpunk style, neon lighting" },
  { pattern: /电影|cinematic/i, key: "style-cinematic", hint: "cinematic composition, dramatic lighting" },
  { pattern: /极简|minimal/i, key: "style-minimal", hint: "minimal composition, clean background" }
];

const NANO_BANANA_CONSTRAINT_HINT_RULES: NanoBananaHintRule[] = [
  { pattern: /无水印|不要水印|no watermark/i, key: "constraint-no-watermark", hint: "no watermark", group: "watermark", polarity: "forbid" },
  { pattern: /无文字|不要文字|不要字|no text/i, key: "constraint-no-text-overlay", hint: "no text overlay", group: "textOverlay", polarity: "forbid" },
  { pattern: /无人物|不要人物|no people/i, key: "constraint-no-people", hint: "no people", group: "people", polarity: "forbid" },
  { pattern: /高细节|高质量|高清|high detail|high quality/i, key: "constraint-high-quality", hint: "sharp details, high quality render" }
];

const NANO_BANANA_PRESERVE_SUBJECT_HINT: NanoBananaHintRule = {
  pattern: /(?:)/,
  key: "constraint-preserve-subject-identity",
  hint: "preserve subject identity unless user requests replacement",
  group: "subjectIdentity",
  polarity: "forbid"
};

function hasImageAttachments(attachments?: FileAttachment[]): boolean {
  return attachments?.some((item) => isImageAttachment(item.mediaType)) ?? false;
}

function shouldRunNanoBanana(userMessage: string, attachments?: FileAttachment[]): boolean {
  if (attachments?.some((item) => isImageAttachment(item.mediaType))) {
    return true;
  }
  return NANO_BANANA_KEYWORD_PATTERN.test(userMessage.trim());
}

function collectPromptHintEntries(
  userMessage: string,
  rules: NanoBananaHintRule[]
): NanoBananaHintRule[] {
  const hints: NanoBananaHintRule[] = [];
  const seenKeys = new Set<string>();
  for (const rule of rules) {
    if (rule.pattern.test(userMessage)) {
      if (seenKeys.has(rule.key)) continue;
      seenKeys.add(rule.key);
      hints.push(rule);
    }
  }
  return hints;
}

function mergePromptHintEntries(
  currentEntries: NanoBananaHintRule[],
  rememberedEntries: NanoBananaHintRule[]
): NanoBananaHintRule[] {
  const merged: NanoBananaHintRule[] = [...currentEntries];
  const currentGroups = new Set(
    currentEntries
      .map((entry) => entry.group)
      .filter((group): group is Exclude<NanoBananaHintRule["group"], undefined> => typeof group === "string")
  );
  for (const remembered of rememberedEntries) {
    if (merged.some((entry) => entry.key === remembered.key)) continue;
    if (remembered.group && currentGroups.has(remembered.group)) continue;
    merged.push(remembered);
  }
  return merged;
}

function resolveConstraintPreference(
  userMessage: string,
  currentConstraintEntries: NanoBananaHintRule[]
): NanoBananaConstraintPreference {
  const preference: NanoBananaConstraintPreference = {};
  for (const entry of currentConstraintEntries) {
    if (!entry.group || !entry.polarity) continue;
    if (entry.group === "watermark" || entry.group === "textOverlay" || entry.group === "people" || entry.group === "subjectIdentity") {
      preference[entry.group] = entry.polarity;
    }
  }

  if (!preference.textOverlay && NANO_BANANA_ENABLE_TEXT_OVERLAY_PATTERN.test(userMessage)) {
    preference.textOverlay = "allow";
  }
  if (!preference.people && NANO_BANANA_ENABLE_PEOPLE_PATTERN.test(userMessage)) {
    preference.people = "allow";
  }
  if (!preference.watermark && NANO_BANANA_ENABLE_WATERMARK_PATTERN.test(userMessage)) {
    preference.watermark = "allow";
  }
  if (NANO_BANANA_REPLACE_SUBJECT_KEYWORD_PATTERN.test(userMessage)) {
    preference.subjectIdentity = "allow";
  }

  return preference;
}

function pruneConstraintConflicts(
  entries: NanoBananaHintRule[],
  preference: NanoBananaConstraintPreference
): NanoBananaHintRule[] {
  const filtered = entries.filter((entry) => {
    if (!entry.group || !entry.polarity) return true;
    if (entry.group === "renderingStyle") return true;
    const pref = preference[entry.group];
    if (!pref) return true;
    return pref === entry.polarity;
  });

  const output: NanoBananaHintRule[] = [];
  const seenKeys = new Set<string>();
  const seenGroups = new Set<string>();
  for (const entry of filtered) {
    if (seenKeys.has(entry.key)) continue;
    if (entry.group && entry.polarity) {
      if (seenGroups.has(entry.group)) continue;
      seenGroups.add(entry.group);
    }
    output.push(entry);
    seenKeys.add(entry.key);
  }
  return output;
}

function collectNanoBananaIntentMemory(messageHistory: ChatMessage[]): NanoBananaIntentMemory {
  for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
    const item = messageHistory[index];
    if (!item || item.role !== "user") continue;
    const text = item.content.trim();
    if (!text) continue;
    const styleEntries = collectPromptHintEntries(text, NANO_BANANA_STYLE_HINT_RULES);
    const constraintEntries = collectPromptHintEntries(text, NANO_BANANA_CONSTRAINT_HINT_RULES);
    const imageIntent = shouldRunNanoBanana(text, item.attachments);
    if (!imageIntent && styleEntries.length === 0 && constraintEntries.length === 0) continue;
    return {
      styleEntries,
      constraintEntries,
      lastImagePrompt: text
    };
  }
  return {
    styleEntries: [],
    constraintEntries: [],
    lastImagePrompt: undefined
  };
}

function summarizePromptForIntentMemory(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 120)}...`;
}

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

export function buildNanoBananaEnhancedPrompt(
  userMessage: string,
  options?: { messageHistory?: ChatMessage[]; useReferenceImages?: boolean }
): string {
  const base = userMessage.trim();
  if (!base) return base;

  const shouldReuseIntent = (
    NANO_BANANA_CONTINUATION_KEYWORD_PATTERN.test(base)
    || options?.useReferenceImages === true
  );
  const intentMemory = shouldReuseIntent
    ? collectNanoBananaIntentMemory(options?.messageHistory ?? [])
    : { styleEntries: [], constraintEntries: [], lastImagePrompt: undefined };

  const styleEntries = collectPromptHintEntries(base, NANO_BANANA_STYLE_HINT_RULES);
  const constraintEntries = collectPromptHintEntries(base, NANO_BANANA_CONSTRAINT_HINT_RULES);
  const constraintPreference = resolveConstraintPreference(base, constraintEntries);
  if (
    NANO_BANANA_EDIT_KEYWORD_PATTERN.test(base)
    && constraintPreference.subjectIdentity !== "allow"
  ) {
    constraintEntries.push(NANO_BANANA_PRESERVE_SUBJECT_HINT);
  }
  const mergedStyleEntries = mergePromptHintEntries(styleEntries, intentMemory.styleEntries);
  const mergedConstraintEntries = pruneConstraintConflicts(
    mergePromptHintEntries(constraintEntries, intentMemory.constraintEntries),
    constraintPreference
  );

  const styleHints = mergedStyleEntries.map((entry) => entry.hint);
  const normalizedConstraintHints = mergedConstraintEntries.map((entry) => entry.hint);

  const hasAsciiWords = /[a-zA-Z]{3,}/.test(base);
  if (styleHints.length === 0 && !hasAsciiWords && /[\u4e00-\u9fff]/.test(base)) {
    styleHints.push("high quality composition, balanced lighting");
  }
  if (styleHints.length === 0 && normalizedConstraintHints.length === 0) {
    return base;
  }
  const sections = [base];
  if (styleHints.length > 0) {
    sections.push(`Style hints: ${styleHints.join("; ")}.`);
  }
  if (normalizedConstraintHints.length > 0) {
    sections.push(`Constraints: ${normalizedConstraintHints.join("; ")}.`);
  }
  if (shouldReuseIntent && intentMemory.lastImagePrompt && intentMemory.lastImagePrompt !== base) {
    sections.push(
      `Intent memory: continue previous request context (${summarizePromptForIntentMemory(intentMemory.lastImagePrompt)}), unless current instructions override it.`
    );
  }
  return sections.join("\n\n");
}
