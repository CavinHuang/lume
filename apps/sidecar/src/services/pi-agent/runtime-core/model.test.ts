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
});
