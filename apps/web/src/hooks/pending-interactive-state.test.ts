import { describe, expect, test } from "bun:test"
import type {
  AgentAskUserQuestionRequest,
  AgentPendingInteractiveState,
  AgentToolPermissionRequest,
} from "@lume/shared"
import {
  removePendingAskUserQuestion,
  removePendingToolPermission,
  upsertPendingAskUserQuestion,
  upsertPendingToolPermission,
} from "./pending-interactive-state"

describe("pending interactive state helpers", () => {
  test("同一线程应能累计多个 AskUserQuestion 请求", () => {
    const first: AgentAskUserQuestionRequest = {
      threadId: "parent-thread",
      originThreadId: "child-a",
      subagentRunId: "run-a",
      toolUseId: "ask-1",
      questions: []
    }
    const second: AgentAskUserQuestionRequest = {
      threadId: "parent-thread",
      originThreadId: "child-b",
      subagentRunId: "run-b",
      toolUseId: "ask-2",
      questions: []
    }

    const next = upsertPendingAskUserQuestion({}, first)
    const merged = upsertPendingAskUserQuestion(next, second)

    expect(merged["parent-thread"]?.askUserQuestions?.map((item) => item.toolUseId)).toEqual(["ask-1", "ask-2"])
  })

  test("同一线程应能累计多个 tool permission 请求，并可按 requestId 删除", () => {
    const first: AgentToolPermissionRequest = {
      threadId: "parent-thread",
      originThreadId: "child-a",
      subagentRunId: "run-a",
      requestId: "perm-1",
      toolUseId: "tool-1",
      toolName: "Write",
      risk: "medium",
      reason: "need permission",
      input: {}
    }
    const second: AgentToolPermissionRequest = {
      threadId: "parent-thread",
      originThreadId: "child-b",
      subagentRunId: "run-b",
      requestId: "perm-2",
      toolUseId: "tool-2",
      toolName: "Bash",
      risk: "high",
      reason: "need permission",
      input: {}
    }

    const next = upsertPendingToolPermission({}, first)
    const merged = upsertPendingToolPermission(next, second)
    const removed = removePendingToolPermission(merged, "parent-thread", "perm-1")

    expect(merged["parent-thread"]?.toolPermissions?.map((item) => item.requestId)).toEqual(["perm-1", "perm-2"])
    expect(removed["parent-thread"]?.toolPermissions?.map((item) => item.requestId)).toEqual(["perm-2"])
  })

  test("删除最后一个 ask request 后应保留线程容器中的其他交互项", () => {
    const base: Record<string, AgentPendingInteractiveState> = {
      "parent-thread": {
        threadId: "parent-thread",
        askUserQuestions: [{
          threadId: "parent-thread",
          toolUseId: "ask-1",
          questions: []
        }],
        toolPermissions: [{
          threadId: "parent-thread",
          requestId: "perm-1",
          toolUseId: "tool-1",
          toolName: "Write",
          risk: "medium",
          reason: "need permission",
          input: {}
        }]
      }
    }

    const next = removePendingAskUserQuestion(base, "parent-thread", "ask-1")

    expect(next["parent-thread"]?.askUserQuestions).toEqual([])
    expect(next["parent-thread"]?.toolPermissions?.map((item) => item.requestId)).toEqual(["perm-1"])
  })
})
