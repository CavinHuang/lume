import type { AgentMessage } from "@lume/shared";
import type { AgentStreamState } from "@/atoms/agent-atoms";
import { extractToolActivitiesFromMessages } from "./agent-tool-activity";

export function buildAssistantDisplayMessage(input: {
  id: string;
  content: string;
  reasoning?: string;
  createdAt: number;
  model?: string;
  metadata?: Record<string, unknown>;
  toolActivities?: AgentStreamState["toolActivities"];
  sdkMessages?: AgentMessage["sdkMessages"];
}): AgentMessage {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {})
  };
  if (input.toolActivities && input.toolActivities.length > 0) {
    metadata.toolActivitiesSnapshot = input.toolActivities;
  }
  if (input.reasoning) {
    metadata.reasoningExpanded = metadata.reasoningExpanded ?? true;
  }
  return {
    id: input.id,
    role: "assistant",
    content: input.content,
    reasoning: input.reasoning,
    createdAt: input.createdAt,
    model: input.model,
    metadata,
    sdkMessages: input.sdkMessages
  };
}

export function enrichAssistantMessages(input: {
  messages: AgentMessage[];
  thinkingDuration?: number;
  toolActivities?: AgentStreamState["toolActivities"];
  targetMessageId?: string;
}): AgentMessage[] {
  const { messages, thinkingDuration, toolActivities, targetMessageId } = input;
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (targetMessageId && message.id !== targetMessageId) return message;
    return buildAssistantDisplayMessage({
      id: message.id,
      content: message.content,
      reasoning: message.reasoning,
      createdAt: message.createdAt,
      model: message.model,
      metadata: {
        ...(message.metadata as Record<string, unknown> | undefined),
        ...(thinkingDuration !== undefined ? { thinkingDuration } : {}),
      },
      toolActivities: toolActivities
        ?? extractToolActivitiesFromMessages([message]),
      sdkMessages: message.sdkMessages
    });
  });
}
