import { describe, expect, test } from "bun:test";
import { resolvePiChannelModel } from "./model";

describe("runtime-core model", () => {
  test("bigmodel anthropic compat fallback 不应把 anthropic compat baseUrl 直接塞给 zai fallback model", () => {
    const resolved = resolvePiChannelModel({
      channel: {
        models: [{ id: "zai/non-existent-model", name: "custom", enabled: true }]
      },
      channelProvider: "zai",
      modelId: "zai/non-existent-model",
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
      modelId: "glm-4.5",
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
      modelId: "claude-sonnet-4-5-20250929",
      baseUrl: "https://api.anthropic.com"
    });

    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.resolvedModelId).toBe("claude-sonnet-4-5-20250929");
    expect(resolved?.model.baseUrl).toBe("https://api.anthropic.com");
  });
});
