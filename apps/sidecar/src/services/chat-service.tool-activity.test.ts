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
import { createChannel } from "./channel-manager";
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
    updateChatToolState("web_search", { enabled: true });
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

  test("自定义工具缺少必填凭据时不应执行", async () => {
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
      }
    });
    updateChatToolState("internal_search", { enabled: true });

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const conversation = createConversation("不可用工具不执行");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "帮我查一下内部系统状态",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["internal_search"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(requestedUrls.length).toBe(0);
    expect(toolEvents.length).toBe(0);
  });

  test("enabledToolIds 缺省时应回退到配置默认启用工具执行", async () => {
    const conversation = createConversation("默认启用工具执行");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "回忆一下我们之前的结论",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model"
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(toolEvents.some((event) => event.activity.toolName === "memory_search")).toBeTrue();
  });

  test("工具在配置中被禁用时即使在 enabledToolIds 中也不应执行", async () => {
    updateChatToolState("memory_search", { enabled: false });
    const conversation = createConversation("禁用工具不执行");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "回忆一下我们之前的结论",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["memory_search"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(toolEvents.length).toBe(0);
  });

  test("启用 suggest_agent_mode 且任务复杂时应发出推荐活动", async () => {
    const conversation = createConversation("Agent 模式推荐活动");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请帮我做一份竞品调研并给出技术选型报告和落地计划",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["suggest_agent_mode"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    const startEvent = toolEvents.find((event) => event.activity.type === "start");
    const resultEvent = toolEvents.find((event) => event.activity.type === "result");
    expect(startEvent?.activity.toolName).toBe("suggest_agent_mode");
    expect(resultEvent?.activity.toolName).toBe("suggest_agent_mode");
    expect(resultEvent?.activity.result).toContain("agent_recommendation");
    expect(resultEvent?.activity.result).toContain("suggestedPrompt");
  });

  test("启用 suggest_agent_mode 但简单问候不应触发推荐活动", async () => {
    const conversation = createConversation("Agent 模式推荐不触发");
    const toolEvents: StreamToolActivityEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "你好",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["suggest_agent_mode"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(toolEvents.length).toBe(0);
  });

  test("openai 兼容 provider 启用工具时应走模型函数调用链路", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "openai-fc",
      provider: "openai",
      baseUrl: "https://mock-openai.example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "gpt-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/chat/completions")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_web_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"latest ai news\\"}"}}]}}]}\n` +
            `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n` +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          `data: {"choices":[{"delta":{"content":"这是函数调用后的最终回答"}}]}\n` +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("函数调用工具链路");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请帮我获取今天的 AI 新闻并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "gpt-test",
        enabledToolIds: ["web_search"]
      },
      {
        onChunk: (event) => { chunkEvents.push(event); },
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(requestBodies.length).toBe(2);
    expect((requestBodies[0] as { tools?: unknown[] }).tools?.length ?? 0).toBeGreaterThan(0);

    const secondMessages = (requestBodies[1] as { messages: Array<{ role: string; tool_call_id?: string }> }).messages;
    expect(secondMessages.some((item) => item.role === "tool" && item.tool_call_id === "call_web_1")).toBeTrue();

    expect(toolEvents.some((event) => event.activity.type === "start" && event.activity.toolName === "web_search")).toBeTrue();
    expect(toolEvents.some((event) => event.activity.type === "result" && event.activity.toolName === "web_search")).toBeTrue();
    expect(chunkEvents.some((event) => event.delta.includes("函数调用后的最终回答"))).toBeTrue();
  });
});
