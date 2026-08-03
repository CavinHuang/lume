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
