import { describe, expect, test } from "bun:test"
import { isCompactionSdkMessage } from "./agent-compaction"
import type { SDKMessage } from "./types/agent"

describe("isCompactionSdkMessage", () => {
  test("true for the three compaction system subtypes", () => {
    expect(isCompactionSdkMessage({ type: "system", subtype: "context_compaction_started" } as SDKMessage)).toBe(true)
    expect(isCompactionSdkMessage({ type: "system", subtype: "context_compaction_progress" } as SDKMessage)).toBe(true)
    expect(isCompactionSdkMessage({ type: "system", subtype: "compact_boundary" } as SDKMessage)).toBe(true)
  })

  test("false for non-compaction system subtypes and other message types", () => {
    expect(isCompactionSdkMessage({ type: "system", subtype: "success" } as SDKMessage)).toBe(false)
    expect(isCompactionSdkMessage({ type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage)).toBe(false)
    expect(isCompactionSdkMessage({ type: "user", message: { role: "user", content: [] } } as SDKMessage)).toBe(false)
  })
})
