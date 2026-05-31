import { describe, expect, test } from "bun:test"
import { estimateMessagesTokens, estimateTokens } from "./tokens.js"

describe("token estimation", () => {
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
