"use client";

import { Fragment, useMemo } from "react";
import type { ChatMessage } from "@lume/shared";
import { ChatMessageItem } from "./ChatMessageItem";
import { ContextDivider } from "@/components/ai-elements/context-divider";

interface MessageSegment {
  userMessages: ChatMessage[];
  assistantMessages: ChatMessage[];
  dividerMessageId?: string;
}

type ParallelChatMessagesProps = {
  messages: ChatMessage[];
  contextDividers: string[];
  onDeleteDivider?: (messageId: string) => void;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  loadingMore?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  streamingModel?: string;
};

function segmentMessages(messages: ChatMessage[], contextDividers: string[]): MessageSegment[] {
  const dividerSet = new Set(contextDividers);
  const segments: MessageSegment[] = [];
  let currentUserMessages: ChatMessage[] = [];
  let currentAssistantMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") currentUserMessages.push(message);
    if (message.role === "assistant") currentAssistantMessages.push(message);

    if (dividerSet.has(message.id)) {
      segments.push({
        userMessages: currentUserMessages,
        assistantMessages: currentAssistantMessages,
        dividerMessageId: message.id,
      });
      currentUserMessages = [];
      currentAssistantMessages = [];
    }
  }

  if (currentUserMessages.length > 0 || currentAssistantMessages.length > 0) {
    segments.push({ userMessages: currentUserMessages, assistantMessages: currentAssistantMessages });
  }

  return segments;
}

function MessageColumn({
  messages,
  onDeleteMessage,
  side,
  streamingContent,
  streamingReasoning,
  streamingModel,
}: {
  messages: ChatMessage[];
  onDeleteMessage?: (messageId: string) => Promise<void>;
  side: "user" | "assistant";
  streamingContent?: string;
  streamingReasoning?: string;
  streamingModel?: string;
}): React.ReactElement {
  const showStreaming = side === "assistant" && (!!streamingContent || !!streamingReasoning);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none overscroll-contain">
      <div className="flex flex-col gap-6 p-4">
        {messages.map((message) => (
          <ChatMessageItem
            key={message.id}
            message={message}
            onDeleteMessage={onDeleteMessage}
            isParallelMode
          />
        ))}

        {showStreaming ? (
          <ChatMessageItem
            message={{
              id: "parallel-streaming-assistant",
              role: "assistant",
              content: streamingContent ?? "",
              reasoning: streamingReasoning ?? "",
              createdAt: Date.now(),
              model: streamingModel ?? "Assistant"
            }}
            isStreaming
            isLastAssistant
            isParallelMode
          />
        ) : null}
      </div>
    </div>
  );
}

export function ParallelChatMessages({
  messages,
  contextDividers,
  onDeleteDivider,
  onDeleteMessage,
  loadingMore = false,
  streamingContent,
  streamingReasoning,
  streamingModel,
}: ParallelChatMessagesProps): React.ReactElement {
  const segments = useMemo(() => segmentMessages(messages, contextDividers), [messages, contextDividers]);

  const userMessages = useMemo(() => messages.filter((m) => m.role === "user"), [messages]);
  const assistantMessages = useMemo(() => messages.filter((m) => m.role === "assistant"), [messages]);

  if (segments.length <= 1) {
    return (
      <div className="relative min-h-0 flex-1">
        {loadingMore ? (
          <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-center py-3">
            <span className="text-xs text-muted-foreground">加载中...</span>
          </div>
        ) : null}

        <div className="absolute inset-0 flex">
          <div className="flex w-1/2 flex-col overflow-hidden border-r border-border">
            <div className="border-b border-border bg-muted/30 px-4 py-2">
              <span className="text-sm font-medium text-muted-foreground">用户消息</span>
            </div>
            <MessageColumn
              messages={userMessages}
              onDeleteMessage={onDeleteMessage}
              side="user"
            />
          </div>

          <div className="flex w-1/2 flex-col overflow-hidden">
            <div className="border-b border-border bg-muted/30 px-4 py-2">
              <span className="text-sm font-medium text-muted-foreground">助手回复</span>
            </div>
            <MessageColumn
              messages={assistantMessages}
              onDeleteMessage={onDeleteMessage}
              side="assistant"
              streamingContent={streamingContent}
              streamingReasoning={streamingReasoning}
              streamingModel={streamingModel}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div className="absolute inset-0 flex flex-col overflow-hidden">
        {loadingMore ? (
          <div className="flex items-center justify-center py-3">
            <span className="text-xs text-muted-foreground">加载中...</span>
          </div>
        ) : null}

        {segments.map((segment, index) => (
          <Fragment key={index}>
            <div className={index === segments.length - 1 ? "flex min-h-0 flex-1 overflow-hidden" : "flex flex-shrink-0 overflow-hidden"}>
              <div className="flex w-1/2 flex-col overflow-hidden border-r border-border">
                {index === 0 ? (
                  <div className="border-b border-border bg-muted/30 px-4 py-2">
                    <span className="text-sm font-medium text-muted-foreground">用户消息</span>
                  </div>
                ) : null}
                <MessageColumn
                  messages={segment.userMessages}
                  onDeleteMessage={onDeleteMessage}
                  side="user"
                />
              </div>

              <div className="flex w-1/2 flex-col overflow-hidden">
                {index === 0 ? (
                  <div className="border-b border-border bg-muted/30 px-4 py-2">
                    <span className="text-sm font-medium text-muted-foreground">助手回复</span>
                  </div>
                ) : null}
                <MessageColumn
                  messages={segment.assistantMessages}
                  onDeleteMessage={onDeleteMessage}
                  side="assistant"
                  streamingContent={index === segments.length - 1 ? streamingContent : ""}
                  streamingReasoning={index === segments.length - 1 ? streamingReasoning : ""}
                  streamingModel={streamingModel}
                />
              </div>
            </div>

            {segment.dividerMessageId ? (
              <ContextDivider
                messageId={segment.dividerMessageId}
                onDelete={onDeleteDivider}
                className="flex-shrink-0"
              />
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
