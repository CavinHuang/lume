import { describe, expect, test } from "bun:test";
import {
  normalizeProviderId,
  parseModelRef,
  resolveModelCandidatesForChannel,
  resolveChannelDefaultModelId,
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "./model-selection";

describe("model-selection", () => {
  test("normalizeProviderId 应兼容历史 provider 别名", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("z-ai")).toBe("zai");
    expect(normalizeProviderId("qwen")).toBe("qwen-portal");
    expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
  });

  test("parseModelRef 应支持 provider/model 与默认 provider", () => {
    expect(parseModelRef("zai/glm-5", "openai")).toEqual({
      provider: "zai",
      model: "glm-5"
    });
    expect(parseModelRef("glm-5", "zhipu")).toEqual({
      provider: "zhipu",
      model: "glm-5"
    });
  });

  test("openrouter baseUrl 应强制走 openai 适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "anthropic/claude-sonnet-4-5"
    });
    expect(resolved.adapterProvider).toBe("openai");
    expect(resolved.resolvedModelId).toBe("claude-sonnet-4-5");
    expect(resolved.modelRef).toBe("anthropic/claude-sonnet-4-5");
  });

  test("zai 模型在 bigmodel baseUrl 下应走 openai 兼容适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "zai/glm-5"
    });
    expect(resolved.adapterProvider).toBe("openai");
    expect(resolved.resolvedModelId).toBe("glm-5");
  });

  test("bigmodel anthropic endpoint 应走 anthropic 适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      modelId: "glm-4.7"
    });
    expect(resolved.adapterProvider).toBe("anthropic");
    expect(resolved.resolvedModelId).toBe("glm-4.7");
  });

  test("resolveRequestedModelIdForChannel 应支持 alias/name/default", () => {
    const channel = {
      models: [
        { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", alias: "mini", enabled: true },
        { id: "zai/glm-5", name: "GLM 5", enabled: false }
      ],
      defaultModelId: "openai/gpt-4.1-mini",
      fallbackModelIds: ["zai/glm-5"]
    };
    expect(resolveRequestedModelIdForChannel(channel, "mini")).toBe("openai/gpt-4.1-mini");
    expect(resolveRequestedModelIdForChannel(channel, "GLM 5")).toBe("zai/glm-5");
    expect(resolveRequestedModelIdForChannel(channel, undefined)).toBe("openai/gpt-4.1-mini");
    expect(resolveChannelDefaultModelId(channel)).toBe("openai/gpt-4.1-mini");
    expect(resolveModelCandidatesForChannel(channel, "mini")).toEqual([
      "openai/gpt-4.1-mini",
      "zai/glm-5"
    ]);
  });
});
