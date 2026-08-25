/**
 * Suggestion 决策引擎 — 候选评分 + 去重 + 频率加权 + 阈值/预算（误报控制）
 *
 * 1:1 移植自 Proma `apps/electron/src/main/lib/suggest/engine.ts` (PR proma-ai/Proma#1409)。
 * 决策流程：
 * 1. 过滤 user 文本（空 → 返回空）
 * 2. 拒绝门：最后一条 user 消息含 NEGATIVE 模式 → 整轮不触发
 * 3. extractSignals + applyRules + buildSkillCandidate 生成候选
 * 4. 去重四连：seenKeys(同会话已建议) / neverKeys(永久屏蔽) / 同次评估 dup / silencedKinds(类型静默)
 * 5. 频率加权：effective = rawConfidence × typeWeight(kind)
 * 6. 阈值过滤：< threshold → suppressed（带原因）
 * 7. 按 effective 降序取 maxPerEvaluation 条
 *
 * Lume 适配（相对 Proma 源）：
 * 1. 纯函数：Proma 接收 `(input, index, opts)` 三参，index 含 store/feedback 持久状态；
 *    Lume 改为 `(messages, opts)` 两参，所有外部状态经 opts 注入（seenKeys/neverKeys/
 *    silencedKinds/typeWeights/dedupContext），engine 不再 import store/feedback。
 *    Task 9 service 负责装配 opts（read store + read feedback → 组装 Set/Map 传入）。
 *    这样 engine 可在隔离环境下单测（brief 契约测试直接传 opts）。
 * 2. 类型权重：Proma 用 index.typeWeights 容忍旧索引；Lume 改为 opts.typeWeights 必填
 *    （service 总是从 store.getTypeWeights() 拿到完整对象），缺字段时回退 1.0。
 * 3. 入参形状：Proma input.messages 接收完整 ChatMessage；Lume 收窄为 {role:"user";content:string}[]。
 * 4. 新增 silencedKinds：Proma 没有按 kind 静默的能力；Lume brief 契约要求"类型静默"为
 *    去重四连之一，对应 feedback 层"不再建议这类"的 kind 级 mute。
 * 5. applyRules 形状：Proma applyRules 返回 RuleMatch[]（包裹 candidate），Lume 直接返回
 *    SuggestionCandidate[]（Task 4 已确定）；engine 不再 `.map(m => m.candidate)`。
 * 6. skill 候选合并：Proma 在 engine 内 buildSkillCandidate 后 push；Lume 同（透传 sopCount）。
 */

import type { SuggestionCandidate, SuggestionKind, SuggestionTypeWeights } from "@lume/shared";
import type { UserMessage } from "./signals";
import { NEGATIVE_PATTERNS, extractSignals } from "./signals";
import { applyRules, buildSkillCandidate } from "./rules";

// ===== 默认参数（verbatim from Proma） =====

export const DEFAULT_SUGGEST_OPTIONS: {
  threshold: number;
  maxPerEvaluation: number;
  maxPerSession: number;
} = {
  /** 置信度阈值：raw × weight ≥ 0.6 才建议 */
  threshold: 0.6,
  /** 单次评估最多 1 条（低频优先，避免连环打扰） */
  maxPerEvaluation: 1,
  /** 同会话最多 2 条 */
  maxPerSession: 2,
};

// ===== opts 形状 =====

/** 去重上下文（service 从 automation-manager / memory-v2 装配） */
export interface DedupContext {
  automationTitles: string[];
  correctionRules: string[];
  /** SOP/state 候选计数，驱动 buildSkillCandidate */
  sopCandidateCount: number;
}

/** engine 求值选项 —— 所有外部状态经此注入（纯函数契约） */
export interface EvaluateOptions {
  /** 类型权重（service 从 store.getTypeWeights() 注入） */
  typeWeights: SuggestionTypeWeights;
  /** 同会话已建议过的 duplicateKey 集合（防重出） */
  seenKeys: Set<string>;
  /** 用户永久屏蔽的 duplicateKey 集合（"不再建议这条"） */
  neverKeys?: Set<string>;
  /** 被静默的类型集合（"不再建议这类"，kind 级 mute） */
  silencedKinds?: Set<SuggestionKind>;
  /** 单会话最多建议条数（默认 2） */
  maxPerSession?: number;
  /** 置信度阈值（默认 0.6） */
  threshold?: number;
  /** 单次评估最多建议条数（默认 1） */
  maxPerEvaluation?: number;
  /** 规则去重上下文（automation/correction/sop，service 装配） */
  dedupContext?: DedupContext;
}

/** engine 输出 */
export interface EvaluationResult {
  candidates: SuggestionCandidate[];
  suppressed: Array<{ candidate: SuggestionCandidate; reason: string }>;
}

// ===== 主入口 =====

/**
 * 评估一组会话消息，生成建议候选（已被频率/去重/预算过滤）。
 *
 * 纯函数：所有外部状态经 opts 注入，engine 内部不 import store/feedback。
 */
export function evaluateSuggestions(
  messages: readonly UserMessage[],
  opts: EvaluateOptions,
): EvaluationResult {
  const suppressed: EvaluationResult["suppressed"] = [];

  // 1. 过滤 user 文本
  const userMessages = messages
    .filter(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0,
    )
    .map((m) => m.content);

  if (userMessages.length === 0) return { candidates: [], suppressed };

  // 2. 拒绝门：最后一条 user 消息含 NEGATIVE → 整轮不触发
  //    （对齐 Proma：re.test(lastUserMsg) 任一命中即整体抑制）
  const lastUserMsg = userMessages[userMessages.length - 1] ?? "";
  if (NEGATIVE_PATTERNS.some((re) => re.test(lastUserMsg))) {
    return { candidates: [], suppressed };
  }

  // 3. 候选生成：extractSignals → applyRules → 补 skill 候选
  const dedup = opts.dedupContext ?? {
    automationTitles: [],
    correctionRules: [],
    sopCandidateCount: 0,
  };
  const filteredMessages = messages.filter((m) => m.role === "user");
  const signals = extractSignals(filteredMessages);
  const ruleCandidates = applyRules({
    signals,
    automationTitles: dedup.automationTitles,
    correctionRules: dedup.correctionRules,
    sopCandidateCount: dedup.sopCandidateCount,
  });
  const candidates: SuggestionCandidate[] = [...ruleCandidates];
  const skillCandidate = buildSkillCandidate(dedup.sopCandidateCount);
  if (skillCandidate) candidates.push(skillCandidate);

  // 4-6. 去重四连 + 频率加权 + 阈值过滤
  const seenKeys = opts.seenKeys;
  const neverKeys = opts.neverKeys ?? new Set<string>();
  const silencedKinds = opts.silencedKinds ?? new Set<SuggestionKind>();
  const threshold = opts.threshold ?? DEFAULT_SUGGEST_OPTIONS.threshold;
  const maxPerEvaluation =
    opts.maxPerEvaluation ?? DEFAULT_SUGGEST_OPTIONS.maxPerEvaluation;

  const dedupSeenInEval = new Set<string>();
  const scored: Array<{ candidate: SuggestionCandidate; effective: number }> = [];

  for (const candidate of candidates) {
    // 同会话去重（已建议过）
    if (seenKeys.has(candidate.duplicateKey)) {
      suppressed.push({ candidate, reason: "同会话已建议过" });
      continue;
    }
    // 永久屏蔽
    if (neverKeys.has(candidate.duplicateKey)) {
      suppressed.push({ candidate, reason: "用户已选择不再建议这类" });
      continue;
    }
    // 同次评估内去重
    if (dedupSeenInEval.has(candidate.duplicateKey)) {
      suppressed.push({ candidate, reason: "重复候选" });
      continue;
    }
    dedupSeenInEval.add(candidate.duplicateKey);
    // 类型静默
    if (silencedKinds.has(candidate.kind)) {
      suppressed.push({ candidate, reason: "该类型已被用户静默" });
      continue;
    }
    // 频率加权
    const weight = typeWeightOf(opts.typeWeights, candidate.kind);
    const effective = candidate.rawConfidence * weight;
    if (effective < threshold) {
      suppressed.push({
        candidate,
        reason: `置信度不足(raw=${candidate.rawConfidence.toFixed(2)}, weight=${weight.toFixed(2)}, effective=${effective.toFixed(2)})`,
      });
      continue;
    }
    scored.push({ candidate, effective });
  }

  // 7. 按 effective 降序取预算内
  scored.sort((a, b) => b.effective - a.effective);
  const top = scored.slice(0, maxPerEvaluation).map((s) => s.candidate);

  return { candidates: top, suppressed };
}

/**
 * 取类型权重（容忍缺字段，缺字段回退 1.0）。
 * 内部辅助：service 注入的 typeWeights 已是完整对象，此处仅防御。
 */
function typeWeightOf(weights: SuggestionTypeWeights, kind: SuggestionKind): number {
  const w = weights[kind];
  if (typeof w === "number" && w > 0) return w;
  return 1.0;
}
