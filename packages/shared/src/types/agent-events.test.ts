import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"
import type {
  BackgroundTaskNotificationDetail,
  ContextCompactionDetail,
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

describe("batch 4 domain detail types", () => {
  test("BackgroundTaskNotificationDetail fields and union membership", () => {
    const d: BackgroundTaskNotificationDetail = {
      type: "background.task",
      taskId: "bt1",
      status: "completed",
      message: "Background task finished",
      summary: "Summarized background task result",
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("background.task")
    if (detail.type === "background.task") {
      expect(detail.taskId).toBe("bt1")
      expect(detail.status).toBe("completed")
      expect(detail.message).toBe("Background task finished")
      expect(detail.summary).toBe("Summarized background task result")
      expect(detail.execution).toBeUndefined()
    }
  })

  test("ContextCompactionDetail fields and union membership", () => {
    const d: ContextCompactionDetail = {
      type: "context.compaction",
      phase: "progress",
      preTokens: 1200,
      progress: 45,
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("context.compaction")
    if (detail.type === "context.compaction") {
      expect(detail.phase).toBe("progress")
      expect(detail.preTokens).toBe(1200)
      expect(detail.progress).toBe(45)
      expect(detail.postTokens).toBeUndefined()
      expect(detail.result).toBeUndefined()
      expect(detail.isError).toBeUndefined()
    }
    // completed 形态: postTokens 仅完成相位携带
    const done: ContextCompactionDetail = {
      type: "context.compaction",
      phase: "completed",
      preTokens: 1200,
      postTokens: 300,
      result: "compacted",
      isError: false,
    }
    expect(done.postTokens).toBe(300)
  })
})
