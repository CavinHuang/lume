import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AttachmentSaveInput,
  ChatMessage,
  ChatSendInput,
  ConversationMeta,
  FileAttachment,
  ThinkingLevel,
  SystemPromptConfig
} from "@lume/shared";
import type { ConversationStreamState, PendingAttachment } from "@/atoms/chat-atoms";
import {
  deleteChatAttachment,
  deleteConversationMessage,
  getConversationMessages,
  saveChatAttachment,
  sendChatMessage,
  stopChatGeneration,
  truncateConversationMessagesFrom,
  updateConversationContextDividers
} from "@/lib/desktop-api/chat";
import {
  filterValidContextDividers,
  mergeInlineEditAttachments,
  shouldPrepareConversationAutoTitle
} from "../chat-composer";

interface SendOptions {
  attachments?: FileAttachment[];
  consumePendingAttachments?: boolean;
  messageCountBeforeSend?: number;
  contextDividersOverride?: string[];
}

interface UseChatComposerParams {
  currentConversationId: string | null;
  currentConversationIdRef: MutableRefObject<string | null>;
  currentMessages: ChatMessage[];
  currentMessagesRef: MutableRefObject<ChatMessage[]>;
  selectedModel: { channelId: string; modelId: string } | null;
  canSend: boolean;
  isStreaming: boolean;
  contextLength: number | "infinite";
  contextDividers: string[];
  setContextDividers: Dispatch<SetStateAction<string[]>>;
  promptConfig: SystemPromptConfig;
  conversationPromptMap: Map<string, string>;
  selectedPromptId: string | null;
  userName?: string;
  thinkingLevel: ThinkingLevel;
  activeToolIds: string[];
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  pendingTitleRef: MutableRefObject<Map<string, { userMessage: string; channelId: string; modelId: string }>>;
  conversationsRef: MutableRefObject<ConversationMeta[]>;
  setCurrentMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, ConversationStreamState>>>;
  setErrors: Dispatch<SetStateAction<Map<string, string>>>;
  onboardingCompleted: boolean;
  setOnboardingCompleted: Dispatch<SetStateAction<boolean>>;
  setOnboardingDismissed: Dispatch<SetStateAction<boolean>>;
  resolveSystemMessage: (
    promptId: string | null | undefined,
    promptConfig: SystemPromptConfig,
    userName?: string
  ) => string | undefined;
}

export function useChatComposer({
  currentConversationId,
  currentConversationIdRef,
  currentMessages,
  currentMessagesRef,
  selectedModel,
  canSend,
  isStreaming,
  contextLength,
  contextDividers,
  setContextDividers,
  promptConfig,
  conversationPromptMap,
  selectedPromptId,
  userName,
  thinkingLevel,
  activeToolIds,
  pendingAttachments,
  setPendingAttachments,
  pendingTitleRef,
  conversationsRef,
  setCurrentMessages,
  setHasMoreMessages,
  setStreamingStates,
  setErrors,
  onboardingCompleted,
  setOnboardingCompleted,
  setOnboardingDismissed,
  resolveSystemMessage
}: UseChatComposerParams) {
  const handleSend = useCallback(async (
    content: string,
    options?: SendOptions
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
    if (shouldPrepareConversationAutoTitle({
      content,
      messageCountBeforeSend,
      currentTitle: currentMeta?.title,
      hasPendingTitle: pendingTitleRef.current.has(currentConversationId)
    })) {
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
        if (!data && !att.sourcePath) continue;
        try {
          const payloadData = data;
          const input: AttachmentSaveInput = {
            conversationId: currentConversationId,
            filename: att.filename,
            mediaType: att.mediaType,
            ...(payloadData ? { data: payloadData } : {}),
            ...(att.sourcePath ? { sourcePath: att.sourcePath } : {})
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
        userName
      ),
      contextLength,
      contextDividers: options?.contextDividersOverride ?? contextDividers,
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      thinkingEnabled: thinkingLevel !== "off",
      thinkingLevel,
      enabledToolIds: activeToolIds
    };

    if (content.trim().length > 0 && !onboardingCompleted) {
      setOnboardingCompleted(true);
      setOnboardingDismissed(true);
    }

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
  }, [
    canSend,
    currentConversationId,
    selectedModel,
    setErrors,
    currentMessages.length,
    conversationsRef,
    pendingTitleRef,
    pendingAttachments,
    setPendingAttachments,
    setCurrentMessages,
    setStreamingStates,
    conversationPromptMap,
    selectedPromptId,
    promptConfig,
    userName,
    contextLength,
    contextDividers,
    thinkingLevel,
    activeToolIds,
    onboardingCompleted,
    setOnboardingCompleted,
    setOnboardingDismissed,
    resolveSystemMessage
  ]);

  const handleDeleteMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!currentConversationId) return;
    const messages = await deleteConversationMessage(currentConversationId, messageId);
    setCurrentMessages(messages);

    if (contextDividers.includes(messageId)) {
      const next = contextDividers.filter((id) => id !== messageId);
      setContextDividers(next);
      await updateConversationContextDividers(currentConversationId, next);
    }
  }, [contextDividers, currentConversationId, setContextDividers, setCurrentMessages]);

  const handleClearContext = useCallback(async (): Promise<void> => {
    if (!currentConversationId || currentMessages.length === 0) return;
    const lastId = currentMessages[currentMessages.length - 1]?.id;
    if (!lastId) return;
    const next = contextDividers.includes(lastId)
      ? contextDividers.filter((id) => id !== lastId)
      : [...contextDividers, lastId];
    setContextDividers(next);
    await updateConversationContextDividers(currentConversationId, next);
  }, [contextDividers, currentConversationId, currentMessages, setContextDividers]);

  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (!currentConversationId) return;
    const allMessages = await getConversationMessages(currentConversationId);
    setCurrentMessages(allMessages);
    setHasMoreMessages(false);
  }, [currentConversationId, setCurrentMessages, setHasMoreMessages]);

  const handleStop = useCallback((): void => {
    if (!currentConversationId) return;
    setStreamingStates((prev) => {
      const current = prev.get(currentConversationId);
      if (!current) return prev;
      const map = new Map(prev);
      map.set(currentConversationId, { ...current, streaming: false });
      return map;
    });
    void stopChatGeneration(currentConversationId);
  }, [currentConversationId, setStreamingStates]);

  const syncContextDividers = useCallback(async (
    conversationId: string,
    messages: Array<{ id: string }>
  ): Promise<string[]> => {
    const next = filterValidContextDividers(contextDividers, messages);
    if (next.length !== contextDividers.length) {
      setContextDividers(next);
      await updateConversationContextDividers(conversationId, next);
    }
    return next;
  }, [contextDividers, setContextDividers]);

  const truncateFromMessage = useCallback(async (
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
    const target = currentMessagesRef.current.find((msg) => msg.id === messageId);
    const targetIndex = currentMessagesRef.current.findIndex((msg) => msg.id === messageId);
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
  }, [currentConversationId, currentMessagesRef, setCurrentMessages, setHasMoreMessages, syncContextDividers]);

  const handleResendMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    if (!currentConversationId || isStreaming) return;
    const truncated = await truncateFromMessage(message.id, true);
    await handleSend(message.content ?? "", {
      attachments: truncated.targetAttachments,
      consumePendingAttachments: false,
      messageCountBeforeSend: truncated.messageCountBeforeSend,
      contextDividersOverride: truncated.contextDividersAfterTruncate
    });
  }, [currentConversationId, isStreaming, truncateFromMessage, handleSend]);

  const handleSubmitInlineEdit = useCallback(async (
    message: ChatMessage,
    payload: {
      content: string;
      keepExistingAttachments: FileAttachment[];
      newAttachments: Array<{ filename: string; mediaType: string; data?: string; sourcePath?: string }>;
    }
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
        ...(item.data ? { data: item.data } : {}),
        ...("sourcePath" in item && item.sourcePath ? { sourcePath: item.sourcePath } : {})
      });
      newSaved.push(result.attachment);
    }

    await handleSend(trimmed, {
      attachments: mergeInlineEditAttachments({
        kept: payload.keepExistingAttachments,
        added: newSaved
      }),
      consumePendingAttachments: false,
      messageCountBeforeSend: truncated.messageCountBeforeSend,
      contextDividersOverride: truncated.contextDividersAfterTruncate
    });
  }, [currentConversationId, selectedModel, isStreaming, truncateFromMessage, handleSend]);

  return {
    handleSend,
    handleDeleteMessage,
    handleClearContext,
    handleLoadMore,
    handleStop,
    handleResendMessage,
    handleSubmitInlineEdit
  };
}
