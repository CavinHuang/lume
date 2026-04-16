import type { AgentMessage } from "@lume/shared";

const MAX_TITLE_LENGTH = 20;

const DEFAULT_AGENT_TITLE_CANDIDATES = [
  "新 Agent 线程",
  "新线程",
  "新对话",
  "new agent thread"
];

export const AGENT_TITLE_PROMPT_FROM_SUMMARY =
  "根据用户的消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";

function normalizeTitleForCompare(title: string): string {
  return title.trim().toLowerCase();
}

export function shouldAutoGenerateThreadTitle(title?: string): boolean {
  if (!title) return true;
  const normalized = normalizeTitleForCompare(title);
  return DEFAULT_AGENT_TITLE_CANDIDATES
    .map((candidate) => normalizeTitleForCompare(candidate))
    .includes(normalized);
}

export function sanitizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

export function isWeakGeneratedTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  const weakWords = [
    "总结",
    "线程",
    "对话",
    "任务",
    "已完成",
    "好的",
    "ok",
    "done"
  ];
  if (normalized.length < 4) return true;
  return weakWords.some((word) => normalized === word || normalized.includes(` ${word}`));
}

export function deriveFallbackTitleFromSourceText(sourceText: string): string | null {
  const trimmed = sourceText.trim();
  if (!trimmed) return null;
  const compact = trimmed
    .replace(/\s+/g, " ")
    .replace(/[。！？!?,，；;：:"'`~<>()[\]{}“”‘’《》【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  const sliced = compact.slice(0, MAX_TITLE_LENGTH).trim();
  return sliced || null;
}

export function resolveTitleSourceText(
  messages: AgentMessage[],
  fallbackUserMessage: string
): string {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role === "user" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return fallbackUserMessage.trim();
}

export const deriveFallbackAgentTitleFromSourceText = deriveFallbackTitleFromSourceText;
export const resolveAgentTitleSourceText = resolveTitleSourceText;
