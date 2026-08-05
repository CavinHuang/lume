/**
 * Suggestion Analyst — 工作模式分析器（Phase B 方向 2）
 *
 * 从规则引擎的"明确信号触发"进化到"隐含模式发现"：
 * - 规则引擎（rules.ts）：用户明确说"以后不要 X / 明天继续" → 立即建议
 * - 分析器（本文件）：低频（每日/手动）用 LLM 分析近期记忆，
 *   识别重复出现的工作模式（SOP 候选 / 重复检查 / 待沉淀偏好），
 *   输出 schema 校验过的建议候选，写入 suggestions 复用三态反馈。
 *
 * 设计（蓝图 §7.4 第二阶段）：
 * - 输入经过截断与脱敏（只取记忆条目摘要，不含完整会话）
 * - 主进程只接受 schema 校验通过、duplicateKey 合法的候选
 * - LLM 不能直接创建 Schedule/Monitor，只能提出候选
 *
 * 1:1 移植自 Proma `apps/electron/src/main/lib/suggest/analyst.ts` (PR proma-ai/Proma#1409)。
 *
 * Lume 适配（相对 Proma 源）：
 * 1. LLM 调用：Proma 用自家 `callLlm`（`MEMORY_LLM_*` env）；Lume 复用 memory-v2
 *    的模型解析链（`resolveMemoryExtractionModelRefs` → `resolveChannelModelBinding`
 *    → `createLazyConnectionLlmProvider`），不引入新 env。temperature 未在 SDK
 *    `CreateMessageParams` 暴露，已丢弃（见 task-7-report concerns）。timeout 用
 *    `AbortSignal.timeout(60_000)` 实现。
 * 2. 输入构建：`runAnalysis` 接收预构建 `context`（`buildAnalysisInput` 产出），
 *    便于测试注入；persona 段注入（周期 2 完成，readPersonaRaw→parsePersonaProfile）。
 * 3. 长度上限：Proma 超长直接 reject；Lume 改为**截断后接受**（更宽容，少丢候选）。
 * 4. memory entries：Lume 用 `listEntries`（kind 来自 frontmatter.kind，statement 字段），
 *    包含所有 kind（Lume 无 todo_context；state 亦有模式发现价值，全部包含）。
 */

import { type ApiType, type LLMProvider } from "@lume/agent-sdk";
import type { SuggestionCandidate, SuggestionKind } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { listEntries, listPending, readActivation } from "../memory-v2/markdown-store";
import { parsePersonaProfile, readPersonaRaw } from "../memory-v2/persona";
import { resolveMemoryExtractionModelRefs } from "../memory-v2/extraction";
import { listAutomationJobs } from "../automation/automation-manager";
import type { MemoryV2Scope } from "../memory-v2/types";

/** 分析器允许产出的建议类型（保守：只产出规则引擎也能处理、有明确动作的类型） */
export const ALLOWED_KINDS: SuggestionKind[] = ["automation", "skill", "todo"];

/** 单次分析最多产出的候选数 */
export const MAX_CANDIDATES = 3;

/** LLM 参数：maxTokens / timeoutMs（temperature 未在 SDK 暴露，见模块注释） */
const ANALYST_MAX_TOKENS = 4096;
const ANALYST_TIMEOUT_MS = 60_000;

/** 分析器系统提示（识别 4 类模式 + 严格 JSON 数组输出约束） */
const ANALYST_PROMPT = `你是一位工作模式分析助手。请分析用户的长期记忆，发现**重复出现的工作模式**，并给出可执行的建议。

输入：
- 近期记忆条目（fact/preference/correction/sop/todo_context 类型）
- 用户画像（persona）
- 已生效的行为纠正规则
- 已存在的定时任务名称（避免重复推荐）

任务：
1. 识别**重复模式**：同一类操作反复出现（如"每次发版前检查清单""每周要手动汇总"）
2. 识别**可沉淀的流程**（SOP）：多步骤操作重复 ≥2 次
3. 识别**值得自动化的日常**：定期/周期性工作
4. 识别**待确认的偏好**：用户反复表达但未固化的规则

输出格式（严格 JSON 数组，不要输出其他内容）：
[
  {
    "kind": "automation" | "skill" | "todo",
    "title": "简短标题（≤20 字）",
    "reason": "建议理由（一句，解释为什么值得做）",
    "evidence": "证据（基于哪些记忆条目）",
    "duplicateKey": "去重键（如 automation:每周发版检查）",
    "action": {
      "type": "open_automation_create" | "open_skill_creator" | "open_memory_board",
      "automationTitle": "（automation 类型）建议的定时任务标题",
      "suggestedPrompt": "（automation 类型）定时任务执行提示词",
      "topic": "（skill 类型）Skill 主题"
    }
  }
]

约束：
- 只输出确有证据的模式，不确定就输出 []
- 不要重复已有定时任务（见输入）
- kind=automation 时 action.type=open_automation_create；kind=skill 时 open_skill_creator；kind=todo 时 open_memory_board
- 每个候选必须能回答"为什么现在值得做"
`;

/** 字段长度上限（超长由 validateAnalystCandidate 截断） */
const LIMITS = {
  title: 40,
  reason: 200,
  evidence: 200,
  duplicateKey: 200,
  automationTitle: 100,
  suggestedPrompt: 1000,
  topic: 100,
} as const;

/** 分析器输出（LLM 原始响应解析前） */
interface AnalystRawCandidate {
  kind?: string;
  title?: unknown;
  reason?: unknown;
  evidence?: unknown;
  duplicateKey?: unknown;
  action?: {
    type?: string;
    automationTitle?: unknown;
    suggestedPrompt?: unknown;
    topic?: unknown;
    [key: string]: unknown;
  };
}

/** 分析器 provider 工厂（与 memory-v2 同形：测试可注入） */
type AnalysisProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

/** runAnalysis 输入 */
export interface AnalysisInput {
  /** 预构建的分析上下文（来自 buildAnalysisInput）。必需，空则跳过 */
  context: string;
  /** workspace slug（用于模型配置解析） */
  workspaceSlug?: string;
  /** 模型引用覆盖（优先级最高） */
  modelRef?: string;
  /** 兜底模型引用列表 */
  fallbackModelRefs?: string[];
  /** 可注入的 provider 工厂（测试用） */
  createProvider?: AnalysisProviderFactory;
}

/** buildAnalysisInput 选项 */
export interface BuildAnalysisInputOptions {
  workspaceSlug?: string;
}

/**
 * 构建分析输入摘要。
 * - recent memory-v2 entries：listEntries(active)，slice 60→40，statement slice(0,100)，`[kind]` 前缀
 * - active corrections：tag 含 "correction" 的 entries + pending，top 5
 * - automation names：listAutomationJobs().name
 * - persona：readPersonaRaw → parsePersonaProfile → 注入 summary + preferences.slice(0,8)
 *   （周期 2 完成；persona 不存在/读取失败 → fail-open 跳过该段）
 */
export function buildAnalysisInput(opts: BuildAnalysisInputOptions = {}): string {
  const sections: string[] = [];

  // 近期记忆条目（activation.analyst=false 排除，Task 3）
  let entries: ReturnType<typeof listEntries> = [];
  try {
    entries = listEntries({
      workspaceSlug: opts.workspaceSlug,
      includeStatuses: ["active"],
    }).filter((entry) => readActivation(entry.frontmatter).analyst);
  } catch {
    entries = [];
  }
  const recent = entries.slice(0, 60).slice(0, 40);
  if (recent.length > 0) {
    sections.push("近期记忆条目：");
    for (const entry of recent) {
      const kind = entry.frontmatter.kind ?? "unknown";
      const content = (entry.statement ?? "").slice(0, 100);
      sections.push(`- [${kind}] ${content}`);
    }
  }

  // 已生效行为规则（correction tag）
  try {
    const pending = listPending({
      workspaceSlug: opts.workspaceSlug,
      includeStatuses: ["open"],
    });
    const fromEntries = entries
      .filter((e) => e.frontmatter.tags?.includes("correction"))
      .map((e) => e.statement);
    const fromPending = pending
      .filter((p) => p.frontmatter.candidate?.tags?.includes("correction"))
      .map((p) => p.frontmatter.candidate?.statement ?? "")
      .filter(Boolean);
    const rules = [...fromEntries, ...fromPending].slice(0, 5);
    if (rules.length > 0) {
      sections.push("\n已生效行为规则：");
      for (const rule of rules) sections.push(`- ${rule}`);
    }
  } catch {
    // fail-open：corrections 段省略
  }

  // 已有定时任务
  try {
    const automations = listAutomationJobs().map((a) => a.name).filter(Boolean);
    if (automations.length > 0) {
      sections.push(`\n已有定时任务：${automations.join("、")}`);
    }
  } catch {
    // fail-open：automation 段省略
  }

  // 用户画像（persona）：周期 2 完成，readPersonaRaw → parsePersonaProfile → 注入 summary + preferences
  try {
    const scope: MemoryV2Scope = opts.workspaceSlug ? "workspace" : "global";
    const raw = readPersonaRaw(scope, opts.workspaceSlug);
    if (raw !== null) {
      const profile = parsePersonaProfile(raw);
      const personaLines: string[] = [];
      if (profile.summary && profile.summary.trim().length > 0) {
        personaLines.push(`定位：${profile.summary.trim()}`);
      }
      const prefs = profile.preferences.slice(0, 8).filter((p) => p.trim().length > 0);
      if (prefs.length > 0) {
        personaLines.push("长期偏好：");
        for (const p of prefs) personaLines.push(`- ${p.trim()}`);
      }
      if (personaLines.length > 0) {
        sections.push("\n用户画像（persona）：");
        sections.push(...personaLines);
      }
    }
  } catch {
    // fail-open：persona 段省略（不得阻塞分析）
  }

  return sections.length > 0 ? sections.join("\n") : "（暂无记忆）";
}

/** 解析 LLM 输出为候选数组（围栏剥离 + 区间提取 + Array.isArray） */
export function parseAnalystResponse(raw: string): AnalystRawCandidate[] {
  if (!raw || raw.trim().length === 0) return [];
  // 剥离 markdown 围栏
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();
  // 找第一个 [ 到最后一个 ]
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  const jsonText = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AnalystRawCandidate => !!item && typeof item === "object",
    ) as AnalystRawCandidate[];
  } catch {
    return [];
  }
}

/**
 * 安全字符串化：LLM 可能返回非字符串字段（数组/对象/数字），统一转字符串；
 * 无法转为有效字符串返回 null。
 */
function safeStr(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 0 ? s : null;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  }
  if (Array.isArray(v)) {
    // 数组 → 取首个字符串元素（LLM 可能把 evidence 输出成数组）
    for (const item of v) {
      const s = safeStr(item);
      if (s) return s;
    }
    return null;
  }
  return null;
}

/** 截断到指定长度 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * schema 校验单条候选：kind 合法、字段非空、长度截断、kind-action 匹配、默认 rawConfidence。
 * 接收 `unknown`（schema gate：LLM 输出任意形状）。返回 null 表示不通过。
 */
export function validateAnalystCandidate(raw: unknown): SuggestionCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as AnalystRawCandidate;
  const kind = r.kind;
  if (typeof kind !== "string" || !ALLOWED_KINDS.includes(kind as SuggestionKind)) {
    return null;
  }

  const title = safeStr(r.title);
  const reason = safeStr(r.reason);
  const evidence = safeStr(r.evidence);
  const duplicateKey = safeStr(r.duplicateKey);
  if (!title || !reason || !evidence || !duplicateKey) return null;

  // 长度截断（Lume 偏离 Proma：截断而非 reject）
  const tTitle = truncate(title, LIMITS.title);
  const tReason = truncate(reason, LIMITS.reason);
  const tEvidence = truncate(evidence, LIMITS.evidence);
  const tDup = truncate(duplicateKey, LIMITS.duplicateKey);

  // 动作校验
  const action = r.action;
  const actionType = action?.type;
  if (!actionType) return null;

  if (kind === "automation") {
    if (actionType !== "open_automation_create") return null;
    const automationTitle = safeStr(action?.automationTitle);
    const suggestedPrompt = safeStr(action?.suggestedPrompt);
    if (!automationTitle || !suggestedPrompt) return null;
    return {
      kind,
      title: tTitle,
      reason: tReason,
      evidence: tEvidence,
      duplicateKey: tDup,
      rawConfidence: 0.7, // LLM 分析产出的候选默认中等置信（需用户确认）
      action: {
        type: "open_automation_create",
        automationTitle: truncate(automationTitle, LIMITS.automationTitle),
        suggestedPrompt: truncate(suggestedPrompt, LIMITS.suggestedPrompt),
      },
    };
  }
  if (kind === "skill") {
    if (actionType !== "open_skill_creator") return null;
    const topic = safeStr(action?.topic);
    if (!topic) return null;
    return {
      kind,
      title: tTitle,
      reason: tReason,
      evidence: tEvidence,
      duplicateKey: tDup,
      rawConfidence: 0.65,
      action: { type: "open_skill_creator", topic: truncate(topic, LIMITS.topic) },
    };
  }
  if (kind === "todo") {
    if (actionType !== "open_memory_board") return null;
    return {
      kind,
      title: tTitle,
      reason: tReason,
      evidence: tEvidence,
      duplicateKey: tDup,
      rawConfidence: 0.6,
      action: { type: "open_memory_board" },
    };
  }
  return null;
}

/** 校验并过滤候选数组：duplicateKey 去重 + slice MAX_CANDIDATES */
export function validateAnalystCandidates(
  raws: readonly unknown[],
): SuggestionCandidate[] {
  const result: SuggestionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of raws) {
    const candidate = validateAnalystCandidate(item);
    if (!candidate) continue;
    if (seen.has(candidate.duplicateKey)) continue;
    seen.add(candidate.duplicateKey);
    result.push(candidate);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

/**
 * 运行工作模式分析（LLM），返回合法候选（fail-open：无配置/失败返回空）。
 *
 * 模型解析复用 memory-v2 链：`memory.extraction.modelRef` →
 * `memory.extractionModelRef` → `models.agent.fallbackModelRefs`。
 */
export async function runAnalysis(input: AnalysisInput): Promise<SuggestionCandidate[]> {
  if (!input.context || input.context.trim().length === 0) return [];
  try {
    const config = getEffectiveLumeConfig(input.workspaceSlug);
    const modelRefs = resolveMemoryExtractionModelRefs(config, {
      modelRef: input.modelRef,
      fallbackModelRefs: input.fallbackModelRefs,
    });
    if (modelRefs.length === 0) return [];

    for (const modelRef of modelRefs) {
      try {
        const response = await callAnalystWithModel({
          modelRef,
          context: input.context,
          createProvider: input.createProvider,
        });
        if (response === undefined) continue; // binding 不存在 / provider 未配置
        const parsed = parseAnalystResponse(response);
        return validateAnalystCandidates(parsed);
      } catch {
        continue; // 该 model 失败，尝试下一个
      }
    }
    return [];
  } catch (error) {
    console.warn(
      "[Analyst] 工作模式分析失败:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/** 单模型调用：解析 binding + 创建 provider + 发起 createMessage */
async function callAnalystWithModel(input: {
  modelRef: string;
  context: string;
  createProvider?: AnalysisProviderFactory;
}): Promise<string | undefined> {
  const binding = resolveChannelModelBinding(input.modelRef, "chat");
  if (!binding && !input.createProvider) return undefined;

  const provider = createAnalysisProvider({
    modelRef: input.modelRef,
    binding,
    createProvider: input.createProvider,
  });

  const response = await provider.createMessage({
    model: binding?.modelId ?? input.modelRef.split("/").at(-1) ?? input.modelRef,
    maxTokens: ANALYST_MAX_TOKENS,
    system: ANALYST_PROMPT,
    messages: [{ role: "user", content: input.context }],
    abortSignal: AbortSignal.timeout(ANALYST_TIMEOUT_MS),
  });

  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 创建分析 provider（复用 memory-v2 createMemoryExtractionProvider 逻辑） */
function createAnalysisProvider(input: {
  modelRef: string;
  binding: ReturnType<typeof resolveChannelModelBinding>;
  createProvider?: AnalysisProviderFactory;
}): LLMProvider {
  if (!input.createProvider && input.binding) {
    return createLazyConnectionLlmProvider({
      connectionId: input.binding.channel.id,
      modelId: input.binding.modelId,
    });
  }
  return input.createProvider!({
    apiType: input.binding
      ? resolveAnalysisApiType(input.binding.channel.provider)
      : "openai-completions",
    apiKey: input.binding ? decryptApiKey(input.binding.channel.id) : "",
    baseURL: input.binding?.channel.baseUrl,
  });
}

function resolveAnalysisApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}
