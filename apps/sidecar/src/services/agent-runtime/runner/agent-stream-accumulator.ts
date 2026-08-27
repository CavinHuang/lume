import type { SDKMessage } from "@lume/shared";

// #527-12：唯一消费是流结束时的布尔判定，改为增量标志位，
// 不再留存全量 SDKMessage（长跑 run 的无界内存）
export interface AgentStreamAccumulatorState {
  hasRenderable: boolean;
}

export function createAgentStreamAccumulatorState(): AgentStreamAccumulatorState {
  return { hasRenderable: false };
}

export function appendSdkMessage(
  state: AgentStreamAccumulatorState,
  message: SDKMessage
): AgentStreamAccumulatorState {
  if (!state.hasRenderable && isRenderableSdkMessage(message)) {
    state.hasRenderable = true;
  }
  return state;
}

export function hasRenderableAssistantOutput(state: AgentStreamAccumulatorState): boolean {
  return state.hasRenderable;
}

function isRenderableSdkMessage(message: SDKMessage): boolean {
  if (message.type === "assistant") {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      return block.type === "text" || block.type === "thinking" || block.type === "tool_use";
    });
  }
  if (message.type === "user") {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    return content.some((block) => !!block && typeof block === "object" && block.type === "tool_result");
  }
  if (message.type === "system") {
    return (
      message.subtype === "task_started" ||
      message.subtype === "task_progress" ||
      message.subtype === "task_notification" ||
      message.subtype === "context_compaction_started" ||
      message.subtype === "context_compaction_progress" ||
      message.subtype === "compact_boundary"
    );
  }
  return false;
}
