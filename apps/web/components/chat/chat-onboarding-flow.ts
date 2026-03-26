export function resolveWelcomeConversationPromptId(input: {
  defaultPromptId?: string | null;
  selectedPromptId?: string | null;
}): string {
  return input.defaultPromptId ?? input.selectedPromptId ?? "builtin-default";
}

export function shouldShowChatOnboardingView(input: {
  currentConversationId: string | null;
  onboardingDismissed: boolean;
  onboardingCompleted: boolean;
}): boolean {
  return !input.currentConversationId && !input.onboardingDismissed && !input.onboardingCompleted;
}

export function shouldShowChatTutorialBanner(input: {
  currentConversationId: string | null;
  messageCount: number;
  isStreaming: boolean;
  onboardingCompleted: boolean;
}): boolean {
  return !!input.currentConversationId
    && input.messageCount === 0
    && !input.isStreaming
    && !input.onboardingCompleted;
}
