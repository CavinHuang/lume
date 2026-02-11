"use client";

import type { ChatMessage } from "@lume/shared";
import { ChatMessages } from "./ChatMessages";

type ParallelChatMessagesProps = {
  messages: ChatMessage[];
  contextDividers: string[];
};

export function ParallelChatMessages({
  messages,
  contextDividers
}: ParallelChatMessagesProps): React.ReactElement {
  return <ChatMessages messages={messages} contextDividers={contextDividers} />;
}
