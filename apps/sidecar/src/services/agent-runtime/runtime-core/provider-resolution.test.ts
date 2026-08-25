import { describe, expect, test } from "bun:test";
import {
  mapLumeProviderToRuntimeProvider,
  parseProviderModelRef,
  resolveRuntimeProviderCandidates
} from "./provider-resolution";

describe("provider-resolution", () => {
  test("应将 Lume provider 映射到 runtime provider", () => {
    expect(mapLumeProviderToRuntimeProvider("zhipu")).toBe("zai");
    expect(mapLumeProviderToRuntimeProvider("anthropic")).toBe("anthropic");
    expect(mapLumeProviderToRuntimeProvider("anthropic-compatible")).toBe("anthropic");
    expect(mapLumeProviderToRuntimeProvider("custom")).toBe("openai");
  });

  test("应解析 provider/model 格式模型", () => {
    expect(parseProviderModelRef("zai/glm-5")).toEqual({
      provider: "zai",
      model: "glm-5"
    });
  });

  test("anthropic 渠道 + glm 模型应优先使用渠道 provider", () => {
    const resolved = resolveRuntimeProviderCandidates({
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
    const resolved = resolveRuntimeProviderCandidates({
      channelProvider: "custom",
      modelId: "glm-4.7",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });
    expect(resolved.candidates[0]).toBe("anthropic");
    expect(resolved.candidates).toContain("openai");
  });

  test("provider/model 输入应优先使用模型内 provider", () => {
    const resolved = resolveRuntimeProviderCandidates({
      channelProvider: "anthropic",
      modelId: "zai/glm-5"
    });
    expect(resolved.modelId).toBe("glm-5");
    expect(resolved.candidates[0]).toBe("zai");
  });

  test("连接目录中的模型 ID 应保持斜杠并优先使用连接 provider", () => {
    const resolved = resolveRuntimeProviderCandidates({
      channelProvider: "openrouter",
      modelId: "anthropic/claude-sonnet-4-5",
      baseUrl: "https://openrouter.ai/api/v1",
      modelIdIsOpaque: true,
    });
    expect(resolved.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(resolved.candidates[0]).toBe("openrouter");
  });

  test("应映射全部 coding-plan/国内供应商到 runtime provider（避免发送完整 ref）", () => {
    // 这些 provider 已在 @lume/shared 的 PROVIDER_API_FAMILIES 中登记，
    // PROVIDER_ALIAS 必须同步覆盖，否则 parseProviderModelRef 无法拆分，
    // 会把 "provider/model" 整串当作模型名发给上游 → 404 model does not exist
    expect(mapLumeProviderToRuntimeProvider("stepfun")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("stepfun-coding-plan")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("siliconflow")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("aliyun-coding-plan")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("volcengine-coding-plan")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("xiaomi-token-plan")).toBe("openai");
    expect(mapLumeProviderToRuntimeProvider("minimax-token-plan")).toBe("anthropic");
  });

  test("stepfun-coding-plan 渠道应拆分出模型名而非发送完整 ref", () => {
    const resolved = resolveRuntimeProviderCandidates({
      channelProvider: "stepfun-coding-plan",
      modelId: "stepfun-coding-plan/step-3.7-flash",
      baseUrl: "https://api.stepfun.com/step_plan/v1"
    });
    expect(resolved.modelId).toBe("step-3.7-flash");
    expect(resolved.candidates).toContain("openai");
  });

  test("minimax-token-plan（anthropic 协议）应拆分并落到 anthropic provider", () => {
    const resolved = resolveRuntimeProviderCandidates({
      channelProvider: "minimax-token-plan",
      modelId: "minimax-token-plan/abab-coding",
      baseUrl: "https://api.minimaxi.com/anthropic/v1"
    });
    expect(resolved.modelId).toBe("abab-coding");
    expect(resolved.candidates).toContain("anthropic");
  });
});
