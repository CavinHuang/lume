import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"
import type {
  MemoryContextUsedDetail,
  SdkLifecycleDetail,
  ToolEndDetail,
  ToolStartDetail,
} from "./agent-events.js"

describe("agent event bus channels", () => {
  test("exposes EVENTS push channel and GET_EVENTS request channel", () => {
    expect(AGENT_IPC_CHANNELS.EVENTS).toBe("agent:events")
    expect(AGENT_IPC_CHANNELS.GET_EVENTS).toBe("agent:get-events")
  })
})

describe("tool skeleton detail types", () => {
  test("ToolStartDetail fields and union membership", () => {
    const d: ToolStartDetail = { type: "tool.start", toolCallId: "t1", toolName: "Bash", input: { cmd: "ls" } }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("tool.start")
    if (detail.type === "tool.start") {
      expect(detail.toolCallId).toBe("t1")
      expect(detail.toolName).toBe("Bash")
      expect(detail.input).toEqual({ cmd: "ls" })
    }
  })

  test("ToolEndDetail fields and union membership", () => {
    const d: ToolEndDetail = { type: "tool.end", toolCallId: "t1", toolName: "Bash", isError: false, output: "done" }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("tool.end")
    if (detail.type === "tool.end") {
      expect(detail.isError).toBe(false)
      expect(detail.output).toBe("done")
      expect(detail.meta).toBeUndefined()
    }
  })
})

describe("memory context detail type", () => {
  test("MemoryContextUsedDetail fields and union membership", () => {
    const d: MemoryContextUsedDetail = {
      type: "memory.context.used",
      items: [
        {
          id: "m1",
          kind: "entity",
          scope: "user",
          status: "active",
          citation: "[1]",
          reason: "mentioned in prompt",
        },
      ],
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("memory.context.used")
    if (detail.type === "memory.context.used") {
      expect(detail.items).toHaveLength(1)
      expect(detail.items[0]?.id).toBe("m1")
      expect(detail.items[0]?.fileRef).toBeUndefined()
      expect(detail.items[0]?.claim).toBeUndefined()
    }
  })
})
