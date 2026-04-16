import { describe, expect, test } from "bun:test";
import type { ChatToolMeta } from "@lume/shared";
import { getBuiltinChatTools, normalizeToolConfig } from "./chat-tool-config-store";
import { testChatToolConnection } from "./chat-tool-test-service";

describe("chat-tool-test-service", () => {
  test("应返回稳定的内置 chat 工具定义", () => {
    const builtins = getBuiltinChatTools();
    expect(builtins.some((item) => item.id === "memory_search")).toBeTrue();
    expect(builtins.some((item) => item.id === "web_search")).toBeTrue();
    expect(builtins.some((item) => item.id === "nano_banana")).toBeTrue();
  });

  test("normalizeToolConfig 应过滤非法自定义工具", () => {
    const config = normalizeToolConfig({
      version: 1,
      toolStates: {},
      toolCredentials: {},
      customTools: [
        {
          id: "bad tool id",
          name: "bad",
          description: "bad"
        },
        {
          id: "jira_search",
          name: "Jira 搜索",
          description: "查询 Jira",
          category: "custom",
          executorType: "http",
          httpConfig: {
            urlTemplate: "https://example.com/issues?query={{query}}",
            method: "GET"
          }
        }
      ]
    });

    expect(config.customTools).toHaveLength(1);
    expect((config.customTools[0] as ChatToolMeta).id).toBe("jira_search");
  });

  test("memory_search 连通性测试应直接成功", async () => {
    const result = await testChatToolConnection({
      toolId: "memory_search",
      toolCredentials: {}
    });

    expect(result.success).toBeTrue();
    expect(result.message).toContain("本地记忆检索工具可用");
  });
});
