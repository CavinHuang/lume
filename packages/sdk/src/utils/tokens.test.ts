import { beforeEach, describe, expect, mock, test } from "bun:test"

let nativeTokenCount = 0
const countStringTokensMock = mock((_text: string, _model?: string) => nativeTokenCount)

mock.module("@lume/natives", () => ({
  countStringTokens: countStringTokensMock,
}))

const { estimateMessagesTokens, estimateTokens } = await import("./tokens.js")

describe("token estimation", () => {
  beforeEach(() => {
    nativeTokenCount = 0
    countStringTokensMock.mockClear()
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
