import { describe, expect, test } from "bun:test";
import { resolveProviderApiType } from "./provider-api-type";

describe("resolveProviderApiType", () => {
  test("显式 anthropic 家族优先于 provider 猜测（#531 裁定语义）", () => {
    // anthropic 家族模型挂 deepseek 渠道：走 anthropic-messages 而非 deepseek 协议
    expect(resolveProviderApiType({ family: "anthropic", provider: "deepseek" })).toBe("anthropic-messages");
    // 家族判定同样压过经归一化后的 provider 命中
    expect(resolveProviderApiType({ family: "anthropic", provider: " DeepSeek " })).toBe("anthropic-messages");
  });

  test("provider 猜测：anthropic/anthropic-compatible/deepseek/兜底", () => {
    expect(resolveProviderApiType({ provider: "anthropic" })).toBe("anthropic-messages");
    expect(resolveProviderApiType({ provider: "anthropic-compatible" })).toBe("anthropic-messages");
    expect(resolveProviderApiType({ provider: "deepseek" })).toBe("deepseek-chat-completions");
    expect(resolveProviderApiType({ provider: "openai" })).toBe("openai-completions");
    expect(resolveProviderApiType({ provider: "custom" })).toBe("openai-completions");
  });

  test("provider 匹配经 trim+lowercase 归一，等值命中不做模糊包含", () => {
    expect(resolveProviderApiType({ provider: " DeepSeek " })).toBe("deepseek-chat-completions");
    expect(resolveProviderApiType({ provider: "DEEPSEEK" })).toBe("deepseek-chat-completions");
    // 变体名(如渠道自动补全出的 "DeepSeek-V3")不触碰 deepseek 专用协议
    expect(resolveProviderApiType({ provider: "DeepSeek-V3" })).toBe("openai-completions");
  });
});
