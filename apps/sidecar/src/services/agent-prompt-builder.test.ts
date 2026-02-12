import { describe, expect, test } from "bun:test";
import { buildSystemPromptAppend } from "./agent-prompt-builder";

describe("agent-prompt-builder", () => {
  test("buildSystemPromptAppend 在工作区上下文中应包含记忆工具强制规则", () => {
    const prompt = buildSystemPromptAppend({
      workspaceSlug: "demo",
      workspaceName: "Demo",
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "auto"
    });
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("Citations:");
  });

  test("buildSystemPromptAppend 在 citations=off 时应输出关闭提示", () => {
    const prompt = buildSystemPromptAppend({
      workspaceSlug: "demo",
      workspaceName: "Demo",
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "off"
    });
    expect(prompt).toContain("Citations are disabled");
  });
});
