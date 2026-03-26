import { describe, expect, test } from "bun:test";
import {
  resolveWelcomeConversationPromptId,
  shouldShowChatOnboardingView,
  shouldShowChatTutorialBanner
} from "./chat-onboarding-flow";

describe("chat-onboarding-flow", () => {
  test("欢迎会话应优先使用 defaultPromptId，否则回退 selectedPromptId，再回退 builtin-default", () => {
    expect(resolveWelcomeConversationPromptId({
      defaultPromptId: "prompt-default",
      selectedPromptId: "prompt-selected"
    })).toBe("prompt-default");

    expect(resolveWelcomeConversationPromptId({
      defaultPromptId: null,
      selectedPromptId: "prompt-selected"
    })).toBe("prompt-selected");

    expect(resolveWelcomeConversationPromptId({
      defaultPromptId: null,
      selectedPromptId: null
    })).toBe("builtin-default");
  });

  test("只有未进入会话且未 dismiss/complete 时才显示 onboarding view", () => {
    expect(shouldShowChatOnboardingView({
      currentConversationId: null,
      onboardingDismissed: false,
      onboardingCompleted: false
    })).toBe(true);

    expect(shouldShowChatOnboardingView({
      currentConversationId: "conv-1",
      onboardingDismissed: false,
      onboardingCompleted: false
    })).toBe(false);
  });

  test("tutorial banner 仅在空会话、非 streaming、未完成 onboarding 时显示", () => {
    expect(shouldShowChatTutorialBanner({
      currentConversationId: "conv-1",
      messageCount: 0,
      isStreaming: false,
      onboardingCompleted: false
    })).toBe(true);

    expect(shouldShowChatTutorialBanner({
      currentConversationId: "conv-1",
      messageCount: 1,
      isStreaming: false,
      onboardingCompleted: false
    })).toBe(false);
  });
});
