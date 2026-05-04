import { afterEach, describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "@lume/shared"
import type { PlanStateTracker } from "../services/agent/plan-state-tracker"
import { createAgentHandlers } from "./agent-handlers"
import {
  setAskUserQuestionApprovalSession,
  submitPiAskUserQuestionAnswers,
  waitForPiAskUserQuestionAnswers
} from "../services/pi-agent/tools/bridges/ask-user-question-bridge"
import {
  setToolPermissionApprovalSession,
  submitToolPermissionDecision,
  waitForToolPermissionDecision
} from "../services/pi-agent/tools/bridges/tool-permission-bridge"

function createTestPlanStateTracker(): PlanStateTracker {
  return {
    isLikelyExecutionRequest: () => false,
    syncExecutionFromUserMessage: () => undefined,
    syncExecutionFromSendInput: () => undefined,
    getPhase: () => "idle",
    markCurrentStepCompleted: () => undefined,
    markCurrentStepFailed: () => undefined,
    clearSession: () => undefined,
  } as unknown as PlanStateTracker
}

describe("agent-handlers pending interactive aggregation", () => {
  afterEach(() => {
    submitToolPermissionDecision({ threadId: "parent-thread", requestId: "perm-1", decision: "deny" })
    submitToolPermissionDecision({ threadId: "parent-thread", requestId: "perm-2", decision: "deny" })
    submitPiAskUserQuestionAnswers({ threadId: "parent-thread", toolUseId: "ask-1", canceled: true })
    submitPiAskUserQuestionAnswers({ threadId: "parent-thread", toolUseId: "ask-2", canceled: true })
  })

  test("GET_PENDING_INTERACTIVE 应按父线程返回全部待处理请求，而不是只取第一条", async () => {
    const askWaitA = waitForPiAskUserQuestionAnswers(
      "child-thread-a",
      "ask-1",
      [{
        header: "Q1",
        question: "pick",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" }
        ],
        multiSelect: false
      }],
      new AbortController().signal,
      () => {}
    )
    const askWaitB = waitForPiAskUserQuestionAnswers(
      "child-thread-b",
      "ask-2",
      [{
        header: "Q2",
        question: "pick",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" }
        ],
        multiSelect: false
      }],
      new AbortController().signal,
      () => {}
    )
    setAskUserQuestionApprovalSession("ask-1", "parent-thread")
    setAskUserQuestionApprovalSession("ask-2", "parent-thread")

    const permWaitA = waitForToolPermissionDecision(
      {
        threadId: "child-thread-a",
        requestId: "perm-1",
        toolUseId: "tool-1",
        toolName: "Write",
        risk: "medium",
        reason: "need permission",
        input: { file: "a.ts" }
      },
      new AbortController().signal,
      () => {}
    )
    const permWaitB = waitForToolPermissionDecision(
      {
        threadId: "child-thread-b",
        requestId: "perm-2",
        toolUseId: "tool-2",
        toolName: "Bash",
        risk: "high",
        reason: "need permission",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    )
    setToolPermissionApprovalSession("perm-1", "parent-thread")
    setToolPermissionApprovalSession("perm-2", "parent-thread")

    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined
    })

    const result = await handlers[AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE]!({ threadId: "parent-thread" }) as Array<{
      threadId: string
      askUserQuestions?: Array<{ toolUseId: string; originThreadId?: string }>
      toolPermissions?: Array<{ requestId: string; originThreadId?: string }>
    }>

    expect(result).toHaveLength(1)
    expect(result[0]?.threadId).toBe("parent-thread")
    expect(result[0]?.askUserQuestions?.map((item) => item.toolUseId)).toEqual(["ask-1", "ask-2"])
    expect(result[0]?.toolPermissions?.map((item) => item.requestId)).toEqual(["perm-1", "perm-2"])
    expect(result[0]?.askUserQuestions?.map((item) => item.originThreadId)).toEqual(["child-thread-a", "child-thread-b"])
    expect(result[0]?.toolPermissions?.map((item) => item.originThreadId)).toEqual(["child-thread-a", "child-thread-b"])

    submitToolPermissionDecision({ threadId: "parent-thread", requestId: "perm-1", decision: "allow_once" })
    submitToolPermissionDecision({ threadId: "parent-thread", requestId: "perm-2", decision: "allow_once" })
    submitPiAskUserQuestionAnswers({ threadId: "parent-thread", toolUseId: "ask-1", answers: { pick: "A" } })
    submitPiAskUserQuestionAnswers({ threadId: "parent-thread", toolUseId: "ask-2", answers: { pick: "B" } })

    await Promise.all([askWaitA, askWaitB, permWaitA, permWaitB])
  })
})
