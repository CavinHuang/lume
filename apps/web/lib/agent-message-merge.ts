import type { AgentMessage } from "@lume/shared";

function getPendingClientMessageId(message: AgentMessage): string | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const value = metadata?.pendingClientMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function isSameAgentMessage(a: AgentMessage, b: AgentMessage): boolean {
  return (
    a.id === b.id
    && a.role === b.role
    && a.content === b.content
    && a.reasoning === b.reasoning
    && a.createdAt === b.createdAt
    && a.model === b.model
    && a.versionGroupId === b.versionGroupId
    && a.versionIndex === b.versionIndex
    && a.versionCount === b.versionCount
    && a.supersedesMessageId === b.supersedesMessageId
    && a.supersededByMessageId === b.supersededByMessageId
    && a.isLatestVersion === b.isLatestVersion
    && stableStringify(a.metadata) === stableStringify(b.metadata)
    && stableStringify(a.sdkMessages) === stableStringify(b.sdkMessages)
  );
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
  const prevById = new Map(prev.map((message) => [message.id, message] as const));
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
  const persistedUsers = next.filter((message) => message.role === "user");
  const pendingTempMessages = prev.filter((message) => {
    if (!message.id.startsWith("temp-")) {
      return false;
    }
    const pendingId = getPendingClientMessageId(message);
    if (pendingId) {
      if (persistedPendingIds.has(pendingId)) {
        return false;
      }
      const matchedByContentAndTime = persistedUsers.some((persisted) => (
        persisted.content === message.content
        && persisted.createdAt >= message.createdAt
      ));
      return !matchedByContentAndTime;
    }
    return !persistedUserContents.has(message.content);
  });
  const preservedAssistantMessages = prev.filter((message) => {
    if (message.role !== "assistant") {
      return false;
    }
    const metadata = message.metadata as Record<string, unknown> | undefined;
    if (metadata?.streamErrorPreserved !== true) {
      return false;
    }
    return !next.some((serverMessage) => (
      serverMessage.role === "assistant"
      && (
        serverMessage.id === message.id
        || (message.versionGroupId && serverMessage.versionGroupId === message.versionGroupId)
        || (((serverMessage.content ?? "").trim() || (serverMessage.reasoning ?? "").trim()) && serverMessage.content === message.content && serverMessage.reasoning === message.reasoning)
      )
    ));
  });
  const stabilizedNext = next.map((message) => {
    const previous = prevById.get(message.id);
    return previous && isSameAgentMessage(previous, message) ? previous : message;
  });
  return [...stabilizedNext, ...preservedAssistantMessages, ...pendingTempMessages];
}
