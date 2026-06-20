import type { SDKMessage } from "@lume/shared";

export interface AgentStreamAccumulatorState {
  messages: SDKMessage[];
}

export function createAgentStreamAccumulatorState(): AgentStreamAccumulatorState {
  return {
    messages: []
  };
}

export function appendSdkMessage(
  state: AgentStreamAccumulatorState,
  message: SDKMessage
): AgentStreamAccumulatorState {
  state.messages.push(message);
  return state;
}

export function hasRenderableAssistantOutput(state: AgentStreamAccumulatorState): boolean {
  return state.messages.some((message) => {
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
  });
}
