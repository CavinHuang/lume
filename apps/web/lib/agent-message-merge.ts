import type { AgentMessage } from "@lume/shared";

function getPendingClientMessageId(message: AgentMessage): string | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const value = metadata?.pendingClientMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function replaceVisibleMessage(
  messages: AgentMessage[],
  nextMessage: AgentMessage
): AgentMessage[] {
  const pendingClientMessageId = getPendingClientMessageId(nextMessage);
  const withoutMatchedTemp = messages.filter((message) => {
    if (!message.id.startsWith("temp-") || message.role !== "user") {
      return true;
    }
    const tempPendingId = getPendingClientMessageId(message);
    if (pendingClientMessageId && tempPendingId === pendingClientMessageId) {
      return false;
    }
    return !(nextMessage.role === "user" && message.content === nextMessage.content && !tempPendingId);
  });

  const directIndex = withoutMatchedTemp.findIndex((message) => message.id === nextMessage.id);
  if (directIndex !== -1) {
    const patched = [...withoutMatchedTemp];
    patched[directIndex] = nextMessage;
    return patched;
  }

  if (nextMessage.versionGroupId) {
    const groupIndex = withoutMatchedTemp.findIndex((message) => (
      message.versionGroupId === nextMessage.versionGroupId
      && message.role === nextMessage.role
    ));
    if (groupIndex !== -1) {
      const patched = [...withoutMatchedTemp];
      patched[groupIndex] = nextMessage;
      return patched;
    }
  }

  return [...withoutMatchedTemp, nextMessage];
}

export function mergeServerMessagesWithPending(
  prev: AgentMessage[],
  next: AgentMessage[]
): AgentMessage[] {
  const persistedPendingIds = new Set(
    next
      .map((message) => getPendingClientMessageId(message))
      .filter((value): value is string => !!value)
  );
  const persistedUserContents = new Set(
    next
      .filter((message) => message.role === "user")
      .map((message) => message.content)
  );
  const pendingTempMessages = prev.filter((message) => {
    if (!message.id.startsWith("temp-")) {
      return false;
    }
    const pendingId = getPendingClientMessageId(message);
    if (pendingId) {
      return !persistedPendingIds.has(pendingId);
    }
    return !persistedUserContents.has(message.content);
  });
  return [...next, ...pendingTempMessages];
}
