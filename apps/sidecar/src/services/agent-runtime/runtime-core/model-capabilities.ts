import type { Api, Model } from "./model-types";
import type { LumeConfigThinkingLevel } from "@lume/shared";

export function resolveAgentThinkingLevel(
  model: Model<Api>,
  baseUrl?: string,
  requestedLevel?: LumeConfigThinkingLevel
): "off" | "low" | "medium" | "high" | "xhigh" | undefined {
  switch (requestedLevel) {
    case "off":
      return "off";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
    default:
      return "medium";
  }
}
