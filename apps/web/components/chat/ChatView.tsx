"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  chatStreamErrorsAtom,
  currentConversationAtom,
  contextDividersAtom,
  contextLengthAtom,
  conversationsAtom,
  currentConversationIdAtom,
  currentMessagesAtom,
  selectedModelAtom,
  streamingStatesAtom,
  thinkingEnabledAtom
} from "@/atoms";
import {
  getConversationMessages,
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
import type { ChatMessage, ChatSendInput, ModelOption } from "@lume/shared";
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
  const setErrors = useSetAtom(chatStreamErrorsAtom);
  const setConversations = useSetAtom(conversationsAtom);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);

  const streamState = currentConversationId ? streamingStates.get(currentConversationId) : undefined;

  useEffect(() => {
    if (!currentConversationId) {
      setCurrentMessages([]);
      setContextDividers([]);
      return;
    }

    void getConversationMessages(currentConversationId).then(setCurrentMessages);
    setContextDividers(currentConversation?.contextDividers ?? []);
  }, [currentConversation?.contextDividers, currentConversationId, setContextDividers, setCurrentMessages]);

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
  }, [currentConversationId, setConversations, setCurrentMessages, setErrors, setStreamingStates]);

  const canSend = useMemo(
    () => !!currentConversationId && !!selectedModel,
    [currentConversationId, selectedModel]
  );

  const handleSend = async (content: string): Promise<void> => {
    if (!canSend || !currentConversationId || !selectedModel) return;

    const optimistic: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: Date.now()
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

  if (!currentConversationId) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-5">
        <h2 className="text-2xl font-semibold">Chat</h2>
        <p className="text-sm text-muted-foreground">请选择或创建一个对话。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-5">
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
      />
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
