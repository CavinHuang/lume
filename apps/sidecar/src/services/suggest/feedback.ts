/**
 * Suggestion 反馈层 — 频率学习 + 连续忽略静默
 *
 * 1:1 移植自 Proma `apps/electron/src/main/lib/suggest/feedback.ts` (PR proma-ai/Proma#1409)。
 * 用户三态反馈 → 类型权重调节（"越用越好用"的机制）：
 * - accepted：weight × 1.2（上限 2.0），同类建议更容易出现
 * - ignored：weight × 0.8（下限 0.2），同类建议收敛
 * - never：该 duplicateKey 永久屏蔽 + 类型 weight × 0.5（下限 0.2）
 * 连续忽略 N 次后该类型自动静默（P9 时机学习的简化落地）。
 *
 * Lume 适配（相对 Proma 源）：
 * 1. 持久化分层：Proma feedback.ts 直接持有 cache + 读写文件；Lume 拆分为
 *    store.ts 负责所有持久化，feedback.ts 只读 store 计算后写回（经
 *    getTypeWeights/setTypeWeights + updateSuggestionStatus）。feedback 不再
 *    import 文件 IO / config-paths。
 * 2. id 类型：Proma 用 string UUID；Lume store 用 number 自增。recordFeedback
 *    签名随之收 number。
 * 3. 返回值：Proma recordFeedback 返回 SuggestionRecord | undefined；
 *    Lume brief 契约为 void（Task 9 service 不需要返回值）。
 * 4. 常量与权重数学完全 verbatim：1.2/0.8/0.5、cap 2.0、floor 0.2、
 *    SILENCE_AFTER_IGNORES=3。
 */

import type { SuggestionFeedback, SuggestionKind, SuggestionTypeWeights } from "@lume/shared";
import {
  getTypeWeights,
  listSuggestions,
  setTypeWeights,
  updateSuggestionStatus,
} from "./store";

/** 连续忽略达到该次数后，类型自动静默（跳过评估） */
export const SILENCE_AFTER_IGNORES = 3;

// ===== 权重数学（verbatim from Proma） =====

const WEIGHT_ACCEPTED_FACTOR = 1.2;
const WEIGHT_IGNORED_FACTOR = 0.8;
const WEIGHT_NEVER_FACTOR = 0.5;
const WEIGHT_CEILING = 2.0;
const WEIGHT_FLOOR = 0.2;

/** 取类型当前权重，缺字段回退 1.0（防御旧索引） */
function currentWeight(weights: SuggestionTypeWeights, kind: SuggestionKind): number {
  const w = weights[kind];
  if (typeof w === "number" && w > 0) return w;
  return 1.0;
}

/** 上下限夹紧 */
function clampWeight(value: number): number {
  if (value > WEIGHT_CEILING) return WEIGHT_CEILING;
  if (value < WEIGHT_FLOOR) return WEIGHT_FLOOR;
  return value;
}

// ===== 对外 API =====

/**
 * 记录用户反馈，更新类型权重 + 单条 record 状态。
 * - accepted：weight × 1.2（上限 2.0）
 * - ignored：weight × 0.8（下限 0.2）
 * - never：weight × 0.5（下限 0.2）+ duplicateKey 永久屏蔽（经 getNeverKeys 读出）
 *
 * id 不存在或 feedback 非法时为安全无操作。
 */
export function recordFeedback(id: number, feedback: SuggestionFeedback): void {
  // 入口白名单：防止非法枚举污染 status（IPC 入口防御）
  if (feedback !== "accepted" && feedback !== "ignored" && feedback !== "never") return;

  const record = listSuggestions().find((r) => r.id === id);
  if (!record) return;

  const weights = getTypeWeights();
  const current = currentWeight(weights, record.kind);
  let next: number;
  switch (feedback) {
    case "accepted":
      next = current * WEIGHT_ACCEPTED_FACTOR;
      break;
    case "ignored":
      next = current * WEIGHT_IGNORED_FACTOR;
      break;
    case "never":
      next = current * WEIGHT_NEVER_FACTOR;
      break;
  }
  weights[record.kind] = clampWeight(next);

  // 写回权重 + 更新 record 状态（两次 store 写，均经 cache，状态一致）
  setTypeWeights(weights);
  updateSuggestionStatus(id, feedback);
}

/**
 * 判断某类型的建议是否已被"连续忽略自动静默"。
 * 取该 kind 最近 SILENCE_AFTER_IGNORES 条记录，全部 status=ignored → true。
 * 记录不足 3 条时返回 false（未形成连续忽略模式）。
 */
export function isTypeSilenced(kind: SuggestionKind): boolean {
  const recent = listSuggestions()
    .filter((r) => r.kind === kind)
    .slice(0, SILENCE_AFTER_IGNORES);
  if (recent.length < SILENCE_AFTER_IGNORES) return false;
  return recent.every((r) => r.status === "ignored");
}

/**
 * 获取用户永久屏蔽（status=never）的 duplicateKey 集合。
 * Task 9 service 将其作为 neverKeys 传给 engine 的去重四连。
 */
export function getNeverKeys(): Set<string> {
  const keys = new Set<string>();
  for (const r of listSuggestions()) {
    if (r.status === "never") keys.add(r.duplicateKey);
  }
  return keys;
}
