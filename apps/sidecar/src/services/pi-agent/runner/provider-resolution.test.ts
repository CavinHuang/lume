import { describe, expect, test } from "bun:test";
import {
  mapLumeProviderToPiProvider,
  parseProviderModelRef,
  resolvePiProviderCandidates
} from "./provider-resolution";

describe("provider-resolution", () => {
  test("应将 Lume provider 映射到 Pi provider", () => {
    expect(mapLumeProviderToPiProvider("zhipu")).toBe("zai");
    expect(mapLumeProviderToPiProvider("anthropic")).toBe("anthropic");
    expect(mapLumeProviderToPiProvider("anthropic-compatible")).toBe("anthropic");
    expect(mapLumeProviderToPiProvider("custom")).toBe("openai");
  });

  test("应解析 provider/model 格式模型", () => {
    expect(parseProviderModelRef("zai/glm-5")).toEqual({
      provider: "zai",
      model: "glm-5"
    });
  });

  test("anthropic 渠道 + glm 模型应优先使用渠道 provider", () => {
    const resolved = resolvePiProviderCandidates({
      channelProvider: "anthropic",
      modelId: "glm-5",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4"
    });
    expect(resolved.modelId).toBe("glm-5");
    expect(resolved.candidates[0]).toBe("anthropic");
    expect(resolved.candidates[1]).toBe("zai");
    expect(resolved.candidates).toContain("zai");
    expect(resolved.candidates).toContain("anthropic");
  });

  test("bigmodel anthropic endpoint 应识别为 anthropic provider", () => {
    const resolved = resolvePiProviderCandidates({
      channelProvider: "custom",
      modelId: "glm-4.7",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });
    expect(resolved.candidates[0]).toBe("anthropic");
    expect(resolved.candidates).toContain("openai");
  });

  test("provider/model 输入应优先使用模型内 provider", () => {
    const resolved = resolvePiProviderCandidates({
      channelProvider: "anthropic",
      modelId: "zai/glm-5"
    });
    expect(resolved.modelId).toBe("glm-5");
    expect(resolved.candidates[0]).toBe("zai");
  });
});
