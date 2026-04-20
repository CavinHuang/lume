import { describe, expect, test } from "bun:test"
import type { SDKMessage, SubagentRunRecord } from "@lume/shared"
import { upsertRunFromSubagentStreamMessage } from "./subagent-run-state"

describe("subagent run state helpers", () => {
  test("应使用流事件上的 parent_tool_use_id 显式绑定 subagent run", () => {
    const next = upsertRunFromSubagentStreamMessage(
      {},
      "parent-thread",
      {
        type: "assistant",
        subagent_run_id: "run-1",
        parent_tool_use_id: "agent-tool-1",
        message: {
          role: "assistant",
          content: []
        }
      } as SDKMessage
    )

    expect(next["parent-thread"]?.[0]?.runId).toBe("run-1")
    expect(next["parent-thread"]?.[0]?.parentToolUseId).toBe("agent-tool-1")
  })

  test("缺少 parent_tool_use_id 时不应覆盖已有显式绑定", () => {
    const base: Record<string, SubagentRunRecord[]> = {
      "parent-thread": [{
        runId: "run-1",
        parentThreadId: "parent-thread",
        rootThreadId: "parent-thread",
        depth: 1,
        childThreadId: "child-1",
        task: "task",
        status: "running",
        cleanup: "keep",
        parentToolUseId: "agent-tool-1",
        createdAt: 1,
        updatedAt: 1
      }]
    }

    const next = upsertRunFromSubagentStreamMessage(
      base,
      "parent-thread",
      {
        type: "assistant",
        subagent_run_id: "run-1",
        message: {
          role: "assistant",
          content: []
        }
      } as SDKMessage
    )

    expect(next["parent-thread"]?.[0]?.parentToolUseId).toBe("agent-tool-1")
  })
})
