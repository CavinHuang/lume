import type { SDKMessage } from "../types.js"

function isSupportedSubagentStreamingEvent(message: SDKMessage): boolean {
  return message.type === "assistant"
    || message.type === "stream_event"
    || message.type === "tool_result"
    || message.type === "tool_progress"
    || message.type === "user"
}

export function annotateSubagentStreamingEvent(
  message: SDKMessage,
  input: {
    subagentRunId: string
    parentSessionId?: string
    parentToolUseId?: string
  },
): SDKMessage | null {
  if (!isSupportedSubagentStreamingEvent(message)) {
    return null
  }

  return {
    ...message,
    subagent_run_id: input.subagentRunId,
    parent_tool_use_id: input.parentToolUseId ?? (message as SDKMessage & { parent_tool_use_id?: string | null }).parent_tool_use_id,
    session_id: input.parentSessionId ?? (message as SDKMessage & { session_id?: string }).session_id,
  } as SDKMessage
}
