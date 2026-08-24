/**
 * Suggestion 编排服务 — 整合 engine / feedback / analyst / store / adapter +
 * 把建议动作接到 Lume 既有的 automation + memory-v2 子系统。
 *
 * 三个对外入口（全部 fail-open：绝不向调用方抛错）：
 * - evaluateSessionSuggestions(ctx)：会话级规则评估，hook fire-and-forget 调用
 * - handleSuggestionFeedback(id, feedback)：用户三态反馈 → 学习权重 + 触发动作
 * - runAnalysisAndPersist(ctx)：LLM 工作模式分析 → 候选去重落库
 *
 * IPC 广播解耦：notifySuggestionsChanged 经模块级可注入 broadcaster 调用。
 * Task 12 通过 setSuggestionChangeBroadcaster 注入真实 channel；本服务不直接
 * 依赖 IPC 层，保持纯逻辑可测。
 *
 * 1:1 编排映射自 Proma `apps/electron/src/main/lib/suggest/service.ts`
 * (PR proma-ai/Proma#1409)，但动作分发适配 Lume：
 * - memory_correction → smartAddMemoryV2Candidate（而非 Proma 的 addCorrection）
 * - open_automation_create → createAutomationJob（schedule=manual，而非弹窗填表）
 * - open_memory_board / open_skill_creator → 暂 no-op（UI 导航在 web 端）
 */

import type {
  SuggestionCandidate,
  SuggestionFeedback,
  SuggestionKind,
  SuggestionRecord,
  SuggestionTypeWeights,
} from "@lume/shared";
import { evaluateSuggestions, type DedupContext } from "./engine";
import { loadDedupContext } from "./rules";
import { extractRecentConversation } from "./adapter";
import { recordFeedback, isTypeSilenced, getNeverKeys } from "./feedback";
import { buildAnalysisInput, runAnalysis } from "./analyst";
import {
  getEnabled,
  getTypeWeights,
  listSuggestions,
  persistSuggestion,
} from "./store";
import { createAutomationJob } from "../automation/automation-manager";
import { MemoryCommandService } from "../memory-v2/command-service";
import { createLogger } from "../infra/logger";

const log = createLogger("suggest-service");

/** 同会话最多建议条数（brief 契约） */
const MAX_PER_SESSION = 2;

/** 所有建议类型（用于遍历检测类型静默） */
const ALL_KINDS: SuggestionKind[] = ["correction", "followup", "automation", "todo", "skill"];

// ===== IPC 广播（Task 12 注入真实 channel） =====

/**
 * 建议变更广播器。Task 12 通过 setSuggestionChangeBroadcaster 注入真实 IPC
 * channel；在此之前为 no-op。service 不直接依赖 IPC 层，保持可测。
 */
let suggestionChangeBroadcaster: () => void = () => {};

/** 注入建议变更广播器（Task 12 调用）。 */
export function setSuggestionChangeBroadcaster(fn: () => void): void {
  suggestionChangeBroadcaster = fn;
}

function notifySuggestionsChanged(): void {
  try {
    suggestionChangeBroadcaster();
  } catch (error) {
    log.warn("suggestion change broadcaster threw", { error });
  }
}

// ===== 入口 1：会话级评估 =====

export interface SessionSuggestContext {
  /** 目标线程 ID（必需，用于读取会话消息） */
  threadId: string;
  /** 工作区 slug（透传到 persist / dedup context） */
  workspaceSlug?: string;
  /** 会话 ID（用于同会话去重计数；缺失时回退 threadId） */
  sessionId?: string;
}

/**
 * 评估当前会话消息，生成建议候选并落库。
 *
 * 流程：
 * 1. 全局开关 getEnabled 关 → return
 * 2. 同会话 suggested 条数 ≥ MAX_PER_SESSION → return（频控）
 * 3. extractRecentConversation 抽取最近 30 条 user 消息
 * 4. 装配 engine opts（typeWeights/seenKeys/neverKeys/silencedKinds/dedupContext）
 * 5. evaluateSuggestions 纯函数求值
 * 6. 逐条 persist + 广播（类型静默双保险）
 *
 * fire-and-forget 调用：fail-open，绝不抛错。
 */
export async function evaluateSessionSuggestions(
  ctx: SessionSuggestContext,
): Promise<void> {
  try {
    if (!getEnabled()) return;

    const sessionKey = pickSessionKey(ctx);
    const seenKeys = new Set<string>();
    let sessionSuggested = 0;
    if (sessionKey) {
      for (const r of listSuggestions("suggested")) {
        if (pickSessionKey(r) === sessionKey) {
          sessionSuggested++;
          seenKeys.add(r.duplicateKey);
        }
      }
    }
    if (sessionSuggested >= MAX_PER_SESSION) return;

    const messages = await extractRecentConversation({
      threadId: ctx.threadId,
      workspaceSlug: ctx.workspaceSlug,
      limit: 30,
    });

    const neverKeys = getNeverKeys();
    const silencedKinds = new Set<SuggestionKind>(
      ALL_KINDS.filter((kind) => isTypeSilenced(kind)),
    );
    const typeWeights: SuggestionTypeWeights = getTypeWeights();
    const dedupContext: DedupContext = safeLoadDedupContext(ctx.workspaceSlug);

    const { candidates } = evaluateSuggestions(messages, {
      typeWeights,
      seenKeys,
      neverKeys,
      silencedKinds,
      dedupContext,
    });

    for (const candidate of candidates) {
      // 类型静默双保险（engine 已过滤，此处防御性兜底）
      if (silencedKinds.has(candidate.kind)) continue;
      persistSuggestion(candidate, {
        threadId: ctx.threadId,
        workspaceSlug: ctx.workspaceSlug,
        sessionId: ctx.sessionId,
      });
      notifySuggestionsChanged();
    }
  } catch (error) {
    log.warn("evaluateSessionSuggestions failed (fail-open)", { error });
  }
}

// ===== 入口 2：反馈处理 =====

/**
 * 用户反馈处理：先记录反馈（学习权重 + 更新状态），再分发动作。
 * - accepted + memory_correction → smartAddMemoryV2Candidate（写入长期记忆）
 * - accepted + open_automation_create → createAutomationJob（manual schedule）
 * - accepted + open_memory_board / open_skill_creator → no-op（UI 导航 web 端，TODO）
 * - ignored / never → 仅 recordFeedback
 *
 * fail-open：动作失败不影响 recordFeedback 已落盘的权重学习。
 */
export async function handleSuggestionFeedback(
  id: number,
  feedback: SuggestionFeedback,
): Promise<void> {
  try {
    recordFeedback(id, feedback);
    notifySuggestionsChanged();
    if (feedback !== "accepted") return;

    const record = listSuggestions().find((r) => r.id === id);
    if (!record) return;

    await dispatchAcceptedAction(record);
  } catch (error) {
    log.warn("handleSuggestionFeedback failed (fail-open)", { error });
  }
}

/** 分发 accepted 动作（按 action.type 路由到对应子系统） */
async function dispatchAcceptedAction(record: SuggestionRecord): Promise<void> {
  const action = record.action;
  switch (action.type) {
    case "memory_correction": {
      await new MemoryCommandService().remember({
        workspaceSlug: record.workspaceSlug ?? "global",
        content: action.rule,
        scope: "global",
        semanticRole: "preference",
        facets: ["correction", "suggestion-derived"],
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: action.rule,
        },
        actor: "user",
        explicitCorrection: true
      });
      return;
    }
    case "open_automation_create": {
      createAutomationJob({
        name: action.automationTitle,
        schedule: { type: "manual" },
        prompt: action.suggestedPrompt,
        // 与 UI 表单同纪律：建议创建的任务不享受无人值守 bypass（#647 P2-23）
        source: "manual",
      });
      return;
    }
    case "open_memory_board":
    case "open_skill_creator":
      // TODO(Task 11+): UI 导航由 web 端处理；此处仅完成反馈记录（已 recordFeedback）。
      return;
  }
}

// ===== 入口 3：LLM 工作模式分析 =====

export interface AnalysisContext {
  workspaceSlug?: string;
}

/**
 * 运行 LLM 工作模式分析，去重后落库。
 *
 * 去重：丢弃 duplicateKey 在 neverKeys（用户永久屏蔽）或已有 suggested 记录中的候选。
 * 返回新增候选数（fail-open：失败返回 0）。
 */
export async function runAnalysisAndPersist(
  ctx: AnalysisContext = {},
): Promise<number> {
  try {
    const context = safeBuildAnalysisInput(ctx.workspaceSlug);
    const candidates = await runAnalysis({
      context,
      workspaceSlug: ctx.workspaceSlug,
    });

    // 分析期间可能有其它调用落库；在同步持久化前重新读取，关闭并发去重竞态。
    const neverKeys = getNeverKeys();
    const suggestedKeys = new Set(
      listSuggestions("suggested").map((r) => r.duplicateKey),
    );
    const filtered: SuggestionCandidate[] = [];
    for (const candidate of candidates) {
      if (neverKeys.has(candidate.duplicateKey) || suggestedKeys.has(candidate.duplicateKey)) {
        continue;
      }
      suggestedKeys.add(candidate.duplicateKey);
      filtered.push(candidate);
    }

    for (const candidate of filtered) {
      persistSuggestion(candidate, { workspaceSlug: ctx.workspaceSlug });
      notifySuggestionsChanged();
    }
    return filtered.length;
  } catch (error) {
    log.warn("runAnalysisAndPersist failed (fail-open)", { error });
    return 0;
  }
}

// ===== 辅助（fail-open 包装） =====

/** loadDedupContext 失败时回退到空上下文（不让一个子系统的故障阻断评估） */
function safeLoadDedupContext(workspaceSlug?: string): DedupContext {
  try {
    return loadDedupContext({ workspaceSlug });
  } catch (error) {
    log.warn("loadDedupContext failed (fail-open to empty)", { error });
    return { automationTitles: [], correctionRules: [], sopCandidateCount: 0 };
  }
}

/** buildAnalysisInput 失败时回退到空 context（runAnalysis 会因此返回 []） */
function safeBuildAnalysisInput(workspaceSlug?: string): string {
  try {
    return buildAnalysisInput({ workspaceSlug });
  } catch (error) {
    log.warn("buildAnalysisInput failed (fail-open to empty)", { error });
    return "";
  }
}

/** 统一会话标识：优先 sessionId，回退 threadId */
function pickSessionKey(r: { sessionId?: string; threadId?: string }): string | undefined {
  return r.sessionId ?? r.threadId;
}
