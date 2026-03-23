import type { ChatMessage } from "@lume/shared";

interface StreamRefreshResolved {
  messages: ChatMessage[];
  hasMore: boolean;
}

interface FinalizeStreamRefreshInput {
  fetchRecentMessages: () => Promise<StreamRefreshResolved>;
  applyRefresh: (result: StreamRefreshResolved) => void;
  clearStreaming: () => void;
  onFetchError?: (error: unknown) => void;
}

export async function finalizeStreamRefresh(input: FinalizeStreamRefreshInput): Promise<void> {
  try {
    const resolved = await input.fetchRecentMessages();
    input.applyRefresh(resolved);
  } catch (error) {
    input.onFetchError?.(error);
  } finally {
    input.clearStreaming();
  }
}
