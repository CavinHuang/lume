import { describe, expect, test } from "bun:test"
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentPendingInteractiveState,
  AgentToolPermissionRequest,
} from "@lume/shared"
import {
  removePendingAskUserQuestion,
  removePendingBrowserAuthRequest,
  removePendingToolPermission,
  removePendingToolPermissionEverywhere,
  upsertPendingAskUserQuestion,
  upsertPendingBrowserAuthRequest,
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

  test("同一线程应能累计并删除 browserAuth 请求", () => {
    const first: AgentBrowserAuthRequest = {
      threadId: "parent-thread",
      requestId: "auth-1",
      origin: "https://accounts.example.test",
      reason: "Sign in.",
      expiresAt: "2026-07-03T12:00:00.000Z",
      fields: [{ id: "password", label: "Password", type: "password", required: true }],
    }
    const second: AgentBrowserAuthRequest = {
      threadId: "parent-thread",
      requestId: "auth-2",
      origin: "https://mfa.example.test",
      reason: "Enter one-time code.",
      expiresAt: "2026-07-03T12:01:00.000Z",
      fields: [{ id: "otp", label: "Code", type: "text", autocomplete: "one-time-code", required: true }],
    }

    const next = upsertPendingBrowserAuthRequest({}, first)
    const merged = upsertPendingBrowserAuthRequest(next, second)
    const removed = removePendingBrowserAuthRequest(merged, "parent-thread", "auth-1")

    expect(merged["parent-thread"]?.browserAuthRequests?.map((item) => item.requestId)).toEqual(["auth-1", "auth-2"])
    expect(removed["parent-thread"]?.browserAuthRequests?.map((item) => item.requestId)).toEqual(["auth-2"])
    expect(JSON.stringify(merged)).not.toContain("secret")
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

  test("工具权限确认后应能按 requestId 从所有线程容器删除", () => {
    const base: Record<string, AgentPendingInteractiveState> = {
      "parent-thread": {
        threadId: "parent-thread",
        toolPermissions: [{
          threadId: "parent-thread",
          requestId: "perm-shared",
          toolUseId: "tool-parent",
          toolName: "Write",
          risk: "medium",
          reason: "need permission",
          input: {}
        }]
      },
      "child-thread": {
        threadId: "child-thread",
        toolPermissions: [{
          threadId: "child-thread",
          requestId: "perm-shared",
          toolUseId: "tool-child",
          toolName: "Write",
          risk: "medium",
          reason: "need permission",
          input: {}
        }]
      }
    }

    const next = removePendingToolPermissionEverywhere(base, "perm-shared")

    expect(next["parent-thread"]?.toolPermissions).toEqual([])
    expect(next["child-thread"]?.toolPermissions).toEqual([])
  })

  test("跨线程删除时应保留未包含目标 requestId 线程的引用（守护 Object.is 不变量）", () => {
    const stateA: AgentPendingInteractiveState = {
      threadId: "thread-a",
      toolPermissions: [{
        threadId: "thread-a",
        requestId: "perm-other",
        toolUseId: "tool-a",
        toolName: "Write",
        risk: "medium",
        reason: "need permission",
        input: {}
      }]
    }
    const stateB: AgentPendingInteractiveState = {
      threadId: "thread-b",
      toolPermissions: [{
        threadId: "thread-b",
        requestId: "perm-target",
        toolUseId: "tool-b",
        toolName: "Write",
        risk: "medium",
        reason: "need permission",
        input: {}
      }]
    }
    const base: Record<string, AgentPendingInteractiveState> = {
      "thread-a": stateA,
      "thread-b": stateB
    }

    const next = removePendingToolPermissionEverywhere(base, "perm-target")

    // 线程 A 未包含目标 requestId：引用必须保持不变（守护 agentPendingInteractiveFamily 的 Object.is 不变量）
    expect(next["thread-a"]).toBe(stateA)
    // 线程 B 包含目标 requestId：引用应改变，且不再包含被删除的 requestId
    expect(next["thread-b"]).not.toBe(stateB)
    expect(next["thread-b"]?.toolPermissions?.map((item) => item.requestId)).toEqual([])
  })

})
