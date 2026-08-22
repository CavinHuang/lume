import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"
import type {
  AdvisorReviewedDetail,
  BackgroundTaskNotificationDetail,
  CodingReportDetail,
  ContextCompactionDetail,
  MemoryContextUsedDetail,
  MessageUpdateDetail,
  PlanPreviewDetail,
  SdkLifecycleDetail,
  TaskProgressDetail,
  TodoStateDetail,
  ToolEndDetail,
  ToolStartDetail,
  UserMessageDetail,
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

  test("ContextCompactionDetail carries trigger and outcome (batch 5 de-scoped fields)", () => {
    const d: ContextCompactionDetail = {
      type: "context.compaction",
      phase: "completed",
      preTokens: 1200,
      postTokens: 300,
      trigger: "auto",
      outcome: "succeeded",
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("context.compaction")
    if (detail.type === "context.compaction") {
      expect(detail.trigger).toBe("auto")
      expect(detail.outcome).toBe("succeeded")
    }
  })

  test("MemoryContextUsedDetail claim accepts structured values", () => {
    const d: MemoryContextUsedDetail = {
      type: "memory.context.used",
      items: [
        {
          id: "m1",
          kind: "fact",
          scope: "workspace",
          status: "active",
          citation: "[2]",
          claim: { text: "prefers bun:test", confidence: 0.9 },
        },
      ],
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("memory.context.used")
    if (detail.type === "memory.context.used") {
      expect(detail.items[0]?.claim).toEqual({ text: "prefers bun:test", confidence: 0.9 })
    }
  })
})

describe("batch 5 message partial folding", () => {
  test("MessageUpdateDetail.partial carries thinking alongside text and toolUses", () => {
    const d: MessageUpdateDetail = {
      type: "message.update",
      delta: { type: "text_delta", text: "hi" },
      partial: { text: "hi", thinking: "pondering", toolUses: [{ id: "t1", name: "Bash", partialJson: "{" }] },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("message.update")
    if (detail.type === "message.update") {
      expect(detail.partial.thinking).toBe("pondering")
      expect(detail.partial.text).toBe("hi")
      expect(detail.partial.toolUses).toHaveLength(1)
    }
  })
})

describe("batch 5 user message detail type", () => {
  test("UserMessageDetail accepts string content and union membership", () => {
    const d: UserMessageDetail = { type: "user.message", content: "hello" }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("user.message")
    if (detail.type === "user.message") {
      expect(detail.content).toBe("hello")
    }
  })

  test("UserMessageDetail accepts structured content parts", () => {
    const d: UserMessageDetail = {
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    }
    expect(Array.isArray(d.content)).toBe(true)
  })
})

describe("batch 5 domain detail types", () => {
  test("PlanPreviewDetail fields and union membership", () => {
    const d: PlanPreviewDetail = {
      type: "plan.preview",
      content: { contractId: "c1", title: "Plan", stepCount: 3 },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("plan.preview")
    if (detail.type === "plan.preview") {
      expect(d.content).toEqual({ contractId: "c1", title: "Plan", stepCount: 3 })
    }
  })

  test("TodoStateDetail fields and union membership", () => {
    const d: TodoStateDetail = {
      type: "todo.state",
      state: { todos: [{ content: "a", activeForm: "doing a", status: "in_progress" }], currentActiveForm: "doing a" },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("todo.state")
    expect(d.state).toEqual({ todos: [{ content: "a", activeForm: "doing a", status: "in_progress" }], currentActiveForm: "doing a" })
  })

  test("TaskProgressDetail fields and union membership", () => {
    const d: TaskProgressDetail = {
      type: "task.progress",
      taskId: "task-1",
      progress: { status: "in_progress", tasks: [] },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("task.progress")
    if (detail.type === "task.progress") {
      expect(detail.taskId).toBe("task-1")
      expect(detail.progress).toEqual({ status: "in_progress", tasks: [] })
    }
  })

  test("AdvisorReviewedDetail fields and union membership", () => {
    const d: AdvisorReviewedDetail = {
      type: "advisor.reviewed",
      summary: "Looks good",
      review: { severity: "suggestion", modelRef: "gpt-5" },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("advisor.reviewed")
    if (detail.type === "advisor.reviewed") {
      expect(detail.summary).toBe("Looks good")
      expect(detail.review).toEqual({ severity: "suggestion", modelRef: "gpt-5" })
    }
    // summary is optional
    const bare: AdvisorReviewedDetail = { type: "advisor.reviewed", review: { severity: "clear" } }
    expect(bare.summary).toBeUndefined()
  })

  test("CodingReportDetail fields and union membership", () => {
    const d: CodingReportDetail = {
      type: "coding.report",
      report: { status: "verified", workspaceChanged: true, changedFiles: ["a.ts"] },
    }
    const detail: SdkLifecycleDetail = d
    expect(detail.type).toBe("coding.report")
    if (detail.type === "coding.report") {
      expect(detail.report).toEqual({ status: "verified", workspaceChanged: true, changedFiles: ["a.ts"] })
    }
  })
})
