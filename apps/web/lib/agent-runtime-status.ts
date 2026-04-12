import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";

export function isAgentRuntimePhaseActive(phase: AgentRuntimePhase | undefined): boolean {
  return phase === "streaming"
    || phase === "awaiting_permission"
    || phase === "awaiting_user_answer"
    || phase === "compacting";
}

export function isAgentRuntimeAwaitingInput(status: AgentRuntimeStatus | null | undefined): boolean {
  return status?.phase === "awaiting_permission" || status?.phase === "awaiting_user_answer";
}

export function isAgentRuntimeStatusActive(status: AgentRuntimeStatus | null | undefined): boolean {
  return isAgentRuntimePhaseActive(status?.phase);
}

export function resolveAgentBusyState(
  status: AgentRuntimeStatus | null | undefined,
  localStreaming: boolean
): boolean {
  // localStreaming 由前端在发送消息时立即设置为 true，
  // 优先尊重它，避免残留的 runtime status (如 completed) 导致状态回退为 false
  if (localStreaming) return true;
  if (status) {
    return isAgentRuntimeStatusActive(status);
  }
  return false;
}

export function formatAgentRuntimeStatusHint(
  status: AgentRuntimeStatus | null | undefined
): string | null {
  if (!status) {
    return null;
  }

  if (status.phase === "awaiting_permission") {
    return joinRuntimeStatusHintParts([
      status.interactiveKind === "tool_permission" ? "等待工具权限确认" : "等待权限确认",
      status.toolName ? `工具: ${status.toolName}` : null,
      status.originThreadId ? `来源会话: ${status.originThreadId}` : null,
      status.subagentRunId ? `Run: ${status.subagentRunId}` : null
    ]);
  }

  if (status.phase === "awaiting_user_answer") {
    return joinRuntimeStatusHintParts([
      status.interactiveKind === "ask_user_question" ? "等待用户回答问题" : "等待用户输入",
      status.originThreadId ? `来源会话: ${status.originThreadId}` : null,
      status.subagentRunId ? `Run: ${status.subagentRunId}` : null
    ]);
  }

  return null;
}

function joinRuntimeStatusHintParts(parts: Array<string | null>): string | null {
  const filtered = parts.filter((part): part is string => Boolean(part));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.join(" · ");
}


