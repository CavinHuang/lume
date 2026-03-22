import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest
} from "@lume/shared";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { waitForPiAskUserQuestionAnswers } from "./ask-user-question-bridge";
import { randomBytes } from "node:crypto";

const EXIT_PLAN_TOOL_NAME = "ExitPlanMode";
const ENTER_PLAN_TOOL_NAME = "EnterPlanMode";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 4;

// ============ 随机 Slug 生成器 ============
// 参考 Claude Code SDK 的命名规则

const ADJECTIVES = [
  "ancient", "bright", "calm", "clever", "cosmic", "crisp", "curious", "dapper",
  "dazzling", "deep", "eager", "elegant", "enchanted", "fancy", "gentle", "golden",
  "happy", "hidden", "humble", "jolly", "joyful", "keen", "kind", "lively",
  "lovely", "lucky", "magical", "majestic", "mellow", "merry", "mighty", "misty",
  "noble", "peaceful", "playful", "proud", "quiet", "quirky", "radiant", "serene",
  "shiny", "swift", "tender", "tidy", "tranquil", "valiant", "vast", "vivid",
  "warm", "whimsical", "wild", "wise", "witty", "wondrous", "zesty", "zippy"
];

const VERBS = [
  "baking", "beaming", "bouncing", "brewing", "bubbling", "chasing", "conjuring",
  "cooking", "crafting", "crunching", "dancing", "dazzling", "discovering", "dreaming",
  "drifting", "enchanting", "exploring", "finding", "floating", "gathering", "giggling",
  "gliding", "growing", "hatching", "hopping", "hugging", "humming", "imagining",
  "inventing", "jingling", "juggling", "jumping", "mapping", "mixing", "moseying",
  "napping", "noodling", "orbiting", "painting", "pondering", "popping", "prancing",
  "purring", "puzzling", "questing", "riding", "roaming", "rolling", "singing",
  "skipping", "sleeping", "snacking", "soaring", "spinning", "splashing", "stargazing",
  "stirring", "strolling", "swimming", "swinging", "tickling", "tinkering", "tumbling",
  "twirling", "waddling", "wandering", "watching", "weaving", "whistling", "wishing",
  "wobbling", "wondering", "zooming"
];

const NOUNS = [
  "aurora", "avalanche", "blossom", "breeze", "brook", "bubble", "canyon", "cascade",
  "cloud", "clover", "comet", "coral", "cosmos", "creek", "crystal", "dawn", "dusk",
  "eclipse", "ember", "feather", "fern", "firefly", "flame", "flurry", "fog", "forest",
  "frost", "galaxy", "garden", "glacier", "glade", "grove", "harbor", "horizon",
  "island", "lagoon", "lake", "leaf", "meadow", "meteor", "mist", "moon", "moonbeam",
  "mountain", "nebula", "nova", "ocean", "orbit", "pebble", "petal", "pine", "planet",
  "pond", "quasar", "rain", "rainbow", "reef", "ripple", "river", "shore", "sky",
  "snowflake", "spark", "spring", "star", "stardust", "starlight", "storm", "stream",
  "summit", "sun", "sunbeam", "sunrise", "sunset", "thunder", "tide", "twilight",
  "valley", "volcano", "waterfall", "wave", "willow", "wind"
];

function generatePlanSlug(): string {
  const rand = randomBytes(3);
  const adjective = ADJECTIVES[(rand[0] ?? 0) % ADJECTIVES.length] ?? "cosmic";
  const verb = VERBS[(rand[1] ?? 0) % VERBS.length] ?? "drifting";
  const noun = NOUNS[(rand[2] ?? 0) % NOUNS.length] ?? "aurora";
  return `${adjective}-${verb}-${noun}`;
}

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
- Put recommended option first with "(推荐)" suffix in label
- Do NOT use this tool to ask "是否执行计划" - use ExitPlanMode instead`;

const ENTER_PLAN_MODE_PROMPT = `Use this tool proactively before non-trivial implementation work.

When to use EnterPlanMode:
1. New feature implementation
2. Multiple valid approaches
3. Architectural or trade-off decisions
4. Multi-file changes
5. Unclear scope that needs exploration first

When NOT to use EnterPlanMode:
1. Single-line/small obvious fix
2. Purely informational or exploratory request
3. User provided very specific step-by-step edits

After entering plan mode:
- Keep work read-only
- Explore code and form an implementation plan
- Use AskUserQuestion only for requirement clarification if needed
- Finish by calling ExitPlanMode for user approval`;

const EXIT_PLAN_MODE_PROMPT = `Use this tool only after a complete, unambiguous implementation plan is ready.

Before calling ExitPlanMode:
1. Ensure plan steps are concrete and executable
2. Ensure unclear requirements are resolved (AskUserQuestion earlier if needed)
3. Ensure no pending ambiguity remains

Important:
- Do NOT ask user "是否执行计划" via AskUserQuestion
- ExitPlanMode itself is the plan approval handoff
- allowedPrompts should describe semantic command categories needed for implementation`;

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

function stripFrontMatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) return content;
  return content.slice(match[0].length);
}

/**
 * 计划元数据接口
 */
interface PlanFrontMatter {
  summary?: string;
  created: string;
  slug: string;
  estimatedFiles?: number;
  estimatedLines?: number;
}

function persistExitPlan(
  agentCwd: string,
  planText: string,
  options?: {
    summary?: string;
    estimatedFiles?: number;
    estimatedLines?: number;
  }
): { planPath: string; slug: string } {
  const plansDir = join(agentCwd, "plans");
  mkdirSync(plansDir, { recursive: true });

  // 生成随机 slug
  const slug = generatePlanSlug();
  const planFileName = `${slug}.md`;
  const planPath = join(plansDir, planFileName);

  // 构建 YAML front matter
  const frontMatter: PlanFrontMatter = {
    created: new Date().toISOString(),
    slug
  };

  if (options?.summary) {
    frontMatter.summary = options.summary;
  }
  if (options?.estimatedFiles !== undefined) {
    frontMatter.estimatedFiles = options.estimatedFiles;
  }
  if (options?.estimatedLines !== undefined) {
    frontMatter.estimatedLines = options.estimatedLines;
  }

  // 格式化 front matter
  const frontMatterLines = ["---"];
  for (const [key, value] of Object.entries(frontMatter)) {
    if (typeof value === "string") {
      // 转义包含特殊字符的字符串
      const escaped = value.includes(":") || value.includes('"') || value.includes("\n")
        ? `"${value.replace(/"/g, '\\"')}"`
        : value;
      frontMatterLines.push(`${key}: ${escaped}`);
    } else {
      frontMatterLines.push(`${key}: ${value}`);
    }
  }
  frontMatterLines.push("---", "");

  const content = `${frontMatterLines.join("\n")}${planText.endsWith("\n") ? planText : `${planText}\n`}`;

  writeFileSync(planPath, content, "utf-8");

  // 同时更新 plan.md 作为最新计划
  const latestPlanPath = join(plansDir, "plan.md");
  writeFileSync(latestPlanPath, content, "utf-8");

  return { planPath, slug };
}

// ============ 计划恢复机制 ============

/**
 * 解析计划文件的 YAML front matter
 */
export function parsePlanFrontMatter(content: string): {
  frontMatter: Partial<PlanFrontMatter> | null;
  body: string;
} {
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontMatterMatch) {
    return { frontMatter: null, body: content };
  }

  const frontMatterText = frontMatterMatch[1];
  if (!frontMatterText) {
    return { frontMatter: null, body: content.slice(frontMatterMatch[0].length) };
  }

  const body = content.slice(frontMatterMatch[0].length);
  const frontMatter: Partial<PlanFrontMatter> = {};

  // 简单的 YAML 解析（仅支持键值对）
  const lines = frontMatterText.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string | number = line.slice(colonIndex + 1).trim();

    // 处理引号包裹的字符串
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }

    // 转换数字
    if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }

    if (key === "summary" && typeof value === "string") {
      frontMatter.summary = value;
    } else if (key === "created" && typeof value === "string") {
      frontMatter.created = value;
    } else if (key === "slug" && typeof value === "string") {
      frontMatter.slug = value;
    } else if (key === "estimatedFiles" && typeof value === "number") {
      frontMatter.estimatedFiles = value;
    } else if (key === "estimatedLines" && typeof value === "number") {
      frontMatter.estimatedLines = value;
    }
  }

  return { frontMatter, body };
}

/**
 * 尝试从文件系统恢复计划
 */
export function tryRecoverPlanFromFile(agentCwd: string, slug?: string): {
  success: boolean;
  planPath: string | null;
  planContent: string | null;
  frontMatter: Partial<PlanFrontMatter> | null;
} {
  const plansDir = join(agentCwd, "plans");

  // 优先尝试指定的 slug
  if (slug) {
    const slugPath = join(plansDir, `${slug}.md`);
    try {
      const content = readFileSync(slugPath, "utf-8");
      const { frontMatter, body } = parsePlanFrontMatter(content);
      return { success: true, planPath: slugPath, planContent: body, frontMatter };
    } catch {
      // 文件不存在，继续尝试其他方式
    }
  }

  // 尝试读取最新的 plan.md
  const latestPlanPath = join(plansDir, "plan.md");
  try {
    const content = readFileSync(latestPlanPath, "utf-8");
    const { frontMatter, body } = parsePlanFrontMatter(content);
    return { success: true, planPath: latestPlanPath, planContent: body, frontMatter };
  } catch {
    // plan.md 不存在
  }

  return { success: false, planPath: null, planContent: null, frontMatter: null };
}

export function createPiControlTools(params: {
  sessionId: string;
  agentCwd: string;
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

  tools.push({
      name: ENTER_PLAN_TOOL_NAME,
      label: ENTER_PLAN_TOOL_NAME,
      description: ENTER_PLAN_MODE_PROMPT,
      parameters: Type.Object({
        reason: Type.Optional(Type.String({
          description: "Brief explanation of why planning mode is needed"
        })),
        goal: Type.Optional(Type.String({
          description: "The goal or objective to plan for"
        })),
        context: Type.Optional(Type.String({
          description: "Additional context about the task"
        }))
      }, { additionalProperties: true }),
      async execute(_toolCallId, args) {
        const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const reason = toReadableString(input.reason) || toReadableString(input.goal) || "complex_task_planning";
        return toTextResult({
          ok: true,
          mode: "plan",
          reason,
          message: "已进入 Plan 模式。将生成详细的实施计划供您审核。在审核前不会执行任何写操作。",
          context: toReadableString(input.context)
        });
      }
    });

  tools.push({
      name: EXIT_PLAN_TOOL_NAME,
      label: EXIT_PLAN_TOOL_NAME,
      description: EXIT_PLAN_MODE_PROMPT,
      parameters: Type.Object({
        allowedPrompts: Type.Optional(Type.Array(Type.Object({
          tool: Type.String({ description: "Tool name for this prompt (currently only Bash is supported)" }),
          prompt: Type.String({ description: "Semantic action, e.g. run tests/install dependencies" })
        }))),
        pushToRemote: Type.Optional(Type.Boolean()),
        remoteSessionId: Type.Optional(Type.String()),
        remoteSessionUrl: Type.Optional(Type.String()),
        remoteSessionTitle: Type.Optional(Type.String())
      }, { additionalProperties: true }),
      async execute(_toolCallId, args) {
        const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const inlinePlanCandidates = [input.plan, input.content, input.markdown, input.text];
        let planText: string | null = null;
        for (const candidate of inlinePlanCandidates) {
          const parsed = extractPlanText(candidate);
          if (parsed) {
            planText = parsed;
            break;
          }
        }
        if (!planText) {
          const recovered = tryRecoverPlanFromFile(params.agentCwd);
          if (recovered.success && recovered.planContent) {
            planText = stripFrontMatter(recovered.planContent).trim();
          }
        }
        if (!planText) {
          throw new Error("ExitPlanMode 未找到计划内容，请先提供完整 plan 文本");
        }

        const allowedPrompts = Array.isArray(input.allowedPrompts)
          ? input.allowedPrompts
            .map((item) => (item && typeof item === "object" ? item as Record<string, unknown> : null))
            .filter((item): item is Record<string, unknown> => Boolean(item))
            .map((item) => ({
              tool: item.tool === "Bash" ? "Bash" : "Bash",
              prompt: toReadableString(item.prompt)
            }))
            .filter((item) => item.prompt.length > 0)
          : [];

        const { planPath, slug } = persistExitPlan(params.agentCwd, planText);

        return toTextResult({
          ok: true,
          mode: "default",
          planPath,
          slug,
          plan: planText,
          allowedPrompts,
          pushToRemote: input.pushToRemote === true,
          remoteSessionId: toReadableString(input.remoteSessionId) || undefined,
          remoteSessionUrl: toReadableString(input.remoteSessionUrl) || undefined,
          remoteSessionTitle: toReadableString(input.remoteSessionTitle) || undefined,
          message: "计划已完成并提交审核。请确认后进入实现阶段。"
        });
      }
    });

  return tools;
}

export const __testing = {
  sanitizeAskUserQuestionInput,
  normalizeAskUserQuestions
};
