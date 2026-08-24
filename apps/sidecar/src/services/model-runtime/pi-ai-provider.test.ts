import { afterEach, describe, expect, test } from "bun:test";
import {
  isRetryablePiAiError,
  PiAiProvider,
  PiAiProviderError,
  type PiAiProviderOptions,
  resolvePiModelInput,
  resolvePiAiRetryDelayMs,
  resolvePiModelReasoningCapability,
  resolveStreamThinkingOptions,
  shouldTryNextPiAiRoute,
} from "./pi-ai-provider";

describe("pi-ai image transport", () => {
  test("advertises image input when the request contains a user image", () => {
    expect(resolvePiModelInput([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      ],
    }])).toEqual(["text", "image"]);
  });

  test("advertises image input when a tool result contains an image", () => {
    expect(resolvePiModelInput([{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
      }],
    }])).toEqual(["text", "image"]);
  });

  test("keeps text-only requests text-only", () => {
    expect(resolvePiModelInput([{ role: "user", content: "hello" }])).toEqual(["text"]);
  });
});

describe("pi-ai model reasoning capability", () => {
  test("能力未知时恒为 true：关闭思考也必须让 pi-ai 走 thinkingFormat 分支发显式禁用参数", () => {
    // 回归:此前 disabled 请求把 capability 判成 false,pi-ai 跳过全部分支,
    // 请求体不带任何思考参数,GLM/Qwen 服务端默认开思考→选"关闭"依然思考
    expect(resolvePiModelReasoningCapability(undefined)).toBe(true);
    expect(resolvePiModelReasoningCapability(false)).toBe(false);
    expect(resolvePiModelReasoningCapability(true)).toBe(true);
  });
});

describe("pi-ai provider retry policy", () => {
  test("retries transient status and network failures only", () => {
    expect(isRetryablePiAiError(new PiAiProviderError("busy", { status: 429 }))).toBe(true);
    expect(isRetryablePiAiError(new PiAiProviderError("down", { status: 503 }))).toBe(true);
    expect(isRetryablePiAiError(new Error("fetch failed"))).toBe(true);
    expect(isRetryablePiAiError(new PiAiProviderError("invalid response payload"))).toBe(false);
    expect(isRetryablePiAiError(new PiAiProviderError("bad request", { status: 400 }))).toBe(false);
    expect(isRetryablePiAiError(new PiAiProviderError("invalid key", { status: 401 }))).toBe(false);
  });

  test("uses 1/2/4/8/16 second backoff and caps Retry-After at 120 seconds", () => {
    const deterministicRandom = () => 0.5;
    expect([0, 1, 2, 3, 4].map((index) =>
      resolvePiAiRetryDelayMs(new Error("network"), index, deterministicRandom)
    )).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(resolvePiAiRetryDelayMs(
      new PiAiProviderError("busy", { retryAfterMs: 90_000 }),
      0,
      deterministicRandom,
    )).toBe(90_000);
    expect(resolvePiAiRetryDelayMs(
      new PiAiProviderError("busy", { retryAfterMs: 300_000 }),
      0,
      deterministicRandom,
    )).toBe(120_000);
  });

  test("falls back for model-specific and credential failures but not malformed requests", () => {
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("model missing", { status: 404 }), true)).toBe(true);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("invalid key", { status: 401 }), true)).toBe(true);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("bad request", { status: 400 }), true)).toBe(false);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("unprocessable", { status: 422 }), true)).toBe(false);
    expect(shouldTryNextPiAiRoute(new Error("network"), false)).toBe(false);
    expect(shouldTryNextPiAiRoute(new Error("aborted"), true, true)).toBe(false);
  });
});

describe("pi-ai thinking level wiring (#561)", () => {
  const baseParams = {
    model: "test-model",
    maxTokens: 32768,
    system: "",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  test("xhigh 预算反查为 xhigh 档,预算落在钳制后的 high 键上", () => {
    expect(resolveStreamThinkingOptions({
      ...baseParams,
      thinking: { type: "enabled", budget_tokens: 16384 },
    })).toEqual({ reasoning: "xhigh", thinkingBudgets: { high: 16384 } });
  });

  test("各档预算映射到对应档位", () => {
    expect(resolveStreamThinkingOptions({
      ...baseParams,
      thinking: { type: "enabled", budget_tokens: 8192 },
    })).toEqual({ reasoning: "high", thinkingBudgets: { high: 8192 } });
    expect(resolveStreamThinkingOptions({
      ...baseParams,
      thinking: { type: "enabled", budget_tokens: 4096 },
    })).toEqual({ reasoning: "medium", thinkingBudgets: { medium: 4096 } });
    expect(resolveStreamThinkingOptions({
      ...baseParams,
      thinking: { type: "enabled", budget_tokens: 1024 },
    })).toEqual({ reasoning: "low", thinkingBudgets: { low: 1024 } });
  });

  test("disabled 时返回空 options(pi-ai 据此向各渠发显式关闭信号)", () => {
    expect(resolveStreamThinkingOptions({ ...baseParams, thinking: { type: "disabled" } })).toEqual({});
  });

  test("thinking 缺失时保留 medium 回落(旧行为,#631 review)", () => {
    // 直连消费方(advisor/memory-v2/suggest/vision-router 等)不设 thinking,
    // 若翻转成 {} 会把它们从"强加 medium"变成"显式关闭",跨渠道出网形态全变
    expect(resolveStreamThinkingOptions(baseParams)).toEqual({ reasoning: "medium" });
  });

  test("enabled 但无预算时保留 medium 回落(旧行为)", () => {
    expect(resolveStreamThinkingOptions({ ...baseParams, thinking: { type: "enabled" } }))
      .toEqual({ reasoning: "medium" });
  });
});

describe("pi-ai provider request body wiring (#561)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubCapture(status: number): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return bodies;
  }

  function createTestProvider(
    apiType: "anthropic-messages" | "openai-completions",
    options?: Partial<Pick<PiAiProviderOptions, "thinkingLevelMap" | "compat">>,
  ): PiAiProvider {
    return new PiAiProvider({
      apiType,
      providerId: "test",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "sk-test",
      supportsReasoning: true,
      ...options,
    });
  }

  function createTestParams(thinking?: { type: string; budget_tokens?: number }) {
    return {
      model: "test-model",
      maxTokens: 32768,
      system: "",
      messages: [{ role: "user" as const, content: "hi" }],
      ...(thinking ? { thinking } : {}),
    };
  }

  test("anthropic 渠道:xhigh 预算以 enabled+budget_tokens 出网,max_tokens 含思考封顶", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("anthropic-messages").createMessage(createTestParams({ type: "enabled", budget_tokens: 16384 })),
    ).rejects.toThrow(PiAiProviderError);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      max_tokens: 32768,
      thinking: { type: "enabled", budget_tokens: 16384 },
    });
  });

  test("anthropic 渠道:medium 档按用户预算出网而非坍缩的默认 8192", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("anthropic-messages").createMessage(createTestParams({ type: "enabled", budget_tokens: 4096 })),
    ).rejects.toThrow(PiAiProviderError);
    expect(bodies[0]?.thinking).toMatchObject({ type: "enabled", budget_tokens: 4096 });
  });

  test("openai-completions 渠道:xhigh 折到 reasoning_effort high,不带 thinking 预算字段", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("openai-completions").createMessage(createTestParams({ type: "enabled", budget_tokens: 16384 })),
    ).rejects.toThrow(PiAiProviderError);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      max_completion_tokens: 32768,
      reasoning_effort: "high",
    });
    expect(bodies[0]?.thinking).toBeUndefined();
  });

  test("openai-completions 渠道:medium 档出网 reasoning_effort medium", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("openai-completions").createMessage(createTestParams({ type: "enabled", budget_tokens: 4096 })),
    ).rejects.toThrow(PiAiProviderError);
    expect(bodies[0]?.reasoning_effort).toBe("medium");
  });

  test("anthropic 渠道:thinking 缺失时按旧语义发 medium 思考而非显式关闭(#631 review)", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("anthropic-messages").createMessage(createTestParams()),
    ).rejects.toThrow(PiAiProviderError);
    // pi-ai 默认预算表 medium→8192;若回归成 {} 则出网变 thinkingEnabled:false
    expect(bodies[0]?.thinking).toMatchObject({ type: "enabled", budget_tokens: 8192 });
  });

  test("thinkingLevelMap 到达内联 Model:有目录 map 时 xhigh 直发不折算(#561/#631 review)", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("openai-completions", {
        thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" },
      }).createMessage(createTestParams({ type: "enabled", budget_tokens: 16384 })),
    ).rejects.toThrow(PiAiProviderError);
    // 对照上方用例:无 map 时 clampThinkingLevel 把 xhigh 折成 high;map 背书后保留 xhigh
    expect(bodies[0]?.reasoning_effort).toBe("xhigh");
  });

  test("compat 到达内联 Model:supportsReasoningEffort=false 抑制 reasoning_effort 注入(#631 review)", async () => {
    const bodies = stubCapture(400);
    await expect(
      createTestProvider("openai-completions", {
        compat: { supportsReasoningEffort: false },
      }).createMessage(createTestParams({ type: "enabled", budget_tokens: 4096 })),
    ).rejects.toThrow(PiAiProviderError);
    expect(bodies[0]?.reasoning_effort).toBeUndefined();
  });
});
