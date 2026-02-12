"use client";

import * as React from "react";
import { useAtomValue } from "jotai";
import { Loader2, MessageSquare } from "lucide-react";
import { useSmoothStream } from "@lume/ui";
import type { ChatMessage } from "@lume/shared";
import {
  currentConversationIdAtom,
  hasMoreMessagesAtom,
  parallelModeAtom,
  selectedModelAtom,
} from "@/atoms/chat-atoms";
import { ContextDivider } from "@/components/ai-elements/context-divider";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  useConversationContext,
} from "@/components/ai-elements/conversation";
import { ParallelChatMessages } from "./ParallelChatMessages";
import { ChatMessageItem } from "./ChatMessageItem";
import type { InlineEditSubmitPayload } from "./ChatMessageItem";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  contextDividers: string[];
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onResendMessage?: (message: ChatMessage) => Promise<void>;
  onStartInlineEdit?: (message: ChatMessage) => void;
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
  inlineEditingMessageId?: string | null;
  onDeleteDivider?: (messageId: string) => void;
  streamingContent?: string;
  streamingReasoning?: string;
  onLoadMore?: () => Promise<void>;
  loadingMore?: boolean;
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <MessageSquare size={24} className="text-muted-foreground/60" />
        </div>
        <p className="text-sm">在下方输入框开始对话</p>
      </div>
    </div>
  );
}

function ScrollTopLoader({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => Promise<void> }): React.ReactElement | null {
  const { scrollRef } = useConversationContext();
  const triggeredRef = React.useRef(false);

  React.useEffect(() => {
    triggeredRef.current = false;
  }, [hasMore]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || triggeredRef.current) return;

    const handleScroll = (): void => {
      if (el.scrollTop < 100 && !triggeredRef.current) {
        triggeredRef.current = true;
        const prevHeight = el.scrollHeight;
        void onLoadMore().then(() => {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight - prevHeight;
          });
        });
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, hasMore, onLoadMore]);

  if (!hasMore) return null;

  if (loading) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return null;
}

export function ChatMessages({
  messages,
  isStreaming = false,
  contextDividers,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  inlineEditingMessageId,
  onDeleteDivider,
  streamingContent,
  streamingReasoning,
  onLoadMore,
  loadingMore
}: ChatMessagesProps): React.ReactElement {
  const parallelMode = useAtomValue(parallelModeAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const hasMore = useAtomValue(hasMoreMessagesAtom);
  const currentConversationId = useAtomValue(currentConversationIdAtom);

  const { displayedContent: smoothContent } = useSmoothStream({
    content: streamingContent ?? "",
    isStreaming
  });
  const { displayedContent: smoothReasoning } = useSmoothStream({
    content: streamingReasoning ?? "",
    isStreaming
  });

  const [ready, setReady] = React.useState(false);
  const [internalLoadingMore, setInternalLoadingMore] = React.useState(false);
  const prevConversationIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (currentConversationId !== prevConversationIdRef.current) {
      prevConversationIdRef.current = currentConversationId;
      setReady(false);
    }
  }, [currentConversationId]);

  React.useEffect(() => {
    if (ready) return;
    if (messages.length === 0 && !isStreaming) {
      setReady(true);
      return;
    }

    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [messages, isStreaming, ready]);

  const handleLoadMore = React.useCallback(async (): Promise<void> => {
    if (!onLoadMore || internalLoadingMore || !hasMore) return;
    setInternalLoadingMore(true);
    try {
      await onLoadMore();
    } finally {
      setInternalLoadingMore(false);
    }
  }, [onLoadMore, internalLoadingMore, hasMore]);

  if (parallelMode) {
    return (
      <ParallelChatMessages
        messages={messages}
        contextDividers={contextDividers}
        onDeleteDivider={onDeleteDivider}
        onDeleteMessage={onDeleteMessage}
        loadingMore={loadingMore ?? internalLoadingMore}
        streamingContent={smoothContent}
        streamingReasoning={smoothReasoning}
        streamingModel={selectedModel?.modelId}
      />
    );
  }

  const dividerSet = new Set(contextDividers);

  return (
    <Conversation className={ready ? "opacity-100 transition-opacity duration-200" : "opacity-0"}>
      <ScrollTopLoader
        hasMore={hasMore}
        loading={loadingMore ?? internalLoadingMore}
        onLoadMore={handleLoadMore}
      />

      <ConversationContent>
        {messages.length === 0 && !isStreaming ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((message, index) => {
              const isLastAssistant = message.role === "assistant" && index === messages.length - 1;
              return (
                <React.Fragment key={message.id}>
                  <ChatMessageItem
                    message={message}
                    isStreaming={false}
                    isLastAssistant={isLastAssistant}
                    onDeleteMessage={onDeleteMessage}
                    onResendMessage={onResendMessage}
                    onStartInlineEdit={onStartInlineEdit}
                    onSubmitInlineEdit={onSubmitInlineEdit}
                    onCancelInlineEdit={onCancelInlineEdit}
                    isInlineEditing={inlineEditingMessageId === message.id}
                  />
                  {dividerSet.has(message.id) ? (
                    <ContextDivider
                      messageId={message.id}
                      onDelete={onDeleteDivider}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}

            {(isStreaming || smoothContent || smoothReasoning) ? (
              <ChatMessageItem
                message={{
                  id: "streaming-assistant",
                  role: "assistant",
                  content: smoothContent ?? "",
                  reasoning: smoothReasoning ?? "",
                  createdAt: Date.now(),
                  model: selectedModel?.modelId ?? "Assistant"
                }}
                isStreaming
                isLastAssistant
              />
            ) : null}
          </>
        )}
      </ConversationContent>

      <ConversationScrollButton />
    </Conversation>
  );
}
