import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ConversationMeta, SystemPromptConfig } from "@lume/shared";
import { createConversation } from "@/lib/desktop-api/chat";
import { getEffectiveSystemConfig, listChannels } from "@/lib/desktop-api/system";
import { resolveChannelModelSelectionFromRef } from "@/lib/system-model-selection";
import {
  resolveWelcomeConversationPromptId,
  shouldShowChatOnboardingView,
  shouldShowChatTutorialBanner
} from "../chat-onboarding-flow";

interface UseChatOnboardingFlowParams {
  currentConversationId: string | null;
  currentMessagesCount: number;
  isStreaming: boolean;
  onboardingDismissed: boolean;
  setOnboardingDismissed: Dispatch<SetStateAction<boolean>>;
  onboardingCompleted: boolean;
  setOnboardingCompleted: Dispatch<SetStateAction<boolean>>;
  selectedModel: { channelId: string; modelId: string } | null;
  promptConfig: SystemPromptConfig;
  selectedPromptId: string | null;
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setConversationPromptMap: Dispatch<SetStateAction<Map<string, string>>>;
  setSelectedModel: Dispatch<SetStateAction<{ channelId: string; modelId: string } | null>>;
  setCurrentConversationId: Dispatch<SetStateAction<string | null>>;
}

export function useChatOnboardingFlow({
  currentConversationId,
  currentMessagesCount,
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
}: UseChatOnboardingFlowParams) {
  const [creatingWelcomeConversation, setCreatingWelcomeConversation] = useState(false);

  const showOnboardingView = useMemo(
    () => shouldShowChatOnboardingView({
      currentConversationId,
      onboardingDismissed,
      onboardingCompleted
    }),
    [currentConversationId, onboardingCompleted, onboardingDismissed]
  );

  const showTutorialBanner = useMemo(
    () => shouldShowChatTutorialBanner({
      currentConversationId,
      messageCount: currentMessagesCount,
      isStreaming,
      onboardingCompleted
    }),
    [currentConversationId, currentMessagesCount, isStreaming, onboardingCompleted]
  );

  const handleCreateWelcomeConversation = useCallback(async (): Promise<void> => {
    if (creatingWelcomeConversation) return;
    setCreatingWelcomeConversation(true);
    try {
      const resolvedModel = selectedModel ?? await Promise.all([
        listChannels(),
        getEffectiveSystemConfig()
      ]).then(([channels, systemConfig]) =>
        resolveChannelModelSelectionFromRef(channels, systemConfig.models?.chat?.defaultModelRef, "chat")
      );
      if (!resolvedModel) return;
      const resolvedModelRef =
        "modelRef" in resolvedModel && typeof resolvedModel.modelRef === "string"
          ? resolvedModel.modelRef
          : undefined;
      const created = await createConversation({
        modelRef: resolvedModelRef,
        modelId: resolvedModel.modelId,
        channelId: resolvedModel.channelId
      });
      setConversations((prev) => [created, ...prev]);
      const nextPromptId = resolveWelcomeConversationPromptId({
        defaultPromptId: promptConfig.defaultPromptId,
        selectedPromptId
      });
      setConversationPromptMap((prev) => {
        const next = new Map(prev);
        next.set(created.id, nextPromptId);
        return next;
      });
      setSelectedModel({ channelId: resolvedModel.channelId, modelId: resolvedModel.modelId });
      setCurrentConversationId(created.id);
      setOnboardingCompleted(true);
      setOnboardingDismissed(true);
    } catch (error) {
      console.error("[ChatView] create welcome conversation failed:", error);
    } finally {
      setCreatingWelcomeConversation(false);
    }
  }, [
    creatingWelcomeConversation,
    promptConfig.defaultPromptId,
    selectedModel,
    selectedPromptId,
    setConversationPromptMap,
    setConversations,
    setCurrentConversationId,
    setOnboardingCompleted,
    setOnboardingDismissed,
    setSelectedModel
  ]);

  const dismissOnboarding = useCallback((): void => {
    setOnboardingDismissed(true);
  }, [setOnboardingDismissed]);

  const completeOnboarding = useCallback((): void => {
    setOnboardingCompleted(true);
  }, [setOnboardingCompleted]);

  return {
    creatingWelcomeConversation,
    showOnboardingView,
    showTutorialBanner,
    handleCreateWelcomeConversation,
    dismissOnboarding,
    completeOnboarding
  };
}
