import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@lume/shared";

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "").trim().toLowerCase();
}

export function supportsAnthropicThinking(baseUrl?: string): boolean {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return true;
  }
  return normalized.includes("api.anthropic.com");
}

export function adaptModelCapabilities<TApi extends Api>(model: Model<TApi>, baseUrl?: string): Model<TApi> {
  if (model.provider !== "anthropic" || supportsAnthropicThinking(baseUrl)) {
    return model;
  }
  return {
    ...model,
    reasoning: false
  };
}

export function resolveAgentThinkingLevel(
  model: Model<Api>,
  baseUrl?: string,
  requestedLevel?: ThinkingLevel
): "off" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (model.provider === "anthropic" && !supportsAnthropicThinking(baseUrl)) {
    return undefined;
  }
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
