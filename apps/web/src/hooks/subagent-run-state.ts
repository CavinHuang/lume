import type { SDKMessage, SubagentRunRecord } from "@lume/shared"

export function upsertRunFromSubagentStreamMessage(
  prev: Record<string, SubagentRunRecord[]>,
  threadId: string,
  message: SDKMessage,
): Record<string, SubagentRunRecord[]> {
  const runId = (message as { subagent_run_id?: string }).subagent_run_id
  if (!runId) return prev

  const threadRuns = prev[threadId] ?? []
  const existingIndex = threadRuns.findIndex((run) => run.runId === runId)
  const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined
  const now = Date.now()

  if (existingIndex >= 0) {
    if (!parentToolUseId || threadRuns[existingIndex]?.parentToolUseId) {
      return prev
    }
    const updated = [...threadRuns]
    updated[existingIndex] = {
      ...updated[existingIndex],
      parentToolUseId,
      updatedAt: now,
    }
    return { ...prev, [threadId]: updated }
  }

  return {
    ...prev,
    [threadId]: [
      ...threadRuns,
      {
        runId,
        parentThreadId: threadId,
        rootThreadId: threadId,
        depth: 0,
        childThreadId: "",
        task: "",
        status: "running",
        cleanup: "keep",
        ...(parentToolUseId ? { parentToolUseId } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
}
