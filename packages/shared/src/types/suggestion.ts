// packages/shared/src/types/suggestion.ts
export type SuggestionKind = "correction" | "followup" | "automation" | "todo" | "skill";

export type SuggestionAction =
  | { type: "memory_correction"; raw: string; rule: string }
  | { type: "open_automation_create"; automationTitle: string; suggestedPrompt: string }
  | { type: "open_memory_board" }
  | { type: "open_skill_creator"; topic: string };

export interface SuggestionCandidate {
  duplicateKey: string;
  kind: SuggestionKind;
  title: string;
  reason: string;
  evidence: string;
  rawConfidence: number;
  action: SuggestionAction;
}

export interface SuggestionRecord extends SuggestionCandidate {
  id: number;
  sessionId?: string;
  threadId?: string;
  workspaceSlug?: string;
  status: "suggested" | "accepted" | "ignored" | "never";
  createdAt: number;
  feedbackAt?: number;
}

export type SuggestionFeedback = "accepted" | "ignored" | "never";
export type SuggestionTypeWeights = Record<SuggestionKind, number>;

export interface SuggestionsIndex {
  version: 1;
  records: SuggestionRecord[];
  typeWeights: SuggestionTypeWeights;
  enabled: boolean;
}

export interface SuggestionStats {
  suggestedCount: number;
  todayAccepted: number;
  todayIgnored: number;
  todayNever: number;
  typeWeights: SuggestionTypeWeights;
}

export const DEFAULT_TYPE_WEIGHTS: SuggestionTypeWeights = {
  correction: 1.0, followup: 1.0, automation: 1.0, skill: 0.8, todo: 0.9,
};

/**
 * 主动建议 IPC channel（sidecar RPC）。命名遵循 `<namespace>:<verb>` 惯例。
 *
 * list / stats / delete / clear-all / set-enabled 直通 store；
 * act 路由到 service.handleSuggestionFeedback（学习权重 + 动作分发）；
 * run-analysis 路由到 service.runAnalysisAndPersist（LLM 分析 + 去重落库）。
 */
export const SUGGESTION_IPC_CHANNELS = {
  /** 列出建议（可按 status 过滤） */
  LIST: "suggestion:list",
  /** 用户三态反馈 → service.handleSuggestionFeedback */
  ACT: "suggestion:act",
  /** 今日/累计统计 → store.suggestionStats */
  STATS: "suggestion:stats",
  /** 删除单条 → store.deleteSuggestion */
  DELETE: "suggestion:delete",
  /** 清空全部 → store.clearSuggestions */
  CLEAR_ALL: "suggestion:clear-all",
  /** 触发 LLM 工作模式分析 → service.runAnalysisAndPersist */
  RUN_ANALYSIS: "suggestion:run-analysis",
  /** 开关建议系统 → store.setEnabled */
  SET_ENABLED: "suggestion:set-enabled",
  /**
   * 建议变更推送（sidecar → web notification）。payload 仅作信号：
   * `{ type: "suggestions_changed" }`。web 收到后自取最新建议列表。
   * 由 service.notifySuggestionsChanged 经注入的 broadcaster 触发。
   */
  CHANGED: "suggestion:changed",
} as const;
