import { describe, expect, test } from "bun:test";
import { resolvePiChannelModel } from "./model";

describe("runtime-core model", () => {
  test("bigmodel anthropic compat fallback 不应把 anthropic compat baseUrl 直接塞给 zai fallback model", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "zai/non-existent-model", name: "custom", enabled: true }]
      },
      channelProvider: "zai",
      requestedModelRefOrId: "zai/non-existent-model",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });

    expect(resolved?.provider).toBe("zai");
    expect(resolved?.resolvedModelId).toBe("non-existent-model");
    expect(resolved?.model.baseUrl).not.toBe("https://open.bigmodel.cn/api/anthropic");
  });

  test("bigmodel anthropic compat catalog model 应优先解析为 zai provider 且不继承 anthropic compat baseUrl", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "glm-4.5", name: "GLM", enabled: true }]
      },
      channelProvider: "custom",
      requestedModelRefOrId: "glm-4.5",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });

    expect(resolved?.provider).toBe("zai");
    expect(resolved?.resolvedModelId).toBe("glm-4.5");
    expect(resolved?.model.baseUrl).not.toBe("https://open.bigmodel.cn/api/anthropic");
  });

  test("官方 anthropic 渠道应继续保留 channel baseUrl 到 anthropic model", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude", enabled: true }]
      },
      channelProvider: "anthropic",
      requestedModelRefOrId: "claude-sonnet-4-5-20250929",
      baseUrl: "https://api.anthropic.com"
    });

    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.resolvedModelId).toBe("claude-sonnet-4-5-20250929");
    expect(resolved?.model.baseUrl).toBe("https://api.anthropic.com");
  });

  test("OpenRouter 模型 ID 中的上游 provider 前缀必须保持不变", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "anthropic/claude-sonnet-4-5", name: "Claude", enabled: true }]
      },
      channelProvider: "openrouter",
      requestedModelRefOrId: "anthropic/claude-sonnet-4-5",
      baseUrl: "https://openrouter.ai/api/v1"
    });

    expect(resolved?.resolvedModelId).toBe("anthropic/claude-sonnet-4-5");
  });

  test("GLM-5.2 应使用元数据中的 1M 上下文窗口", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "glm-5.2", name: "GLM-5.2", enabled: true }]
      },
      channelProvider: "zai",
      requestedModelRefOrId: "zai/glm-5.2",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4"
    });

    expect(resolved?.model.contextWindow).toBe(1_000_000);
  });

  test("应优先使用模型上下文长度手动覆盖值", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "glm-5.2", name: "GLM-5.2", enabled: true }]
      },
      channelProvider: "zai",
      requestedModelRefOrId: "zai/glm-5.2",
      contextWindowOverrides: { "zai/glm-5.2": 512_000 }
    });

    expect(resolved?.model.contextWindow).toBe(512_000);
  });
});
