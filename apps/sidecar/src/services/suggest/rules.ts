/**
 * Suggestion 确定性规则 — 把信号转成建议候选
 *
 * 1:1 移植自 Proma `apps/electron/src/main/lib/suggest/rules.ts` (PR proma-ai/Proma#1409)。
 * 5 类规则：
 * - correction：用户纠正 → 记住这个纠正（动作：写入 memory correction）
 * - followup：时间表达 → 创建跟进提醒（动作：打开 automation 创建）
 * - automation：重复行为/周期需求 → 建议开启定时任务
 * - repeat：同一意图 ≥2 次 → 建议定期自动化
 * - todo：明确未完成任务 → 建议创建 Todo
 *
 * 全部只读本地确定性信号，不依赖 LLM。
 *
 * Lume 适配（相对 Proma 源）：
 * 1. 入参形状：Proma 的 applyRules 接收 `userMessages: string[]` 内部调 extractSignals；
 *    Lume 改为接收已抽取的 `signals: Signal[]`（Task 3 输出），规则层不再做抽取。
 * 2. negative 信号：Proma 在 extractSignals 内 `continue` 静默丢弃；Lume 暴露 negative 信号，
 *    本规则层的 default 分支自然忽略（engine 层负责"最近拒绝词"门判断）。
 * 3. dedup 源：Proma 读自家 automation/corrections/sop；Lume 的 loadDedupContext 桥接到
 *    automation-manager.listAutomationJobs + memory-v2 markdown-store。
 * 4. 输出形状：Proma 返回 `{candidate}[]`（RuleMatch 包装）；Lume 直接返回 SuggestionCandidate[]
 *    以匹配 brief 契约（engine 直接消费扁平候选）。
 */

import type { SuggestionCandidate } from "@lume/shared";
import type { Signal } from "./signals";
import { isMeaningfulRule, normalizeRule } from "./signals";
import { listAutomationJobs } from "../automation/automation-manager";
import { listEntries, listPending } from "../memory-v2/markdown-store";

/** SOP 候选数量阈值：达到后建议沉淀为 Skill */
export const SOP_CANDIDATE_THRESHOLD = 3;

/** 重复行为阈值：同一意图 ≥2 次建议 automation */
export const REPEAT_THRESHOLD = 2;

/** applyRules 输入上下文 */
export interface ApplyRulesContext {
  /** Task 3 extractSignals 已抽取的信号 */
  signals: Signal[];
  /** 已有 automation 任务标题（去重用） */
  automationTitles: string[];
  /** 已有 correction 规则文本（去重用，containment 判断） */
  correctionRules: string[];
  /**
   * SOP/state 候选计数。applyRules 本身不使用（skill 候选由 buildSkillCandidate
   * 单独生成，engine 在后处理合并）；此字段由 ctx 透传便于 engine 统一装配上下文。
   */
  sopCandidateCount: number;
}

/** loadDedupContext 输入 */
export interface DedupContextInput {
  workspaceSlug?: string;
}

/** loadDedupContext 输出 */
export interface DedupContext {
  automationTitles: string[];
  correctionRules: string[];
  sopCandidateCount: number;
}

/**
 * 执行规则集：从信号 + 上下文生成建议候选。
 * 逐信号映射，去重命中即跳过（不做全局合并，留给 engine）。
 */
export function applyRules(ctx: ApplyRulesContext): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  for (const signal of ctx.signals) {
    const candidate = signalToCandidate(signal, ctx);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** 单条信号 → 候选（verbatim 移植 Proma signalToCandidate；去重交给 engine 兜底） */
function signalToCandidate(signal: Signal, ctx: ApplyRulesContext): SuggestionCandidate | undefined {
  switch (signal.kind) {
    case "correction": {
      const rule = normalizeRule(signal.raw);
      // 无意义规则（"这样"/"再说"）不产生建议
      if (!isMeaningfulRule(rule)) return undefined;
      // 去重：已有相同/相似 correction 规则不再建议（containment 双向判断）
      const existing = ctx.correctionRules.some((r) => r === rule || r.includes(rule) || rule.includes(r));
      if (existing) return undefined;

      return {
        duplicateKey: `correction:${rule.slice(0, 30)}`,
        kind: "correction",
        title: "记住这个纠正",
        reason: "你刚刚纠正了 Agent 的行为，建议把这条规则写入长期记忆，以后不再犯同样的错。",
        evidence: signal.raw,
        rawConfidence: signal.confidence,
        action: {
          type: "memory_correction",
          raw: signal.raw,
          rule,
        },
      };
    }

    case "followup": {
      return {
        duplicateKey: `followup:${signal.raw.slice(0, 24)}`,
        kind: "followup",
        title: "创建跟进提醒",
        reason: "你提到了稍后继续，建议创建一个跟进提醒，到时间自动提示你继续这个任务。",
        evidence: signal.raw,
        rawConfidence: signal.confidence,
        action: {
          type: "open_automation_create",
          automationTitle: "跟进提醒",
          suggestedPrompt: `提醒我：${signal.raw}`,
        },
      };
    }

    case "automation": {
      // 去重：已有同类 automation 任务不再建议
      const title = automationTitleFromRaw(signal.raw);
      const existing = ctx.automationTitles.some(
        (t) => t === title || t.includes(title) || title.includes(t),
      );
      if (existing) return undefined;

      return {
        duplicateKey: `automation:${title}`,
        kind: "automation",
        title: "开启定时任务",
        reason: "你表达的是周期性/长期关注的需求，建议创建一个定时任务，让 Agent 无人值守地自动处理。",
        evidence: signal.raw,
        rawConfidence: signal.confidence,
        action: {
          type: "open_automation_create",
          automationTitle: title,
          suggestedPrompt: `${title}（定期自动执行）`,
        },
      };
    }

    case "repeat": {
      if (signal.count < REPEAT_THRESHOLD) return undefined;
      const title = `定期${signal.intent}`;
      const existing = ctx.automationTitles.some(
        (t) => t === title || t.includes(signal.intent) || signal.intent.includes(t),
      );
      if (existing) return undefined;

      return {
        duplicateKey: `automation:${title}`,
        kind: "automation",
        title: "把重复操作变成定时任务",
        reason: `你在本次会话中${signal.count}次要求"${signal.intent}"，建议创建一个定时任务自动完成，省去重复操作。`,
        evidence: `重复出现 ${signal.count} 次："${signal.intent}"`,
        rawConfidence: signal.confidence,
        action: {
          type: "open_automation_create",
          automationTitle: title,
          suggestedPrompt: `定期执行：${signal.intent}`,
        },
      };
    }

    case "todo": {
      return {
        duplicateKey: `todo:${signal.raw.slice(0, 20)}`,
        kind: "todo",
        title: "把未完成任务记下来",
        reason: "你提到了未完成的事项，建议创建一个 Todo 记录，避免遗漏。",
        evidence: signal.raw,
        rawConfidence: signal.confidence,
        action: {
          type: "open_memory_board",
        },
      };
    }

    // Lume 适配：negative 信号（用户明确拒绝）由 engine 层做"最近拒绝词"门判断，
    // 规则层不产生候选。
    default:
      return undefined;
  }
}

/** SOP 候选 → Skill 建议（由 engine 在候选后处理中调用） */
export function buildSkillCandidate(sopCount: number): SuggestionCandidate | undefined {
  if (sopCount < SOP_CANDIDATE_THRESHOLD) return undefined;
  return {
    duplicateKey: `skill:sop-candidates`,
    kind: "skill",
    title: "把常用流程沉淀为 Skill",
    reason: `长期记忆中已积累 ${sopCount} 条可复用流程（SOP），建议把它们整理成 Skill，以后一句话即可复用。`,
    evidence: `${sopCount} 条 SOP 候选`,
    rawConfidence: 0.75,
    action: {
      type: "open_skill_creator",
      topic: "SOP 流程沉淀",
    },
  };
}

/**
 * 从自动化信号原始文本提炼任务标题（verbatim 移植 Proma）。
 * 剥离句首周期词 / 请求词 / 盯类动词 / 尾标点；超长截断到 24 字；
 * 全被剥光时回退到原文前 20 字。
 */
export function automationTitleFromRaw(raw: string): string {
  let title = raw
    .replace(/^(每天自动|每天都要|每天|每周|每月|定期)/, "")
    .replace(/^(帮我|请|麻烦|能不能|可以)/, "")
    .replace(/(帮我)?(盯|关注|跟进|监控|检查)(一下)?/, "")
    .replace(/[，。！？\n]+$/, "")
    .trim();
  if (!title) title = raw.slice(0, 20);
  return title.length > 24 ? title.slice(0, 24) : title;
}

/**
 * 桥接 Lume 去重源（fail-open：任一源失败 → 该源空，不抛错）。
 *
 * Lume API 映射（spec §"Lume adaptation — dedup sources"）：
 * - automationTitles：`listAutomationJobs().map(j => j.name)`（automation-manager.ts:94）
 * - correctionRules：memory-v2 中带 `correction` tag 的 entry/pending statement
 *   （markdown-store.ts:listEntries/listPending）。最简合理映射：tag 含 "correction"。
 * - sopCandidateCount：memory-v2 中 `kind === "state"` 的 active entry 计数
 *   （spec: Proma sop → Lume state）。
 *
 * 顾虑（flagged）：correction tag 的精确语义在 memory-v2 中没有强约束（tags 是自由字符串数组），
 * 此处采用"tag 包含 correction 字面量"的最简判断；若后续 memory-v2 引入结构化 correction kind，
 * 应改用结构化字段。
 */
export function loadDedupContext(input: DedupContextInput = {}): DedupContext {
  const workspaceSlug = input.workspaceSlug;

  // automation 标题
  let automationTitles: string[] = [];
  try {
    automationTitles = listAutomationJobs().map((j) => j.name);
  } catch {
    automationTitles = [];
  }

  // memory-v2 entries（active）+ pending（open）：correction 规则 + sop/state 计数
  let correctionRules: string[] = [];
  let sopCandidateCount = 0;
  try {
    const entries = listEntries({ workspaceSlug, includeStatuses: ["active"] });
    const pending = listPending({ workspaceSlug, includeStatuses: ["open"] });

    const fromEntries = entries
      .filter((e) => e.frontmatter.tags.includes("correction"))
      .map((e) => e.statement);
    const fromPending = pending
      .filter((p) => p.frontmatter.candidate.tags?.includes("correction"))
      .map((p) => p.frontmatter.candidate.statement);
    correctionRules = [...fromEntries, ...fromPending];

    sopCandidateCount = entries.filter((e) => e.frontmatter.kind === "state").length;
  } catch {
    correctionRules = [];
    sopCandidateCount = 0;
  }

  return { automationTitles, correctionRules, sopCandidateCount };
}
