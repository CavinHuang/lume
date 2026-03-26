import type { ChatToolActivity } from "@lume/shared";
import type { ConversationStreamState } from "@/atoms/chat-atoms";

export function createConversationStreamState(
  current: ConversationStreamState | undefined,
  patch: Partial<ConversationStreamState>
): ConversationStreamState {
  return {
    streaming: true,
    content: "",
    reasoning: "",
    toolActivities: [],
    ...current,
    ...patch
  };
}

export function appendConversationStreamChunk(
  current: ConversationStreamState | undefined,
  delta: string
): ConversationStreamState {
  const base = createConversationStreamState(current, {});
  return {
    ...base,
    streaming: true,
    content: base.content + delta
  };
}

export function appendConversationStreamReasoning(
  current: ConversationStreamState | undefined,
  delta: string
): ConversationStreamState {
  const base = createConversationStreamState(current, {});
  return {
    ...base,
    streaming: true,
    reasoning: base.reasoning + delta
  };
}

export function appendConversationToolActivity(
  current: ConversationStreamState | undefined,
  activity: ChatToolActivity
): ConversationStreamState {
  const base = createConversationStreamState(current, {});
  return {
    ...base,
    toolActivities: [...base.toolActivities, activity]
  };
}
