"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, MessageSquare, X } from "lucide-react";
import {
  activeToolIdsAtom,
  chatToolsAtom,
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
  conversationPromptIdAtom,
  promptConfigAtom,
  promptSidebarOpenAtom,
  resolveSystemMessage,
  selectedPromptIdAtom,
  selectedModelAtom,
  streamingStatesAtom,
  thinkingEnabledAtom,
  userProfileAtom
} from "@/atoms";
import {
  saveChatAttachment,
  deleteChatAttachment,
  listConversations,
  getConversationMessages,
  getRecentConversationMessages,
  getSystemPromptConfig,
  getChatTools,
  deleteConversationMessage,
  onChatStreamChunk,
  onChatStreamComplete,
  onChatStreamError,
  onChatStreamReasoning,
  onChatStreamToolActivity,
  onChatToolChanged,
  sendChatMessage,
  stopChatGeneration,
  truncateConversationMessagesFrom,
  updateConversationContextDividers,
  updateConversationTitle,
  generateConversationTitle
} from "@/lib/desktop-api";
import type { AttachmentSaveInput, ChatMessage, ChatSendInput, FileAttachment } from "@lume/shared";
import { cn } from "@/lib/utils";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { PromptEditorSidebar } from "./PromptEditorSidebar";
import type { InlineEditSubmitPayload } from "./ChatMessageItem";

export function ChatView(): React.ReactElement {
  const [currentConversationId] = useAtom(currentConversationIdAtom);
  const [currentMessages, setCurrentMessages] = useAtom(currentMessagesAtom);
  const [currentConversation] = useAtom(currentConversationAtom);
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [streamingStates, setStreamingStates] = useAtom(streamingStatesAtom);
  const [contextLength] = useAtom(contextLengthAtom);
  const [contextDividers, setContextDividers] = useAtom(contextDividersAtom);
  const [thinkingEnabled] = useAtom(thinkingEnabledAtom);
  const [promptConfig, setPromptConfig] = useAtom(promptConfigAtom);
  const [, setChatTools] = useAtom(chatToolsAtom);
  const [conversationPromptMap, setConversationPromptMap] = useAtom(conversationPromptIdAtom);
  const promptSidebarOpen = useAtomValue(promptSidebarOpenAtom);
  const selectedPromptId = useAtomValue(selectedPromptIdAtom);
  const userProfile = useAtomValue(userProfileAtom);
  const activeToolIds = useAtomValue(activeToolIdsAtom);
  const [pendingAttachments, setPendingAttachments] = useAtom(pendingAttachmentsAtom);
  const conversations = useAtomValue(conversationsAtom);
  const setHasMoreMessages = useSetAtom(hasMoreMessagesAtom);
  const [chatError] = useAtom(currentChatErrorAtom);
  const setErrors = useSetAtom(chatStreamErrorsAtom);
  const setConversations = useSetAtom(conversationsAtom);
  const [inlineEditingMessageId, setInlineEditingMessageId] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const pendingTitleRef = useRef(new Map<string, { userMessage: string; channelId: string; modelId: string }>());
  const currentConversationIdRef = useRef<string | null>(currentConversationId);
  const conversationsRef = useRef(conversations);

  const streamState = currentConversationId ? streamingStates.get(currentConversationId) : undefined;
  const isStreaming = !!streamState?.streaming;

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    setInlineEditingMessageId(null);
  }, [currentConversationId]);

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
    const existingPromptId = conversationPromptMap.get(currentConversationId);
    if (existingPromptId && promptConfig.prompts.some((item) => item.id === existingPromptId)) {
      return;
    }
    const nextPromptId = promptConfig.defaultPromptId ?? selectedPromptId;
    if (!nextPromptId) return;
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

    // 切换到新会话时先清空旧消息，避免发送首条消息时读取到上一个会话的消息计数。
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
  }, [currentConversation?.contextDividers, currentConversation?.modelId, currentConversation?.channelId, currentConversationId, setContextDividers, setCurrentMessages, setHasMoreMessages, setSelectedModel]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

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
        const current = map.get(event.conversationId) ?? { streaming: true, content: "", reasoning: "", toolActivities: [] };
        map.set(event.conversationId, {
          ...current,
          streaming: true,
          content: current.content + event.delta
        });
        return map;
      });
    }));

    trackUnlisten(onChatStreamReasoning((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(event.conversationId) ?? { streaming: true, content: "", reasoning: "", toolActivities: [] };
        map.set(event.conversationId, {
          ...current,
          streaming: true,
          reasoning: current.reasoning + event.delta
        });
        return map;
      });
    }));

    trackUnlisten(onChatStreamToolActivity((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(event.conversationId) ?? { streaming: true, content: "", reasoning: "", toolActivities: [] };
        map.set(event.conversationId, {
          ...current,
          toolActivities: [...current.toolActivities, event.activity]
        });
        return map;
      });
    }));

    trackUnlisten(onChatStreamComplete((event) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(event.conversationId);
        return map;
      });

      void getConversationMessages(event.conversationId).then((messages) => {
        if (event.conversationId === currentConversationIdRef.current) {
          setCurrentMessages(messages);
          setHasMoreMessages(false);
        }
      }).catch((error) => {
        console.error("[ChatView] 刷新消息失败:", error);
      });

      // 增量更新当前会话元数据，避免 complete 阶段全量刷新对话列表导致侧栏闪烁。
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

      void getConversationMessages(event.conversationId).then((messages) => {
        if (event.conversationId === currentConversationIdRef.current) {
          setCurrentMessages(messages);
          setHasMoreMessages(false);
        }
      });
    }));

    return () => {
      disposed = true;
      for (const fn of unsubs) fn();
    };
  }, [currentConversationId, setConversations, setCurrentMessages, setErrors, setHasMoreMessages, setStreamingStates]);

  const canSend = useMemo(
    () => !!currentConversationId && !!selectedModel,
    [currentConversationId, selectedModel]
  );

  const handleSend = async (
    content: string,
    options?: {
      attachments?: FileAttachment[];
      consumePendingAttachments?: boolean;
      messageCountBeforeSend?: number;
      contextDividersOverride?: string[];
    }
  ): Promise<void> => {
    if (!canSend || !currentConversationId || !selectedModel) return;
    const consumePending = options?.consumePendingAttachments ?? true;

    setErrors((prev) => {
      if (!prev.has(currentConversationId)) return prev;
      const map = new Map(prev);
      map.delete(currentConversationId);
      return map;
    });

    const messageCountBeforeSend = options?.messageCountBeforeSend ?? currentMessages.length;
    const currentMeta = conversationsRef.current.find((item) => item.id === currentConversationId);
    const isDefaultTitledConversation = !currentMeta || currentMeta.title === "新对话";
    const shouldPrepareAutoTitle =
      content.trim().length > 0 &&
      (messageCountBeforeSend === 0 || isDefaultTitledConversation) &&
      !pendingTitleRef.current.has(currentConversationId);
    if (shouldPrepareAutoTitle) {
      pendingTitleRef.current.set(currentConversationId, {
        userMessage: content,
        channelId: selectedModel.channelId,
        modelId: selectedModel.modelId
      });
    }

    let savedAttachments: FileAttachment[] = options?.attachments ?? [];
    if (consumePending) {
      const currentPending = [...pendingAttachments];
      savedAttachments = [];
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
    }

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
      map.set(currentConversationId, { streaming: true, content: "", reasoning: "", toolActivities: [] });
      return map;
    });

    const input: ChatSendInput = {
      conversationId: currentConversationId,
      userMessage: content,
      messageHistory: [],
      channelId: selectedModel.channelId,
      modelId: selectedModel.modelId,
      systemMessage: resolveSystemMessage(
        conversationPromptMap.get(currentConversationId) ?? selectedPromptId,
        promptConfig,
        userProfile.userName
      ),
      contextLength,
      contextDividers: options?.contextDividersOverride ?? contextDividers,
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      thinkingEnabled,
      enabledToolIds: activeToolIds
    };

    void sendChatMessage(input).catch((error) => {
      console.error("[ChatView] send failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setErrors((prev) => {
        const map = new Map(prev);
        map.set(currentConversationId, `发送失败：${message}`);
        return map;
      });
      setStreamingStates((prev) => {
        if (!prev.has(currentConversationId)) return prev;
        const map = new Map(prev);
        map.delete(currentConversationId);
        return map;
      });
    });
  };

  const handleReconnect = async (): Promise<void> => {
    if (isReconnecting) return;
    setIsReconnecting(true);
    try {
      const items = await listConversations();
      setConversations(items);
      if (currentConversationId) {
        const result = await getRecentConversationMessages(currentConversationId, INITIAL_MESSAGE_LIMIT);
        if (currentConversationIdRef.current === currentConversationId) {
          setCurrentMessages(result.messages);
          setHasMoreMessages(result.hasMore);
        }
      }
      setErrors((prev) => {
        if (!currentConversationId || !prev.has(currentConversationId)) return prev;
        const map = new Map(prev);
        map.delete(currentConversationId);
        return map;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (currentConversationId) {
        setErrors((prev) => {
          const map = new Map(prev);
          map.set(currentConversationId, `重连失败：${message}`);
          return map;
        });
      }
    } finally {
      setIsReconnecting(false);
    }
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

  const handleStop = (): void => {
    if (!currentConversationId) return;
    setStreamingStates((prev) => {
      const current = prev.get(currentConversationId);
      if (!current) return prev;
      const map = new Map(prev);
      map.set(currentConversationId, { ...current, streaming: false });
      return map;
    });
    void stopChatGeneration(currentConversationId);
  };

  const syncContextDividers = async (
    conversationId: string,
    messages: Array<{ id: string }>
  ): Promise<string[]> => {
    const messageIdSet = new Set(messages.map((msg) => msg.id));
    const next = contextDividers.filter((id) => messageIdSet.has(id));
    if (next.length !== contextDividers.length) {
      setContextDividers(next);
      await updateConversationContextDividers(conversationId, next);
    }
    return next;
  };

  const truncateFromMessage = async (
    messageId: string,
    preserveFirstMessageAttachments = false
  ): Promise<{
    targetAttachments: FileAttachment[];
    messageCountBeforeSend: number;
    contextDividersAfterTruncate: string[];
  }> => {
    if (!currentConversationId) {
      return { targetAttachments: [], messageCountBeforeSend: 0, contextDividersAfterTruncate: [] };
    }
    const target = currentMessages.find((msg) => msg.id === messageId);
    const targetIndex = currentMessages.findIndex((msg) => msg.id === messageId);
    const updatedMessages = await truncateConversationMessagesFrom(
      currentConversationId,
      messageId,
      preserveFirstMessageAttachments
    );
    setCurrentMessages(updatedMessages);
    setHasMoreMessages(false);
    const contextDividersAfterTruncate = await syncContextDividers(currentConversationId, updatedMessages);
    return {
      targetAttachments: target?.attachments ?? [],
      messageCountBeforeSend: targetIndex >= 0 ? targetIndex : updatedMessages.length,
      contextDividersAfterTruncate
    };
  };

  const handleResendMessage = async (message: ChatMessage): Promise<void> => {
    if (!currentConversationId || isStreaming) return;
    const truncated = await truncateFromMessage(message.id, true);
    await handleSend(message.content ?? "", {
      attachments: truncated.targetAttachments,
      consumePendingAttachments: false,
      messageCountBeforeSend: truncated.messageCountBeforeSend,
      contextDividersOverride: truncated.contextDividersAfterTruncate
    });
  };

  const handleStartInlineEdit = (message: ChatMessage): void => {
    if (isStreaming) return;
    setInlineEditingMessageId(message.id);
  };

  const handleCancelInlineEdit = (): void => {
    setInlineEditingMessageId(null);
  };

  const handleSubmitInlineEdit = async (
    message: ChatMessage,
    payload: InlineEditSubmitPayload
  ): Promise<void> => {
    if (!currentConversationId || !selectedModel || isStreaming) return;
    const trimmed = payload.content.trim();
    if (!trimmed && payload.keepExistingAttachments.length === 0 && payload.newAttachments.length === 0) return;

    const truncated = await truncateFromMessage(message.id, true);
    const keepPathSet = new Set(payload.keepExistingAttachments.map((att) => att.localPath));
    const removed = truncated.targetAttachments.filter((att) => !keepPathSet.has(att.localPath));
    for (const item of removed) {
      await deleteChatAttachment(item.localPath);
    }

    const newSaved: FileAttachment[] = [];
    for (const item of payload.newAttachments) {
      const result = await saveChatAttachment({
        conversationId: currentConversationId,
        filename: item.filename,
        mediaType: item.mediaType,
        data: item.data
      });
      newSaved.push(result.attachment);
    }

    await handleSend(trimmed, {
      attachments: [...payload.keepExistingAttachments, ...newSaved],
      consumePendingAttachments: false,
      messageCountBeforeSend: truncated.messageCountBeforeSend,
      contextDividersOverride: truncated.contextDividersAfterTruncate
    });
    setInlineEditingMessageId(null);
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
    <div className="mx-auto flex h-full w-full max-w-[min(72rem,100%)] overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatHeader />
        <ChatMessages
          messages={currentMessages}
          isStreaming={isStreaming}
          contextDividers={contextDividers}
          onDeleteMessage={handleDeleteMessage}
          onResendMessage={handleResendMessage}
          onStartInlineEdit={handleStartInlineEdit}
          onSubmitInlineEdit={handleSubmitInlineEdit}
          onCancelInlineEdit={handleCancelInlineEdit}
          inlineEditingMessageId={inlineEditingMessageId}
          onDeleteDivider={(messageId) => {
            if (!currentConversationId) return;
            const next = contextDividers.filter((id) => id !== messageId);
            setContextDividers(next);
            void updateConversationContextDividers(currentConversationId, next);
          }}
          streamingContent={streamState?.content}
          streamingReasoning={streamState?.reasoning}
          streamingToolActivities={streamState?.toolActivities}
          onLoadMore={handleLoadMore}
        />
        {chatError ? (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="flex-1 break-all">{chatError}</span>
            <button
              type="button"
              className="shrink-0 rounded px-2 py-0.5 text-xs font-medium transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => { void handleReconnect(); }}
              disabled={isReconnecting}
            >
              {isReconnecting ? "重连中..." : "重连"}
            </button>
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
          onStop={handleStop}
        />
      </div>

      <div
        className={cn(
          "relative flex-shrink-0 overflow-hidden border-l transition-[width] duration-300 ease-in-out",
          promptSidebarOpen ? "w-[300px]" : "w-10 border-l-0"
        )}
      >
        <div
          className={cn(
            "h-full w-[300px] transition-opacity duration-200",
            promptSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          <PromptEditorSidebar />
        </div>
      </div>
    </div>
  );
}
