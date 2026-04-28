export type PromptSectionMode = "full" | "minimal";

export interface PromptSection {
  id: string;
  title?: string;
  priority: number;
  mode: PromptSectionMode[];
  content: string;
  tokenBudget?: number;
}
