import type { Api, Model } from "./model-types";
import type { LumeConfigThinkingLevel } from "@lume/shared";

/**
 * 只要 runtime 走 anthropic provider，就允许启用 thinking。
 *
 * 之前这里限制为官方 `api.anthropic.com` 域名，导致所有
 * Anthropic 兼容网关（代理 / 中转 / 企业网关）都会被静默关闭思考模式，
 * 用户即使在前端选择了思考等级，也看不到 reasoning。
 *
 * 真实是否支持由上游网关/模型决定；若不支持，应由 provider/runtime 返回错误，
 * 而不是在能力层提前静默降级。
 */
export function supportsAnthropicThinking(_baseUrl?: string): boolean {
  return true;
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
  requestedLevel?: LumeConfigThinkingLevel
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
