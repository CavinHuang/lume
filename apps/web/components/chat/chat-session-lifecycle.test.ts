import { describe, expect, test } from "bun:test";
import { resolveConversationPromptId } from "./chat-session-lifecycle";

describe("chat-session-lifecycle", () => {
  test("已有有效 prompt id 时应保持不变", () => {
    expect(resolveConversationPromptId({
      existingPromptId: "prompt-a",
      availablePromptIds: ["prompt-a", "prompt-b"],
      defaultPromptId: "prompt-b",
      selectedPromptId: "prompt-b"
    })).toBe("prompt-a");
  });

  test("已有 prompt 失效时应优先回退到 default prompt", () => {
    expect(resolveConversationPromptId({
      existingPromptId: "missing",
      availablePromptIds: ["prompt-a", "prompt-b"],
      defaultPromptId: "prompt-b",
      selectedPromptId: "prompt-a"
    })).toBe("prompt-b");
  });

  test("default 不可用时应回退到 selected prompt", () => {
    expect(resolveConversationPromptId({
      existingPromptId: null,
      availablePromptIds: ["prompt-a", "prompt-b"],
      defaultPromptId: "missing",
      selectedPromptId: "prompt-a"
    })).toBe("prompt-a");
  });

  test("无可用 prompt 时应返回 null", () => {
    expect(resolveConversationPromptId({
      existingPromptId: null,
      availablePromptIds: [],
      defaultPromptId: "prompt-a",
      selectedPromptId: "prompt-b"
    })).toBeNull();
  });
});
