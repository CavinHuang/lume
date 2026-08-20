import { beforeEach, describe, expect, test } from "bun:test"
import { isNativeAvailable } from "@lume/natives"
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
})
