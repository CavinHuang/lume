import { describe, expect, test } from "bun:test"
import type {
  AgentAskUserQuestionRequest,
  AgentPendingInteractiveState,
  AgentTaskApprovalRequest,
  AgentToolPermissionRequest,
  LumeRuntimeEvent,
} from "@lume/shared"
import {
  planPreviewToPendingTaskApproval,
  removePendingAskUserQuestion,
  removePendingTaskApprovalsForThread,
  removePendingTaskApproval,
  removePendingToolPermission,
  removePendingToolPermissionEverywhere,
  upsertPendingAskUserQuestion,
  upsertPendingTaskApproval,
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

  test("同一线程应能累计多个任务审批请求，并可按 contractId 删除", () => {
    const first: AgentTaskApprovalRequest = {
      threadId: "parent-thread",
      requestId: "task_approval:plan-1",
      contractId: "plan-1",
      title: "确认任务清单",
      message: "Approve plan 1",
      stepCount: 1
    }
    const second: AgentTaskApprovalRequest = {
      threadId: "parent-thread",
      requestId: "task_approval:plan-2",
      contractId: "plan-2",
      title: "确认任务清单",
      message: "Approve plan 2",
      stepCount: 2
    }

    const next = upsertPendingTaskApproval({}, first)
    const merged = upsertPendingTaskApproval(next, second)
    const removed = removePendingTaskApproval(merged, "parent-thread", "plan-1")

    expect(merged["parent-thread"]?.taskApprovals?.map((item) => item.contractId)).toEqual(["plan-1", "plan-2"])
    expect(removed["parent-thread"]?.taskApprovals?.map((item) => item.contractId)).toEqual(["plan-2"])
  })

  test("plan.preview runtime event should immediately become a pending task approval", () => {
    const request = planPreviewToPendingTaskApproval({
      id: "run-1:plan:plan-1:plan.preview",
      type: "plan.preview",
      threadId: "thread-1",
      runId: "run-1",
      createdAt: "2026-05-16T00:00:00.000Z",
      contractId: "plan-1",
      title: "补齐计划模式",
      summary: "准备执行计划",
      markdown: "# 补齐计划模式",
      planFilePath: "plans/plan-1.md",
      planVerified: true,
      stepCount: 3,
    } as Extract<LumeRuntimeEvent, { type: "plan.preview" }>)

    expect(request).toEqual({
      threadId: "thread-1",
      runId: "run-1",
      requestId: "task_approval:plan-1",
      contractId: "plan-1",
      title: "补齐计划模式",
      message: "审阅任务计划",
      summary: "准备执行计划",
      stepCount: 3,
      planFilePath: "plans/plan-1.md",
      planVerified: true,
    })
  })

  test("线程进入执行态时应能清空该线程所有任务审批请求", () => {
    const state = {
      "parent-thread": {
        threadId: "parent-thread",
        taskApprovals: [
          {
            threadId: "parent-thread",
            requestId: "task_approval:plan-1",
            contractId: "plan-1",
            title: "确认任务清单",
            message: "Approve plan 1",
            stepCount: 1,
          },
          {
            threadId: "parent-thread",
            requestId: "task_approval:plan-2",
            contractId: "plan-2",
            title: "确认任务清单",
            message: "Approve plan 2",
            stepCount: 2,
          },
        ],
      },
      "other-thread": {
        threadId: "other-thread",
        taskApprovals: [{
          threadId: "other-thread",
          requestId: "task_approval:plan-3",
          contractId: "plan-3",
          title: "确认任务清单",
          message: "Approve plan 3",
          stepCount: 1,
        }],
      },
    }

    const next = removePendingTaskApprovalsForThread(state, "parent-thread")

    expect(next["parent-thread"]?.taskApprovals).toEqual([])
    expect(next["other-thread"]?.taskApprovals?.map((item) => item.contractId)).toEqual(["plan-3"])
  })
})
