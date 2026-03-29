import { Type } from "@sinclair/typebox";
import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest
} from "@lume/shared";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { waitForPiAskUserQuestionAnswers } from "../bridges/ask-user-question-bridge";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 4;

const ASK_USER_QUESTION_PROMPT = `Use this tool to ask the user questions during execution.

REQUIRED FORMAT - Each question MUST have:
1. question: The question text (required)
2. header: Short label, max 12 chars (required)
3. options: Array of 2-4 choices (REQUIRED), each with { label, description }
4. multiSelect: boolean (optional, default false)

Example:
{
  "questions": [{
    "header": "方案选择",
    "question": "您希望使用哪种实现方式？",
    "options": [
      { "label": "React Context (推荐)", "description": "轻量级，适合中小型应用" },
      { "label": "Redux", "description": "功能强大，适合大型应用" },
      { "label": "Zustand", "description": "简洁 API，性能优秀" }
    ],
    "multiSelect": false
  }]
}

IMPORTANT RULES:
- You MUST provide 2-4 meaningful, specific options for EACH question
- Options must be actionable choices, NOT generic like "继续/调整/确认"
- Put recommended option first with "(推荐)" suffix in label`;

interface NormalizedAskOption {
  label: string;
  description: string;
}

interface NormalizedAskQuestion {
  header: string;
  question: string;
  options: NormalizedAskOption[];
  multiSelect: boolean;
}

function toTextResult<TDetails>(details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2)
      }
    ],
    details
  };
}

function toReadableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function ensureUniqueHeader(header: string, usedHeaders: Set<string>, index: number): string {
  const base = (header.trim() || `问题${index + 1}`).slice(0, 12);
  let candidate = base;
  let suffix = 2;
  while (usedHeaders.has(candidate)) {
    const next = `${base.slice(0, Math.max(0, 11 - String(suffix).length))}${suffix}`;
    candidate = next || `问题${index + 1}`;
    suffix += 1;
  }
  usedHeaders.add(candidate);
  return candidate;
}

function normalizeOption(option: unknown, optionIndex: number): NormalizedAskOption {
  if (typeof option === "string") {
    const text = option.trim();
    if (text) {
      return { label: text, description: text };
    }
  }
  const optionRecord = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
  const rawLabel =
    toReadableString(optionRecord.label) ||
    toReadableString(optionRecord.text) ||
    toReadableString(optionRecord.title) ||
    toReadableString(optionRecord.name) ||
    toReadableString(optionRecord.value);
  const rawDescription =
    toReadableString(optionRecord.description) ||
    toReadableString(optionRecord.desc) ||
    toReadableString(optionRecord.detail) ||
    toReadableString(optionRecord.reason);
  const fallbackLabel = rawLabel || rawDescription || `选项${optionIndex + 1}`;
  const fallbackDescription = rawDescription || fallbackLabel;
  return {
    label: fallbackLabel,
    description: fallbackDescription
  };
}

function normalizeOptions(rawOptions: unknown): NormalizedAskOption[] {
  const source = Array.isArray(rawOptions) ? rawOptions : [];
  const options = source.slice(0, MAX_ASK_OPTIONS).map((item, index) => normalizeOption(item, index));
  const deduped: NormalizedAskOption[] = [];
  const usedLabels = new Set<string>();
  for (const option of options) {
    const label = option.label.trim();
    if (!label || usedLabels.has(label)) {
      continue;
    }
    usedLabels.add(label);
    deduped.push({
      label,
      description: option.description.trim() || label
    });
  }
  if (deduped.length < 2) {
    throw new Error(
      "AskUserQuestion 选项不足：每个问题必须提供 2-4 个有意义的选项。" +
      "请重新调用并提供具体选项，格式：{ \"options\": [{ \"label\": \"选项A\", \"description\": \"描述\" }, ...] }"
    );
  }
  return deduped;
}

function parseRawQuestions(input: Record<string, unknown>): unknown[] {
  const rawQuestionsValue = input.questions;
  let rawQuestions: unknown[] = [];
  if (Array.isArray(rawQuestionsValue)) {
    rawQuestions = rawQuestionsValue;
  } else if (typeof rawQuestionsValue === "string") {
    const trimmed = rawQuestionsValue.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { questions?: unknown }).questions)
        ) {
          rawQuestions = (parsed as { questions: unknown[] }).questions;
        }
      } catch {
        rawQuestions = [];
      }
    } else if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          rawQuestions = parsed;
        }
      } catch {
        rawQuestions = [];
      }
    } else if (trimmed.length > 0) {
      rawQuestions = [trimmed];
    }
  }
  if (rawQuestions.length === 0) {
    const hasQuestionLikeField =
      typeof input.question === "string" ||
      typeof input.prompt === "string" ||
      Array.isArray(input.options);
    if (hasQuestionLikeField) {
      rawQuestions = [input];
    }
  }
  return rawQuestions;
}

function sanitizeAskUserQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  const rawQuestions = parseRawQuestions(input);
  const usedHeaders = new Set<string>();
  const questions = rawQuestions.slice(0, MAX_ASK_QUESTIONS).map((item, questionIndex): NormalizedAskQuestion => {
    const questionRecord = item && typeof item === "object"
      ? (item as Record<string, unknown>)
      : {
        question: toReadableString(item),
        header: `问题${questionIndex + 1}`,
        options: [
          { label: "继续", description: "继续按当前方向执行" },
          { label: "调整", description: "调整方案后再执行" }
        ]
      };
    const options = normalizeOptions(questionRecord.options);
    const rawHeader =
      toReadableString(questionRecord.header) ||
      toReadableString(questionRecord.id) ||
      `问题${questionIndex + 1}`;
    const header = ensureUniqueHeader(rawHeader, usedHeaders, questionIndex);
    const question =
      toReadableString(questionRecord.question) ||
      toReadableString(questionRecord.prompt) ||
      `${header}？`;
    const multiSelect = questionRecord.multiSelect === true;
    return {
      header,
      question,
      options,
      multiSelect
    };
  });
  return {
    ...input,
    questions: questions.length > 0
      ? questions
      : [{
        header: "问题1",
        question: "请确认下一步要执行的方向",
        options: [
          { label: "继续", description: "继续按当前方案执行" },
          { label: "调整", description: "先调整方案再执行" }
        ],
        multiSelect: false
      }]
  };
}

function normalizeAskUserQuestions(input: Record<string, unknown>): AgentAskUserQuestionQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const normalized: AgentAskUserQuestionQuestion[] = [];
  const usedHeaders = new Set<string>();
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const headerRaw = typeof record.header === "string" ? record.header.trim() : "";
    const header = ensureUniqueHeader(headerRaw, usedHeaders, normalized.length);
    const questionRaw = typeof record.question === "string" ? record.question.trim() : "";
    const question = questionRaw || `${header}？`;
    const multiSelect = record.multiSelect === true;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = normalizeOptions(rawOptions);
    if (!question || options.length < 2) continue;
    normalized.push({
      header,
      question,
      options,
      multiSelect
    });
  }
  return normalized;
}

export function createPiControlTools(params: {
  sessionId: string;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  includeAskUserQuestion?: boolean;
}): AgentTool[] {
  const includeAskUserQuestion = params.includeAskUserQuestion !== false;
  const tools: AgentTool[] = [];

  if (includeAskUserQuestion) {
    tools.push({
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: ASK_USER_QUESTION_TOOL_NAME,
      description: ASK_USER_QUESTION_PROMPT,
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            header: Type.String({ maxLength: 12, description: "Short label for the question" }),
            question: Type.String({ description: "The question text to display" }),
            options: Type.Array(
              Type.Object({
                label: Type.String({ description: "Option label, add (推荐) suffix for recommended" }),
                description: Type.String({ description: "Brief explanation of this option" })
              }),
              { minItems: 2, maxItems: 4, description: "2-4 meaningful choices" }
            ),
            multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" }))
          }),
          { minItems: 1, maxItems: 4 }
        )
      }),
      async execute(toolCallId, args, signal) {
        const rawInput = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const sanitizedInput = sanitizeAskUserQuestionInput(rawInput);
        const questions = normalizeAskUserQuestions(sanitizedInput);
        if (questions.length === 0) {
          throw new Error("AskUserQuestion 缺少有效问题，已拒绝执行");
        }
        const askResult = await waitForPiAskUserQuestionAnswers(
          params.sessionId,
          toolCallId,
          questions,
          signal ?? new AbortController().signal,
          params.emitAskUserQuestion
        );
        if (askResult.status !== "answered" || !askResult.answers) {
          if (askResult.status === "timeout") {
            throw new Error("AskUserQuestion 等待用户回答超时");
          }
          if (askResult.status === "aborted") {
            throw new Error("AskUserQuestion 被会话中止");
          }
          throw new Error("用户取消了 AskUserQuestion");
        }
        return toTextResult({
          ...sanitizedInput,
          answers: askResult.answers
        });
      }
    });
  }

  return tools;
}

export const __testing = {
  sanitizeAskUserQuestionInput,
  normalizeAskUserQuestions
};
