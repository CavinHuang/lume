import { describe, expect, test } from "bun:test"
import { trimSdkMessagesForTransport } from "./message-payload-trim"
import type { AgentMessage, SDKMessage } from "@lume/shared"

function msg(sdkMessages?: SDKMessage[]): AgentMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "hi",
    createdAt: 1,
    sdkMessages,
  } as unknown as AgentMessage
}

describe("trimSdkMessagesForTransport", () => {
  test("keeps compaction system messages, drops the rest", () => {
    const full: SDKMessage[] = [
      { type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage,
      { type: "system", subtype: "context_compaction_started" } as SDKMessage,
      { type: "user", message: { role: "user", content: [] } } as SDKMessage,
      { type: "system", subtype: "compact_boundary" } as SDKMessage,
    ]
    const trimmed = trimSdkMessagesForTransport(msg(full))
    expect(trimmed.sdkMessages).toHaveLength(2)
    expect((trimmed.sdkMessages ?? []).every((m) => m.type === "system")).toBe(true)
  })

  test("sets sdkMessages undefined when none are compaction", () => {
    const full: SDKMessage[] = [
      { type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage,
      { type: "user", message: { role: "user", content: [] } } as SDKMessage,
    ]
    expect(trimSdkMessagesForTransport(msg(full)).sdkMessages).toBeUndefined()
  })

  test("returns same reference when there are no sdkMessages", () => {
    const m = msg(undefined)
    expect(trimSdkMessagesForTransport(m)).toBe(m)
  })

  test("payload shrinks: trimmed JSON is smaller than full JSON", () => {
    const heavy: SDKMessage[] = Array.from({ length: 20 }, () => ({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(500) }] },
    } as SDKMessage))
    heavy.push({ type: "system", subtype: "compact_boundary" } as SDKMessage)
    const full = msg(heavy)
    const trimmed = trimSdkMessagesForTransport(full)
    expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(full).length)
  })
})
