import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest
} from "@lume/shared";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { waitForPiAskUserQuestionAnswers } from "./ask-user-question-bridge";

const EXIT_PLAN_TOOL_NAME = "ExitPlanMode";
const ENTER_PLAN_TOOL_NAME = "EnterPlanMode";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 4;

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
  while (deduped.length < 2) {
    const index = deduped.length + 1;
    deduped.push({
      label: `选项${index}`,
      description: `候选项${index}`
    });
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

function extractPlanText(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter((item) => item && item !== "null")
      .join("\n")
      .trim();
    return lines || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidateKeys = ["plan", "content", "markdown", "text"];
    for (const key of candidateKeys) {
      const candidate = extractPlanText(record[key]);
      if (candidate) return candidate;
    }
    try {
      const serialized = JSON.stringify(record, null, 2).trim();
      return serialized || null;
    } catch {
      return null;
    }
  }
  return null;
}

function persistExitPlan(agentCwd: string, planText: string): string {
  const plansDir = join(agentCwd, "plans");
  const planPath = join(plansDir, "plan.md");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(planPath, planText.endsWith("\n") ? planText : `${planText}\n`, "utf-8");
  return planPath;
}

export function createPiControlTools(params: {
  sessionId: string;
  agentCwd: string;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
}): AgentTool[] {
  return [
    {
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: ASK_USER_QUESTION_TOOL_NAME,
      description:
        "Ask the user focused questions and wait for answers. Input schema: { questions: [{ header, question, options:[{label,description}], multiSelect }] }. header must be short and unique.",
      parameters: Type.Object({
        questions: Type.Optional(
          Type.Union([
            Type.Array(Type.Unknown()),
            Type.String()
          ])
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
    },
    {
      name: ENTER_PLAN_TOOL_NAME,
      label: ENTER_PLAN_TOOL_NAME,
      description: "Switch to plan mode (read-only planning workflow).",
      parameters: Type.Object({
        reason: Type.Optional(Type.String()),
        goal: Type.Optional(Type.String())
      }, { additionalProperties: true }),
      async execute(_toolCallId, args) {
        const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        return toTextResult({
          ok: true,
          mode: "plan",
          reason: toReadableString(input.reason) || toReadableString(input.goal) || "enter_plan_mode"
        });
      }
    },
    {
      name: EXIT_PLAN_TOOL_NAME,
      label: EXIT_PLAN_TOOL_NAME,
      description: "Persist the generated plan markdown into plans/plan.md",
      parameters: Type.Object({
        plan: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        markdown: Type.Optional(Type.String()),
        text: Type.Optional(Type.String())
      }, { additionalProperties: true }),
      async execute(_toolCallId, args) {
        const planText = extractPlanText(args);
        if (!planText) {
          throw new Error("ExitPlanMode 未提供可保存的计划内容");
        }
        const planPath = persistExitPlan(params.agentCwd, planText);
        return toTextResult({
          ok: true,
          planPath
        });
      }
    }
  ];
}

export const __testing = {
  sanitizeAskUserQuestionInput,
  normalizeAskUserQuestions
};
