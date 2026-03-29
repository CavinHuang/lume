import type { ThinkingLevel } from "@lume/shared";

export interface ThinkingLevelOption {
  value: ThinkingLevel;
  label: string;
  description: string;
  shortLabel: string;
}

export const THINKING_LEVEL_OPTIONS: ThinkingLevelOption[] = [
  { value: "off", label: "关闭", shortLabel: "关", description: "禁用扩展思考" },
  { value: "low", label: "低", shortLabel: "低", description: "快速响应，最少推理" },
  { value: "medium", label: "中", shortLabel: "中", description: "平衡速度与推理深度" },
  { value: "high", label: "高", shortLabel: "高", description: "深度推理，适合复杂任务" },
  { value: "max", label: "超高", shortLabel: "超", description: "最强推理强度，适合最复杂任务" }
];

export function isThinkingEnabled(level: ThinkingLevel): boolean {
  return level !== "off";
}

export function normalizeThinkingLevel(
  level?: ThinkingLevel | null,
  thinkingEnabled?: boolean
): ThinkingLevel {
  if (level) {
    return level;
  }
  return thinkingEnabled ? "medium" : "off";
}

export function resolveThinkingLevelBudget(level: ThinkingLevel): number | null {
  switch (level) {
    case "off":
      return null;
    case "low":
      return 4096;
    case "medium":
      return 16384;
    case "high":
      return 32768;
    case "max":
      return 65536;
    default:
      return 16384;
  }
}
