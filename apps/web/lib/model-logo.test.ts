import { describe, expect, test } from "bun:test";
import { getChannelLogo, getModelLogo, getModelLogoById, getProviderLogo } from "./model-logo";

describe("model-logo", () => {
  test("getModelLogoById 应按模型关键词映射到静态图标", () => {
    expect(getModelLogoById("gpt-5")).toContain("openai");
    expect(getModelLogoById("claude-sonnet")).toContain("claude");
    expect(getModelLogoById("glm-4.7")).toContain("chatglm");
  });

  test("getProviderLogo 应按 provider 返回图标", () => {
    expect(getProviderLogo("openai")).toContain("openai");
    expect(getProviderLogo("qwen")).toContain("qwen");
  });

  test("getChannelLogo 应按 baseUrl 匹配渠道图标", () => {
    expect(getChannelLogo("https://api.openai.com/v1")).toContain("openai");
    expect(getChannelLogo("https://open.bigmodel.cn/api/paas/v4")).toContain("zhipu");
  });

  test("未知模型应回退到默认图标", () => {
    expect(getModelLogo("unknown-model")).toBe("/models/default.png");
    expect(getChannelLogo("")).toBe("/models/default.png");
  });
});
