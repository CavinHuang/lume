import { beforeEach, describe, expect, test } from "bun:test"
import { isNativeAvailable } from "@lume/natives"

const { estimateMessagesTokens, estimateTokens, __resetMessageTokenCacheForTests } = await import("./tokens.js")

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
