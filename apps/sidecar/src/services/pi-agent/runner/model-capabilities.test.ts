import { describe, expect, test } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { adaptModelCapabilities, resolveAgentThinkingLevel, supportsAnthropicThinking } from "./model-capabilities";

describe("model-capabilities", () => {
  test("bigmodel anthropic 兼容端点不应启用 anthropic thinking", () => {
    expect(supportsAnthropicThinking("https://open.bigmodel.cn/api/anthropic")).toBeFalse();
  });

  test("官方 anthropic 端点保留 thinking", () => {
    expect(supportsAnthropicThinking("https://api.anthropic.com")).toBeTrue();
  });

  test("非官方 anthropic 兼容端点应关闭 reasoning 与 thinkingLevel", () => {
    const model: Model<"anthropic-messages"> = {
      id: "glm-5",
      name: "glm-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32768
    };
    expect(adaptModelCapabilities(model, "https://open.bigmodel.cn/api/anthropic").reasoning).toBeFalse();
    expect(resolveAgentThinkingLevel(model, "https://open.bigmodel.cn/api/anthropic")).toBeUndefined();
  });

  test("官方端点应将 Agent 思考等级映射到 runtime thinking level", () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-sonnet",
      name: "claude-sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      baseUrl: "https://api.anthropic.com",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32768
    };

    expect(resolveAgentThinkingLevel(model, "https://api.anthropic.com", "off")).toBe("off");
    expect(resolveAgentThinkingLevel(model, "https://api.anthropic.com", "low")).toBe("low");
    expect(resolveAgentThinkingLevel(model, "https://api.anthropic.com", "medium")).toBe("medium");
    expect(resolveAgentThinkingLevel(model, "https://api.anthropic.com", "high")).toBe("high");
    expect(resolveAgentThinkingLevel(model, "https://api.anthropic.com", "max")).toBe("xhigh");
  });
});
