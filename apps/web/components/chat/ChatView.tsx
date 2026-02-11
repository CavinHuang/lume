"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { AlertCircle, MessageSquare, X } from "lucide-react";
import {
  chatStreamErrorsAtom,
  currentChatErrorAtom,
  currentConversationAtom,
  contextDividersAtom,
  contextLengthAtom,
  conversationsAtom,
  currentConversationIdAtom,
  currentMessagesAtom,
  hasMoreMessagesAtom,
  INITIAL_MESSAGE_LIMIT,
  pendingAttachmentsAtom,
  selectedModelAtom,
  streamingStatesAtom,
  thinkingEnabledAtom
} from "@/atoms";
import {
  saveChatAttachment,
  getConversationMessages,
  getRecentConversationMessages,
  deleteConversationMessage,
  listChannels,
  listConversations,
  onChatStreamChunk,
  onChatStreamComplete,
  onChatStreamError,
  onChatStreamReasoning,
  sendChatMessage,
  stopChatGeneration,
  updateConversationContextDividers
} from "@/lib/desktop-api";
import type { AttachmentSaveInput, ChatMessage, ChatSendInput, FileAttachment, ModelOption } from "@lume/shared";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";

export function ChatView(): React.ReactElement {
  const [currentConversationId] = useAtom(currentConversationIdAtom);
  const [currentMessages, setCurrentMessages] = useAtom(currentMessagesAtom);
  const [currentConversation] = useAtom(currentConversationAtom);
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [streamingStates, setStreamingStates] = useAtom(streamingStatesAtom);
  const [contextLength] = useAtom(contextLengthAtom);
  const [contextDividers, setContextDividers] = useAtom(contextDividersAtom);
  const [thinkingEnabled] = useAtom(thinkingEnabledAtom);
  const [pendingAttachments, setPendingAttachments] = useAtom(pendingAttachmentsAtom);
  const setHasMoreMessages = useSetAtom(hasMoreMessagesAtom);
  const [chatError] = useAtom(currentChatErrorAtom);
  const setErrors = useSetAtom(chatStreamErrorsAtom);
  const setConversations = useSetAtom(conversationsAtom);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);

  const streamState = currentConversationId ? streamingStates.get(currentConversationId) : undefined;

  useEffect(() => {
    if (!currentConversationId) {
      setCurrentMessages([]);
      setContextDividers([]);
      setHasMoreMessages(false);
      return;
    }

    void getRecentConversationMessages(currentConversationId, INITIAL_MESSAGE_LIMIT).then((result) => {
      setCurrentMessages(result.messages);
      setHasMoreMessages(result.hasMore);
    });
    setContextDividers(currentConversation?.contextDividers ?? []);
  }, [currentConversation?.contextDividers, currentConversationId, setContextDividers, setCurrentMessages, setHasMoreMessages]);

  useEffect(() => {
    void listChannels().then((channels) => {
      const options: ModelOption[] = [];
      for (const channel of channels) {
        for (const model of channel.models) {
          if (!model.enabled) continue;
          options.push({
            channelId: channel.id,
            channelName: channel.name,
            modelId: model.id,
            modelName: model.name,
            provider: channel.provider
          });
        }
      }
      setModelOptions(options);

      const first = options[0];
      if (!selectedModel && first) {
        setSelectedModel({ channelId: first.channelId, modelId: first.modelId });
      }
    });
  }, [selectedModel, setSelectedModel]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    void onChatStreamChunk((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(event.conversationId) ?? { streaming: true, content: "", reasoning: "" };
        map.set(event.conversationId, {
          ...current,
          streaming: true,
          content: current.content + event.delta
        });
        return map;
      });
    }).then((fn) => unsubs.push(fn));

    void onChatStreamReasoning((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(event.conversationId) ?? { streaming: true, content: "", reasoning: "" };
        map.set(event.conversationId, {
          ...current,
          streaming: true,
          reasoning: current.reasoning + event.delta
        });
        return map;
      });
    }).then((fn) => unsubs.push(fn));

    void onChatStreamComplete((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(event.conversationId);
        return map;
      });

      void getConversationMessages(event.conversationId).then((messages) => {
        if (event.conversationId === currentConversationId) {
          setCurrentMessages(messages);
          setHasMoreMessages(false);
        }
      });

      void listConversations().then(setConversations);
    }).then((fn) => unsubs.push(fn));

    void onChatStreamError((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(event.conversationId);
        return map;
      });

      setErrors((prev) => {
        const map = new Map(prev);
        map.set(event.conversationId, event.error);
        return map;
      });
    }).then((fn) => unsubs.push(fn));

    return () => {
      for (const fn of unsubs) fn();
    };
  }, [currentConversationId, setConversations, setCurrentMessages, setErrors, setHasMoreMessages, setStreamingStates]);

  const canSend = useMemo(
    () => !!currentConversationId && !!selectedModel,
    [currentConversationId, selectedModel]
  );

  const handleSend = async (content: string): Promise<void> => {
    if (!canSend || !currentConversationId || !selectedModel) return;

    const currentPending = [...pendingAttachments];
    const savedAttachments: FileAttachment[] = [];
    for (const att of currentPending) {
      const data = window.__pendingAttachmentData?.get(att.id);
      if (!data) continue;
      try {
        const input: AttachmentSaveInput = {
          conversationId: currentConversationId,
          filename: att.filename,
          mediaType: att.mediaType,
          data
        };
        const result = await saveChatAttachment(input);
        savedAttachments.push(result.attachment);
      } catch (error) {
        console.error("[ChatView] save attachment failed:", error);
      }
    }

    for (const att of currentPending) {
      if (att.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(att.previewUrl);
      }
      window.__pendingAttachmentData?.delete(att.id);
    }
    setPendingAttachments([]);

    const optimistic: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: Date.now(),
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined
    };
    setCurrentMessages((prev) => [...prev, optimistic]);

    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(currentConversationId, { streaming: true, content: "", reasoning: "" });
      return map;
    });

    const input: ChatSendInput = {
      conversationId: currentConversationId,
      userMessage: content,
      messageHistory: [],
      channelId: selectedModel.channelId,
      modelId: selectedModel.modelId,
      contextLength,
      contextDividers,
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      thinkingEnabled
    };

    await sendChatMessage(input);
  };

  const handleDeleteMessage = async (messageId: string): Promise<void> => {
    if (!currentConversationId) return;
    const messages = await deleteConversationMessage(currentConversationId, messageId);
    setCurrentMessages(messages);

    if (contextDividers.includes(messageId)) {
      const next = contextDividers.filter((id) => id !== messageId);
      setContextDividers(next);
      await updateConversationContextDividers(currentConversationId, next);
    }
  };

  const handleClearContext = async (): Promise<void> => {
    if (!currentConversationId || currentMessages.length === 0) return;
    const lastId = currentMessages[currentMessages.length - 1]?.id;
    if (!lastId) return;
    const next = contextDividers.includes(lastId)
      ? contextDividers.filter((id) => id !== lastId)
      : [...contextDividers, lastId];
    setContextDividers(next);
    await updateConversationContextDividers(currentConversationId, next);
  };

  const handleLoadMore = async (): Promise<void> => {
    if (!currentConversationId) return;
    const allMessages = await getConversationMessages(currentConversationId);
    setCurrentMessages(allMessages);
    setHasMoreMessages(false);
  };

  if (!currentConversationId) {
    return (
      <div className="mx-auto flex h-full w-full max-w-[min(72rem,100%)] flex-col items-center justify-center gap-4 text-muted-foreground" style={{ zoom: 1.1 }}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare size={32} className="text-muted-foreground/60" />
        </div>
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-medium text-foreground">开始对话</h2>
          <p className="max-w-[300px] text-sm">从左侧点击“新对话”按钮创建一个新对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[min(72rem,100%)] flex-col overflow-hidden">
      <ChatHeader
        modelOptions={modelOptions}
        onModelChange={setSelectedModel}
      />
      <ChatMessages
        messages={currentMessages}
        contextDividers={contextDividers}
        onDeleteMessage={handleDeleteMessage}
        onDeleteDivider={(messageId) => {
          if (!currentConversationId) return;
          const next = contextDividers.filter((id) => id !== messageId);
          setContextDividers(next);
          void updateConversationContextDividers(currentConversationId, next);
        }}
        streamingContent={streamState?.content}
        streamingReasoning={streamState?.reasoning}
        onLoadMore={handleLoadMore}
      />
      {chatError ? (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span className="flex-1 break-all">{chatError}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/10"
            onClick={() => {
              if (!currentConversationId) return;
              setErrors((prev) => {
                const map = new Map(prev);
                map.delete(currentConversationId);
                return map;
              });
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      <ChatInput
        disabled={!canSend}
        onSend={handleSend}
        onClearContext={() => { void handleClearContext(); }}
        onStop={() => {
          if (currentConversationId) {
            void stopChatGeneration(currentConversationId);
          }
        }}
      />
    </div>
  );
}
