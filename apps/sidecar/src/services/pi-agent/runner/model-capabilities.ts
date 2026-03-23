import type { Api, Model } from "@mariozechner/pi-ai";

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

export function resolveAgentThinkingLevel(model: Model<Api>, baseUrl?: string): "medium" | undefined {
  if (model.provider === "anthropic" && !supportsAnthropicThinking(baseUrl)) {
    return undefined;
  }
  return "medium";
}
