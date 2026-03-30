import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, MessageSquare, X } from "lucide-react";
import {
  activeViewAtom,
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
  settingsTabAtom,
  selectedPromptIdAtom,
  selectedModelAtom,
  streamingStatesAtom,
  thinkingEnabledAtom,
  thinkingLevelAtom,
  userProfileAtom,
  onboardingCompletedAtom,
  onboardingDismissedAtom
} from "@/atoms";
import {
  getRecentConversationMessages,
  listConversations,
  updateConversationContextDividers,
} from "@/lib/desktop-api/chat";
import type { ChatMessage } from "@lume/shared";
import { cn } from "@/lib/utils";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { PromptEditorSidebar } from "./PromptEditorSidebar";
import type { InlineEditSubmitPayload } from "./ChatMessageItem";
import { useChatComposer } from "./hooks/useChatComposer";
import { useChatOnboardingFlow } from "./hooks/useChatOnboardingFlow";
import { useChatSessionLifecycle } from "./hooks/useChatSessionLifecycle";
import { useChatStreamSubscriptions } from "./hooks/useChatStreamSubscriptions";
import { OnboardingView } from "@/components/onboarding/OnboardingView";
import { TutorialBanner } from "@/components/tutorial/TutorialBanner";

export function ChatView(): React.ReactElement {
  const [currentConversationId, setCurrentConversationId] = useAtom(currentConversationIdAtom);
  const [currentMessages, setCurrentMessages] = useAtom(currentMessagesAtom);
  const [currentConversation] = useAtom(currentConversationAtom);
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [streamingStates, setStreamingStates] = useAtom(streamingStatesAtom);
  const [contextLength] = useAtom(contextLengthAtom);
  const [contextDividers, setContextDividers] = useAtom(contextDividersAtom);
  const [thinkingEnabled, setThinkingEnabled] = useAtom(thinkingEnabledAtom);
  const [thinkingLevel, setThinkingLevel] = useAtom(thinkingLevelAtom);
  const [promptConfig, setPromptConfig] = useAtom(promptConfigAtom);
  const [, setChatTools] = useAtom(chatToolsAtom);
  const [conversationPromptMap, setConversationPromptMap] = useAtom(conversationPromptIdAtom);
  const [onboardingDismissed, setOnboardingDismissed] = useAtom(onboardingDismissedAtom);
  const [onboardingCompleted, setOnboardingCompleted] = useAtom(onboardingCompletedAtom);
  const promptSidebarOpen = useAtomValue(promptSidebarOpenAtom);
  const selectedPromptId = useAtomValue(selectedPromptIdAtom);
  const userProfile = useAtomValue(userProfileAtom);
  const activeToolIds = useAtomValue(activeToolIdsAtom);
  const [pendingAttachments, setPendingAttachments] = useAtom(pendingAttachmentsAtom);
  const conversations = useAtomValue(conversationsAtom);
  const hasMoreMessages = useAtomValue(hasMoreMessagesAtom);
  const setHasMoreMessages = useSetAtom(hasMoreMessagesAtom);
  const [chatError] = useAtom(currentChatErrorAtom);
  const setErrors = useSetAtom(chatStreamErrorsAtom);
  const setConversations = useSetAtom(conversationsAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSettingsTab = useSetAtom(settingsTabAtom);
  const [inlineEditingMessageId, setInlineEditingMessageId] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const pendingTitleRef = useRef(new Map<string, { userMessage: string; channelId: string; modelId: string }>());
  const {
    currentConversationIdRef,
    currentMessagesRef,
    hasMoreMessagesRef,
    conversationsRef
  } = useChatSessionLifecycle({
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
  });

  const streamState = currentConversationId ? streamingStates.get(currentConversationId) : undefined;
  const isStreaming = !!streamState?.streaming;

  useChatStreamSubscriptions({
    currentConversationIdRef,
    currentMessagesRef,
    hasMoreMessagesRef,
    pendingTitleRef,
    setStreamingStates,
    setCurrentMessages,
    setHasMoreMessages,
    setConversations,
    setErrors
  });

  const canSend = useMemo(
    () => !!currentConversationId && !!selectedModel,
    [currentConversationId, selectedModel]
  );

  const openModelSettings = (): void => {
    setSettingsTab("models");
    setActiveView("settings");
  };
  const {
    creatingWelcomeConversation,
    showOnboardingView,
    showTutorialBanner,
    handleCreateWelcomeConversation,
    dismissOnboarding,
    completeOnboarding
  } = useChatOnboardingFlow({
    currentConversationId,
    currentMessagesCount: currentMessages.length,
    isStreaming,
    onboardingDismissed,
    setOnboardingDismissed,
    onboardingCompleted,
    setOnboardingCompleted,
    selectedModel,
    promptConfig,
    selectedPromptId,
    setConversations,
    setConversationPromptMap,
    setSelectedModel,
    setCurrentConversationId
  });

  const {
    handleSend,
    handleDeleteMessage,
    handleClearContext,
    handleLoadMore,
    handleStop,
    handleResendMessage,
    handleSubmitInlineEdit: submitInlineEditMessage
  } = useChatComposer({
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
    userName: userProfile.userName,
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
    resolveSystemMessage: (promptId, config, userNameValue) =>
      resolveSystemMessage(promptId ?? undefined, config, userNameValue ?? "")
  });

  useEffect(() => {
    const nextEnabled = thinkingLevel !== "off";
    if (thinkingEnabled !== nextEnabled) {
      setThinkingEnabled(nextEnabled);
    }
  }, [thinkingEnabled, thinkingLevel, setThinkingEnabled]);

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
    await submitInlineEditMessage(message, payload);
    setInlineEditingMessageId(null);
  };

  if (!currentConversationId) {
    if (showOnboardingView) {
      return (
        <OnboardingView
          hasModelSelected={!!selectedModel}
          hasPromptConfig={promptConfig.prompts.length > 0}
          hasToolsEnabled={activeToolIds.length > 0}
          creating={creatingWelcomeConversation}
          onCreateWelcomeConversation={() => { void handleCreateWelcomeConversation(); }}
          onOpenModelSettings={openModelSettings}
          onDismiss={dismissOnboarding}
        />
      );
    }
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
        {showTutorialBanner ? (
          <TutorialBanner
            canSendExample={canSend}
            onSendExample={() => { void handleSend("请用三句话介绍你可以帮我完成哪些任务。"); }}
            onOpenModelSettings={openModelSettings}
            onDismiss={completeOnboarding}
          />
        ) : null}
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
