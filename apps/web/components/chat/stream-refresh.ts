import type { ChatMessage } from "@lume/shared";

interface StreamRefreshInput {
  persistedMessages: ChatMessage[];
  visibleCountBeforeRefresh: number;
  hadMoreBeforeRefresh: boolean;
  minTailSize: number;
}

interface StreamRefreshResult {
  messages: ChatMessage[];
  hasMore: boolean;
}

export function resolveStreamRefreshResult(input: StreamRefreshInput): StreamRefreshResult {
  const {
    persistedMessages,
    visibleCountBeforeRefresh,
    hadMoreBeforeRefresh,
    minTailSize
  } = input;

  if (!hadMoreBeforeRefresh) {
    return {
      messages: persistedMessages,
      hasMore: false
    };
  }

  const tailSize = Math.max(visibleCountBeforeRefresh, minTailSize);
  if (persistedMessages.length <= tailSize) {
    return {
      messages: persistedMessages,
      hasMore: false
    };
  }

  return {
    messages: persistedMessages.slice(-tailSize),
    hasMore: true
  };
}
