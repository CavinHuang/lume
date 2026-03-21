import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ChatToolActivity,
  StreamChunkEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamReasoningEvent,
  StreamToolActivityEvent
} from "@lume/shared";
import { createConversation, getConversationMessages } from "./conversation-manager";
import { sendMessage } from "./chat-service";
import { createCustomChatTool, updateChatToolCredentials, updateChatToolState } from "./chat-tool-manager";

describe("chat-service tool activity", () => {
  let prevConfigDir: string | undefined;
  let prevMock: string | undefined;
  let prevMockText: string | undefined;
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    prevMock = process.env.LUME_CHAT_MOCK_SUCCESS;
    prevMockText = process.env.LUME_CHAT_MOCK_TEXT;
    prevFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-chat-tool-activity-"));
    process.env.LUME_CHAT_MOCK_SUCCESS = "1";
    process.env.LUME_CHAT_MOCK_TEXT = "mock-response";
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (prevMock === undefined) {
      delete process.env.LUME_CHAT_MOCK_SUCCESS;
    } else {
      process.env.LUME_CHAT_MOCK_SUCCESS = prevMock;
    }
    if (prevMockText === undefined) {
      delete process.env.LUME_CHAT_MOCK_TEXT;
    } else {
      process.env.LUME_CHAT_MOCK_TEXT = prevMockText;
    }
    if (prevFetch) {
      globalThis.fetch = prevFetch;
    }
  });

  test("启用 memory_search 时应发出工具活动并持久化到 assistant 消息", async () => {
    const conversation = createConversation("工具活动测试");
    const chunkEvents: StreamChunkEvent[] = [];
    const reasoningEvents: StreamReasoningEvent[] = [];
    const completeEvents: StreamCompleteEvent[] = [];
    const errorEvents: StreamErrorEvent[] = [];
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "帮我回忆一下之前讨论过的测试约定",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["memory_search"]
      },
      {
        onChunk: (event) => { chunkEvents.push(event); },
        onReasoning: (event) => { reasoningEvents.push(event); },
        onComplete: (event) => { completeEvents.push(event); },
        onError: (event) => { errorEvents.push(event); },
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(chunkEvents.length).toBeGreaterThan(0);
    expect(reasoningEvents.length).toBe(0);
    expect(errorEvents.length).toBe(0);
    expect(completeEvents.length).toBe(1);

    const activities = toolEvents.map((event) => event.activity as ChatToolActivity);
    expect(activities.some((item) => item.type === "start" && item.toolName === "memory_search")).toBeTrue();
    expect(activities.some((item) => item.type === "result" && item.toolName === "memory_search")).toBeTrue();

    const messages = getConversationMessages(conversation.id);
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant?.toolActivities?.length ?? 0).toBeGreaterThan(0);
  });

  test("web_search 配置 brave key 后应优先使用 brave provider", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      if (url.includes("api.search.brave.com")) {
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Brave Result",
                  url: "https://example.com",
                  description: "ok"
                }
              ]
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
      return new Response("unexpected endpoint", { status: 500 });
    }) as typeof fetch;

    updateChatToolCredentials("web_search", {
      braveApiKey: "brave-key",
      tavilyApiKey: ""
    });

    const conversation = createConversation("工具活动 web_search provider 优先级");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "查询今天最新的 AI 新闻",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["web_search"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(requestedUrls[0]).toContain("api.search.brave.com");
    expect(requestedUrls.some((url) => url.includes("duckduckgo.com"))).toBeFalse();

    const resultEvent = toolEvents.find((event) => event.activity.type === "result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.activity.result).toContain("[provider=brave]");
  });

  test("启用自定义 HTTP 工具时应执行并输出工具活动", async () => {
    createCustomChatTool({
      id: "jira_search",
      name: "Jira 搜索",
      description: "查询 Jira 工单",
      category: "custom",
      executorType: "http",
      httpConfig: {
        urlTemplate: "https://example.com/issues?query={{query}}",
        method: "GET",
        resultPath: "data.summary"
      }
    });
    updateChatToolState("jira_search", { enabled: true });

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          data: {
            summary: "共找到 3 条 issue"
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

    const conversation = createConversation("自定义工具活动测试");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请查询本周迭代问题单",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["jira_search"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(requestedUrls.length).toBe(1);
    expect(requestedUrls[0]).toContain("https://example.com/issues?query=");
    expect(requestedUrls[0]).toContain(encodeURIComponent("请查询本周迭代问题单"));

    const startEvent = toolEvents.find((event) => event.activity.type === "start");
    const resultEvent = toolEvents.find((event) => event.activity.type === "result");
    expect(startEvent?.activity.toolName).toBe("jira_search");
    expect(resultEvent?.activity.toolName).toBe("jira_search");
    expect(resultEvent?.activity.isError).toBeUndefined();
    expect(resultEvent?.activity.result).toContain("共找到 3 条 issue");

    const messages = getConversationMessages(conversation.id);
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    const persisted = lastAssistant?.toolActivities ?? [];
    expect(persisted.some((item) => item.toolName === "jira_search" && item.type === "result")).toBeTrue();
  });
});
