import type { AgentMessage } from "@lume/shared";

export function trimMessagesFromTarget(messages: AgentMessage[], messageId: string): AgentMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    return messages;
  }
  return messages.slice(0, index);
}
