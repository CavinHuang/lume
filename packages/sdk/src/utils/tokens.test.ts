import { beforeEach, describe, expect, mock, test } from "bun:test"

let nativeTokenCount = 0
const countStringTokensMock = mock((_text: string, _model?: string) => nativeTokenCount)

mock.module("@lume/natives", () => ({
  countStringTokens: countStringTokensMock,
}))

const { estimateMessagesTokens, estimateTokens, __resetMessageTokenCacheForTests } = await import("./tokens.js")

describe("token estimation", () => {
  beforeEach(() => {
    nativeTokenCount = 0
    countStringTokensMock.mockClear()
    __resetMessageTokenCacheForTests()
  })

  test("uses native token counting when available", () => {
    nativeTokenCount = 17

    expect(estimateTokens("hello world")).toBe(17)
  })

  test("counts CJK characters as full tokens instead of ASCII quarters", () => {
    expect(estimateTokens("你好世界")).toBe(4)
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

    expect(tokens).toBe(2_002)
  })
})

describe("estimateMessagesTokens per-message cache", () => {
  test("cached recount equals full recount and is stable on append", () => {
    nativeTokenCount = 5
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

  test("cache hit skips native tokenize on the second pass", () => {
    nativeTokenCount = 7
    const messages = [
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
      { role: "user", content: "gamma" },
    ]

    estimateMessagesTokens(messages) // 首次：每条消息触发 native
    countStringTokensMock.mockClear()
    estimateMessagesTokens(messages) // 再次：应全部命中缓存

    expect(countStringTokensMock).toHaveBeenCalledTimes(0)
  })

  test("replacing the array (compaction) recounts new objects, no stale hits", () => {
    nativeTokenCount = 3
    const before = [
      { role: "user", content: "old one" },
      { role: "assistant", content: "old two" },
    ]
    estimateMessagesTokens(before) // 缓存 before 的两条

    const after = [
      { role: "user", content: "compacted summary" },
      { role: "assistant", content: "resumed" },
    ]
    countStringTokensMock.mockClear()
    estimateMessagesTokens(after) // 新对象 → 重新计数

    expect(countStringTokensMock).toHaveBeenCalled()
    expect(countStringTokensMock.mock.calls.length).toBeGreaterThan(0)
  })
})
