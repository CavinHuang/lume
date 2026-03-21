import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCustomChatTool,
  deleteCustomChatTool,
  getEnabledChatToolSystemPromptAppend,
  getAllChatToolInfos,
  getChatToolCredentials,
  testChatTool,
  updateChatToolCredentials,
  updateChatToolState
} from "./chat-tool-manager";

describe("chat-tool-manager", () => {
  let tempConfigDir: string;
  let previousConfigDir: string | undefined;
  let previousFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    previousFetch = globalThis.fetch;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-chat-tool-manager-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (previousFetch) {
      globalThis.fetch = previousFetch;
    }
  });

  test("应返回默认工具列表并包含 memory_search/web_search", () => {
    const tools = getAllChatToolInfos();
    expect(tools.some((item) => item.meta.id === "memory_search")).toBeTrue();
    expect(tools.some((item) => item.meta.id === "web_search")).toBeTrue();
  });

  test("应支持更新工具开关状态", () => {
    updateChatToolState("web_search", { enabled: true });
    const tools = getAllChatToolInfos();
    const webSearch = tools.find((item) => item.meta.id === "web_search");
    expect(webSearch?.enabled).toBeTrue();
  });

  test("应支持更新并读取工具凭据", () => {
    updateChatToolCredentials("web_search", {
      braveApiKey: "brave-key",
      tavilyApiKey: "tavily-key"
    });
    const credentials = getChatToolCredentials("web_search");
    expect(credentials.braveApiKey).toBe("brave-key");
    expect(credentials.tavilyApiKey).toBe("tavily-key");
  });

  test("memory_search 测试应直接返回成功", async () => {
    const result = await testChatTool("memory_search");
    expect(result.success).toBeTrue();
    expect(result.message).toContain("本地记忆检索工具可用");
  });

  test("web_search 在未配置 key 时应测试 DuckDuckGo", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === "string" ? input : input.toString();
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch;

    const result = await testChatTool("web_search");
    expect(result.success).toBeTrue();
    expect(requestedUrl).toContain("duckduckgo.com");
  });

  test("应支持新增并读取自定义工具", () => {
    createCustomChatTool({
      id: "jira_search",
      name: "Jira 搜索",
      description: "查询 Jira issue",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/issues?query={{q}}",
        method: "GET"
      }
    });

    const tools = getAllChatToolInfos();
    const custom = tools.find((item) => item.meta.id === "jira_search");
    expect(custom).toBeDefined();
    expect(custom?.meta.category).toBe("custom");
    expect(custom?.enabled).toBeFalse();
  });

  test("应支持删除自定义工具并清理配置", () => {
    createCustomChatTool({
      id: "jira_search",
      name: "Jira 搜索",
      description: "查询 Jira issue",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/issues?query={{q}}",
        method: "GET"
      }
    });
    updateChatToolState("jira_search", { enabled: true });
    updateChatToolCredentials("jira_search", { token: "secret" });

    deleteCustomChatTool("jira_search");

    const tools = getAllChatToolInfos();
    expect(tools.some((item) => item.meta.id === "jira_search")).toBeFalse();
    expect(() => getChatToolCredentials("jira_search")).toThrow();
  });

  test("应支持测试自定义 HTTP 工具", async () => {
    createCustomChatTool({
      id: "jira_search",
      name: "Jira 搜索",
      description: "查询 Jira issue",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/issues?query={{query}}",
        method: "GET",
        resultPath: "data.summary"
      }
    });

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          data: {
            summary: "custom tool ok"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const result = await testChatTool("jira_search");
    expect(result.success).toBeTrue();
    expect(result.message).toContain("custom tool ok");
    expect(requestedUrls[0]).toContain(encodeURIComponent("test connection"));
  });

  test("自定义工具存在 credential 占位符但未配置时应标记为不可用", () => {
    createCustomChatTool({
      id: "internal_search",
      name: "内部搜索",
      description: "查询内部搜索接口",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/search?q={{query}}",
        method: "GET",
        headers: {
          Authorization: "Bearer {{credential.apiToken}}"
        }
      }
    });

    let tools = getAllChatToolInfos();
    let custom = tools.find((item) => item.meta.id === "internal_search");
    expect(custom?.available).toBeFalse();

    updateChatToolCredentials("internal_search", { apiToken: "token-123" });
    tools = getAllChatToolInfos();
    custom = tools.find((item) => item.meta.id === "internal_search");
    expect(custom?.available).toBeTrue();
  });

  test("应按启用工具汇总 systemPromptAppend", () => {
    createCustomChatTool({
      id: "jira_search",
      name: "Jira 搜索",
      description: "查询 Jira issue",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/issues?query={{query}}",
        method: "GET"
      },
      systemPromptAppend: "当问题与项目排期相关时，优先使用 jira_search。"
    });
    updateChatToolState("jira_search", { enabled: true });

    const append = getEnabledChatToolSystemPromptAppend(["memory_search", "jira_search"]);
    expect(append).toContain("memory_search");
    expect(append).toContain("jira_search");
  });

  test("不可用自定义工具不应出现在 systemPromptAppend 汇总中", () => {
    createCustomChatTool({
      id: "internal_search",
      name: "内部搜索",
      description: "查询内部检索接口",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/search?q={{query}}",
        method: "GET",
        headers: {
          Authorization: "Bearer {{credential.apiToken}}"
        }
      },
      systemPromptAppend: "调用 internal_search 需要有效 apiToken。"
    });
    updateChatToolState("internal_search", { enabled: true });

    const append = getEnabledChatToolSystemPromptAppend(["internal_search"]);
    expect(append).toBeUndefined();
  });
});
