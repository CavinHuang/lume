"use client";

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ChatMessage,
  ConversationMeta,
  SystemPromptConfig
} from "@lume/shared";
import {
  getChatTools,
  getRecentConversationMessages,
  getSystemPromptConfig,
  onChatToolChanged
} from "@/lib/desktop-api/chat";
import { INITIAL_MESSAGE_LIMIT } from "@/atoms";
import { resolveConversationPromptId } from "../chat-session-lifecycle";

interface UseChatSessionLifecycleParams {
  currentConversationId: string | null;
  currentConversation: ConversationMeta | null;
  currentMessages: ChatMessage[];
  hasMoreMessages: boolean;
  conversations: ConversationMeta[];
  selectedPromptId: string | null;
  conversationPromptMap: Map<string, string>;
  promptConfig: SystemPromptConfig;
  setPromptConfig: Dispatch<SetStateAction<SystemPromptConfig>>;
  setChatTools: Dispatch<SetStateAction<Awaited<ReturnType<typeof getChatTools>>>>;
  setConversationPromptMap: Dispatch<SetStateAction<Map<string, string>>>;
  setCurrentMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setContextDividers: Dispatch<SetStateAction<string[]>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setSelectedModel: Dispatch<SetStateAction<{ channelId: string; modelId: string } | null>>;
  setInlineEditingMessageId: Dispatch<SetStateAction<string | null>>;
}

export function useChatSessionLifecycle({
  currentConversationId,
  currentConversation,
  currentMessages,
  hasMoreMessages,
  conversations,
  selectedPromptId,
  conversationPromptMap,
  promptConfig,
  setPromptConfig,
  setChatTools,
  setConversationPromptMap,
  setCurrentMessages,
  setContextDividers,
  setHasMoreMessages,
  setSelectedModel,
  setInlineEditingMessageId
}: UseChatSessionLifecycleParams): {
  currentConversationIdRef: React.MutableRefObject<string | null>;
  currentMessagesRef: React.MutableRefObject<ChatMessage[]>;
  hasMoreMessagesRef: React.MutableRefObject<boolean>;
  conversationsRef: React.MutableRefObject<ConversationMeta[]>;
} {
  const currentConversationIdRef = useRef<string | null>(currentConversationId);
  const currentMessagesRef = useRef(currentMessages);
  const hasMoreMessagesRef = useRef(hasMoreMessages);
  const conversationsRef = useRef(conversations);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  useEffect(() => {
    currentMessagesRef.current = currentMessages;
  }, [currentMessages]);

  useEffect(() => {
    hasMoreMessagesRef.current = hasMoreMessages;
  }, [hasMoreMessages]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    setInlineEditingMessageId(null);
  }, [currentConversationId, setInlineEditingMessageId]);

  useEffect(() => {
    void getSystemPromptConfig().then((config) => {
      setPromptConfig(config);
    }).catch((error) => {
      console.error("[ChatView] 加载系统提示词配置失败:", error);
    });
  }, [setPromptConfig]);

  useEffect(() => {
    void getChatTools().then((tools) => {
      setChatTools(tools);
    }).catch((error) => {
      console.error("[ChatView] 加载工具配置失败:", error);
    });
  }, [setChatTools]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onChatToolChanged(() => {
      void getChatTools().then((tools) => {
        if (!disposed) {
          setChatTools(tools);
        }
      }).catch((error) => {
        console.error("[ChatView] 工具配置变更刷新失败:", error);
      });
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlisten = fn;
    }).catch((error) => {
      console.error("[ChatView] 订阅工具配置变更失败:", error);
    });

    return () => {
      disposed = true;
      if (unlisten) {
        void unlisten();
      }
    };
  }, [setChatTools]);

  useEffect(() => {
    if (!currentConversationId) return;
    const nextPromptId = resolveConversationPromptId({
      existingPromptId: conversationPromptMap.get(currentConversationId),
      availablePromptIds: promptConfig.prompts.map((item) => item.id),
      defaultPromptId: promptConfig.defaultPromptId,
      selectedPromptId
    });
    if (!nextPromptId) return;
    if (conversationPromptMap.get(currentConversationId) === nextPromptId) return;
    setConversationPromptMap((prev) => {
      const next = new Map(prev);
      next.set(currentConversationId, nextPromptId);
      return next;
    });
  }, [
    currentConversationId,
    conversationPromptMap,
    promptConfig.prompts,
    promptConfig.defaultPromptId,
    selectedPromptId,
    setConversationPromptMap
  ]);

  useEffect(() => {
    if (!currentConversationId) {
      setCurrentMessages([]);
      setContextDividers([]);
      setHasMoreMessages(false);
      return;
    }

    setCurrentMessages([]);
    setHasMoreMessages(false);

    const targetConversationId = currentConversationId;
    void getRecentConversationMessages(targetConversationId, INITIAL_MESSAGE_LIMIT).then((result) => {
      if (currentConversationIdRef.current !== targetConversationId) return;
      setCurrentMessages(result.messages);
      setHasMoreMessages(result.hasMore);
    });
    setContextDividers(currentConversation?.contextDividers ?? []);
    if (currentConversation?.modelId && currentConversation?.channelId) {
      setSelectedModel({
        channelId: currentConversation.channelId,
        modelId: currentConversation.modelId
      });
    }
  }, [
    currentConversation?.contextDividers,
    currentConversation?.modelId,
    currentConversation?.channelId,
    currentConversationId,
    setContextDividers,
    setCurrentMessages,
    setHasMoreMessages,
    setSelectedModel
  ]);

  return {
    currentConversationIdRef,
    currentMessagesRef,
    hasMoreMessagesRef,
    conversationsRef
  };
}
