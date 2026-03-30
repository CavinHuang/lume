import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChatMessage, ConversationMeta } from "@lume/shared";
import type { ConversationStreamState } from "@/atoms/chat-atoms";
import {
  generateConversationTitle,
  getRecentConversationMessages,
  onChatStreamChunk,
  onChatStreamComplete,
  onChatStreamError,
  onChatStreamReasoning,
  onChatStreamToolActivity,
  updateConversationTitle
} from "@/lib/desktop-api/chat";
import { INITIAL_MESSAGE_LIMIT } from "@/atoms";
import { finalizeStreamRefresh } from "../stream-finalizer";
import { getStreamRefreshRecentLimit } from "../stream-refresh-policy";
import {
  appendConversationStreamChunk,
  appendConversationStreamReasoning,
  appendConversationToolActivity
} from "../chat-stream-subscriptions";

interface UseChatStreamSubscriptionsParams {
  currentConversationIdRef: MutableRefObject<string | null>;
  currentMessagesRef: MutableRefObject<ChatMessage[]>;
  hasMoreMessagesRef: MutableRefObject<boolean>;
  pendingTitleRef: MutableRefObject<Map<string, { userMessage: string; channelId: string; modelId: string }>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, ConversationStreamState>>>;
  setCurrentMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setErrors: Dispatch<SetStateAction<Map<string, string>>>;
}

export function useChatStreamSubscriptions({
  currentConversationIdRef,
  currentMessagesRef,
  hasMoreMessagesRef,
  pendingTitleRef,
  setStreamingStates,
  setCurrentMessages,
  setHasMoreMessages,
  setConversations,
  setErrors
}: UseChatStreamSubscriptionsParams): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

    const clearStreamingStateForConversation = (conversationId: string): void => {
      setStreamingStates((prev) => {
        if (!prev.has(conversationId)) return prev;
        const map = new Map(prev);
        map.delete(conversationId);
        return map;
      });
    };

    const refreshConversationAfterStream = (
      conversationId: string,
      options?: { logPrefix?: string }
    ): void => {
      void finalizeStreamRefresh({
        fetchRecentMessages: async () => {
          const limit = getStreamRefreshRecentLimit({
            visibleCount: currentMessagesRef.current.length,
            hadMore: hasMoreMessagesRef.current,
            minLimit: INITIAL_MESSAGE_LIMIT
          });
          const result = await getRecentConversationMessages(conversationId, limit);
          return {
            messages: result.messages,
            hasMore: result.hasMore
          };
        },
        applyRefresh: (resolved) => {
          if (conversationId !== currentConversationIdRef.current) return;
          setCurrentMessages(resolved.messages);
          setHasMoreMessages(resolved.hasMore);
        },
        clearStreaming: () => {
          clearStreamingStateForConversation(conversationId);
        },
        onFetchError: (error) => {
          if (!options?.logPrefix) return;
          console.error(options.logPrefix, error);
        }
      });
    };

    const trackUnlisten = (promise: Promise<() => void>): void => {
      void promise.then((fn) => {
        if (disposed) {
          void fn();
          return;
        }
        unsubs.push(fn);
      }).catch((error) => {
        console.error("[ChatView] subscribe stream failed:", error);
      });
    };

    trackUnlisten(onChatStreamChunk((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(event.conversationId, appendConversationStreamChunk(map.get(event.conversationId), event.delta));
        return map;
      });
    }));

    trackUnlisten(onChatStreamReasoning((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(event.conversationId, appendConversationStreamReasoning(map.get(event.conversationId), event.delta));
        return map;
      });
    }));

    trackUnlisten(onChatStreamToolActivity((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(event.conversationId, appendConversationToolActivity(map.get(event.conversationId), event.activity));
        return map;
      });
    }));

    trackUnlisten(onChatStreamComplete((event) => {
      refreshConversationAfterStream(event.conversationId, {
        logPrefix: "[ChatView] 刷新消息失败:"
      });

      setConversations((prev) =>
        prev.map((item) =>
          item.id === event.conversationId
            ? {
                ...item,
                modelId: event.model || item.modelId,
                updatedAt: Date.now()
              }
            : item
        )
      );

      const titleInput = pendingTitleRef.current.get(event.conversationId);
      pendingTitleRef.current.delete(event.conversationId);
      if (!titleInput) return;

      void generateConversationTitle(titleInput).then((title) => {
        const nextTitle = title?.trim() || titleInput.userMessage.trim().slice(0, 20);
        if (!nextTitle) return;
        void updateConversationTitle(event.conversationId, nextTitle).then((updated) => {
          setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        }).catch((error) => {
          console.error("[ChatView] 自动更新标题失败:", error);
        });
      }).catch((error) => {
        console.error("[ChatView] 自动生成标题失败:", error);
        const fallback = titleInput.userMessage.trim().slice(0, 20);
        if (!fallback) return;
        void updateConversationTitle(event.conversationId, fallback).then((updated) => {
          setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        }).catch((updateError) => {
          console.error("[ChatView] 回退标题更新失败:", updateError);
        });
      });
    }));

    trackUnlisten(onChatStreamError((event) => {
      setErrors((prev) => {
        const map = new Map(prev);
        map.set(event.conversationId, event.error);
        return map;
      });

      refreshConversationAfterStream(event.conversationId, {
        logPrefix: "[ChatView] 刷新失败后的消息失败:"
      });
    }));

    return () => {
      disposed = true;
      for (const fn of unsubs) fn();
    };
  }, [
    currentConversationIdRef,
    currentMessagesRef,
    hasMoreMessagesRef,
    pendingTitleRef,
    setConversations,
    setCurrentMessages,
    setErrors,
    setHasMoreMessages,
    setStreamingStates
  ]);
}
