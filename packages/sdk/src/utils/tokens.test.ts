import { beforeEach, describe, expect, test } from "bun:test"
import { countStringTokens, isNativeAvailable } from "@lume/natives"
import { findModelMeta } from "@lume/shared"

const { estimateCost, estimateMessagesTokens, estimateTokens, getContextWindowSize, __resetMessageTokenCacheForTests } = await import("./tokens.js")

describe("token estimation", () => {
  beforeEach(() => {
    __resetMessageTokenCacheForTests()
  })

  test("roughly estimates ASCII-heavy text", () => {
    expect(estimateTokens("hello world")).toBe(isNativeAvailable() ? 2 : 3)
  })

  test("counts CJK characters as full tokens instead of ASCII quarters", () => {
    expect(estimateTokens("你好世界")).toBe(isNativeAvailable() ? 2 : 4)
  })

  test("uses content-aware estimates for rich message blocks", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "12345678" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(40_000) } },
        ],
      },
    ])

    expect(tokens).toBe(2_000 + estimateTokens("12345678"))
  })
})

describe("#736 tiktoken long-run O(n²) guard", () => {
  test("single-piece homogeneous run returns fast instead of stalling the loop", () => {
    // 80KB 无换行同构游程:natives 直调实测 ~2s(#736 表格),同步路径不可接受
    const text = "a".repeat(80 * 1024)
    const t0 = performance.now()
    const tokens = estimateTokens(text)
    const ms = performance.now() - t0
    expect(tokens).toBeGreaterThan(0)
    expect(ms).toBeLessThan(500)
  })

  test("healthy long prose still routes through exact native counting", () => {
    if (!isNativeAvailable()) return
    const sentence = "The quick brown fox jumps over the lazy dog near the river bank. "
    const text = sentence.repeat(Math.ceil((256 * 1024) / sentence.length))
    expect(estimateTokens(text)).toBe(countStringTokens(text))
  })
})

describe("estimateMessagesTokens per-message cache", () => {
  beforeEach(() => {
    __resetMessageTokenCacheForTests()
  })

  test("cached recount equals full recount and is stable on append", () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: [{ type: "text", text: "response one" }] },
    ]
    const first = estimateMessagesTokens(messages)
    const second = estimateMessagesTokens(messages)
    expect(second).toBe(first)

    const appended = [...messages, { role: "user", content: "second turn" }]
    const third = estimateMessagesTokens(appended)
    expect(third).toBe(first + estimateMessagesTokens([appended[2]!]))
  })

  test("replacing the array (compaction) recounts new objects without stale hits", () => {
    const before = [
      { role: "user", content: "old one" },
      { role: "assistant", content: "old two" },
    ]
    estimateMessagesTokens(before)

    const after = [
      { role: "user", content: "compacted summary" },
      { role: "assistant", content: "resumed" },
    ]

    expect(estimateMessagesTokens(after)).toBe(
      estimateTokens("compacted summary") + estimateTokens("resumed"),
    )
  })
})

describe("estimateCost / getContextWindowSize (#229)", () => {
  test("gpt-4o-mini uses its own pricing, not the gpt-4o prefix match", () => {
    // 16.7x over-billing regression pin
    expect(estimateCost("gpt-4o-mini", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(0.15 + 0.6)
    expect(estimateCost("gpt-4o", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(2.5 + 10)
    // dated variants still resolve to the family rate
    expect(estimateCost("gpt-4o-2024-11-20", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(2.5 + 10)
  })

  test("gpt-4.1 family keys resolve (dotted ids are the real model ids)", () => {
    expect(estimateCost("gpt-4.1", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(2 + 8)
    expect(getContextWindowSize("gpt-4.1")).toBe(1_000_000)
    expect(getContextWindowSize("gpt-4.1-mini")).toBe(1_000_000)
  })

  test("cache reads bill at 0.1x and cache writes at 1.25x of the input price (#352)", () => {
    // sonnet input price = 3 USD / 1M tokens
    expect(estimateCost("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    })).toBeCloseTo(3 * 0.1)
    expect(estimateCost("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    })).toBeCloseTo(3 * 1.25)
    expect(estimateCost("claude-sonnet-4-6", {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 20_000,
    })).toBeCloseTo(
      100 * 3 / 1e6
      + 10 * 15 / 1e6
      + 500_000 * 3 / 1e6 * 0.1
      + 20_000 * 3 / 1e6 * 1.25,
    )
    // absent cache fields keep the plain io cost
    expect(estimateCost("claude-sonnet-4-6", { input_tokens: 100, output_tokens: 10 })).toBeCloseTo(
      100 * 3 / 1e6 + 10 * 15 / 1e6,
    )
  })

  test("unlisted models fall back to the shared registry pricing, not the flat default", () => {
    // pick a model that only exists in the shared registry, priced differently from 3/15
    const meta = findModelMeta("glm-4.6")
    if (meta?.pricing) {
      const cost = estimateCost("glm-4.6", { input_tokens: 1e6, output_tokens: 1e6 })
      expect(cost).toBeCloseTo(meta.pricing.input + meta.pricing.output)
      expect(cost).not.toBeCloseTo(3 + 15)
    }
  })

  test("known window heuristics stay stable", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000)
    expect(getContextWindowSize("claude-opus-4-5")).toBe(200_000)
  })

  test("models missing from the table fall back to the shared registry (#366)", () => {
    // gemini-2.5-pro has a 1M window in the catalog but no table entry.
    const meta = findModelMeta("gemini-2.5-pro")
    expect(meta?.contextWindow).toBeTruthy()
    expect(getContextWindowSize("gemini-2.5-pro")).toBe(meta!.contextWindow)
    expect(getContextWindowSize("gemini-2.5-pro")).not.toBe(200_000)
  })

  test("unknown models still land on the flat default", () => {
    expect(getContextWindowSize("definitely-not-a-model-12345")).toBe(200_000)
  })
})
