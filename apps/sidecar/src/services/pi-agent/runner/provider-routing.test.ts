import { describe, expect, test } from "bun:test";
import { isBigmodelAnthropicCompatBaseUrl, prioritizeProvidersForBaseUrl, shouldApplyChannelBaseUrl } from "./provider-routing";

describe("provider-routing", () => {
  test("bigmodel anthropic 兼容端点应优先使用 zai provider", () => {
    expect(prioritizeProvidersForBaseUrl(["anthropic", "zai", "openai"], "https://open.bigmodel.cn/api/anthropic"))
      .toEqual(["zai", "anthropic", "openai"]);
  });

  test("bigmodel anthropic 兼容端点下不应把 anthropic baseUrl 覆盖到 zai provider", () => {
    expect(shouldApplyChannelBaseUrl("zai", "https://open.bigmodel.cn/api/anthropic")).toBeFalse();
    expect(shouldApplyChannelBaseUrl("anthropic", "https://open.bigmodel.cn/api/anthropic")).toBeTrue();
  });

  test("应识别 bigmodel anthropic 兼容端点", () => {
    expect(isBigmodelAnthropicCompatBaseUrl("https://open.bigmodel.cn/api/anthropic")).toBeTrue();
    expect(isBigmodelAnthropicCompatBaseUrl("https://api.anthropic.com")).toBeFalse();
  });
});
