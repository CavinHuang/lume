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

  test("启用 nano_banana 且命中生图意图时应发出活动并保存图片附件", async () => {
    updateChatToolState("nano_banana", { enabled: true });
    updateChatToolCredentials("nano_banana", {
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-image-preview"
    });

    const toolEvents: StreamToolActivityEvent[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes(":generateContent")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y5J8AAAAASUVORK5CYII="
                    }
                  },
                  { text: "图片生成完成" }
                ]
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const conversation = createConversation("nano banana tool activity");
    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请生成一张太空猫咪海报",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["nano_banana"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: (event) => { toolEvents.push(event); }
      }
    );

    expect(toolEvents.some((event) => event.activity.type === "start" && event.activity.toolName === "nano_banana")).toBeTrue();
    const resultEvent = toolEvents.find((event) => event.activity.type === "result" && event.activity.toolName === "nano_banana");
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.activity.result).toContain("图片已成功生成");

    const messages = getConversationMessages(conversation.id);
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    expect(lastAssistant?.attachments?.length ?? 0).toBeGreaterThan(0);
    expect(lastAssistant?.attachments?.[0]?.mediaType).toBe("image/png");
  });

  test("nano_banana 编辑语义应自动启用参考图并推断画幅参数", async () => {
    updateChatToolState("nano_banana", { enabled: true });
    updateChatToolCredentials("nano_banana", {
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-image-preview"
    });

    const generateBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes(":generateContent")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.body && typeof init.body === "string") {
        generateBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y5J8AAAAASUVORK5CYII="
                    }
                  },
                  { text: "图片生成完成" }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const conversation = createConversation("nano banana edit inference");
    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请生成一张城市夜景海报",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["nano_banana"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: () => {}
      }
    );
    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请把这张图改成横版16:9，输出4K高清版本",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["nano_banana"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: () => {}
      }
    );

    expect(generateBodies.length).toBe(2);
    const secondBody = generateBodies[1] as {
      contents?: Array<{ parts?: Array<{ inlineData?: unknown; text?: string }> }>;
      generationConfig?: { imageConfig?: { aspectRatio?: string; imageSize?: string } };
    };
    const contents = secondBody.contents ?? [];
    const lastUserParts = contents[contents.length - 1]?.parts ?? [];
    expect(lastUserParts.some((part) => !!part.inlineData)).toBeTrue();
    expect(secondBody.generationConfig?.imageConfig?.aspectRatio).toBe("16:9");
    expect(secondBody.generationConfig?.imageConfig?.imageSize).toBe("4K");
  });

  test("nano_banana 应以模板化段落追加风格与约束提示词", async () => {
    updateChatToolState("nano_banana", { enabled: true });
    updateChatToolCredentials("nano_banana", {
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-image-preview"
    });

    const generateBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes(":generateContent")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.body && typeof init.body === "string") {
        generateBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y5J8AAAAASUVORK5CYII="
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const conversation = createConversation("nano banana prompt hints");
    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请生成一张写实风格的城市海报，要求无水印",
        messageHistory: [],
        channelId: "mock-channel",
        modelId: "mock-model",
        enabledToolIds: ["nano_banana"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: () => {}
      }
    );

    expect(generateBodies.length).toBe(1);
    const body = generateBodies[0] as {
      contents?: Array<{
        parts?: Array<{ text?: string }>;
      }>;
    };
    const promptText = body.contents?.[0]?.parts?.find((part) => typeof part.text === "string")?.text ?? "";
    expect(promptText).toContain("Style hints:");
    expect(promptText).toContain("photorealistic");
    expect(promptText).toContain("Constraints:");
    expect(promptText).toContain("no watermark");
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

  test("openai tool 参数为 code fence JSON 时应恢复 query 并完成续接", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "openai-fc-fenced-json",
      provider: "openai",
      baseUrl: "https://mock-openai.example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "gpt-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/chat/completions")) {
        if (init?.body && typeof init.body === "string") {
          JSON.parse(init.body);
        }
        if (!duckQueries.length) {
          return new Response(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_web_fenced\",\"function\":{\"name\":\"web_search\",\"arguments\":\"```json\\n{\\\"query\\\":\\\"latest ai news\\\"}\\n```\"}}]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"choices\":[{\"delta\":{\"content\":\"fenced 参数调用完成\"}}]}\n" +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("openai fenced tool args");
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请帮我搜索并总结",
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
        onToolActivity: () => {}
      }
    );

    expect(duckQueries).toContain("latest ai news");
    expect(chunkEvents.some((event) => event.delta.includes("fenced 参数调用完成"))).toBeTrue();
  });

  test("openai 多 tool_call(index) 时应正确归属参数并续接两次结果", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "openai-fc-multi",
      provider: "openai",
      baseUrl: "https://mock-openai.example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "gpt-test", name: "gpt-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/chat/completions")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_search"}},{"index":1,"function":{"name":"web_search"}}]}}]}\n` +
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"latest ai news\\"}"}},{"index":1,"function":{"arguments":"{\\"query\\":\\"lume desktop release\\"}"}}]}}]}\n` +
            `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n` +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          `data: {"choices":[{"delta":{"content":"多工具函数调用完成"}}]}\n` +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("openai 多工具函数调用");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请联网检索两组信息并总结",
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
    const secondMessages = (requestBodies[1] as { messages: Array<{ role: string; tool_call_id?: string }> }).messages;
    expect(secondMessages.some((item) => item.role === "tool" && item.tool_call_id === "tc_0")).toBeTrue();
    expect(secondMessages.some((item) => item.role === "tool" && item.tool_call_id === "tc_1")).toBeTrue();

    expect(duckQueries).toContain("latest ai news");
    expect(duckQueries).toContain("lume desktop release");
    expect(toolEvents.filter((event) => event.activity.type === "start" && event.activity.toolName === "web_search").length).toBe(2);
    expect(toolEvents.filter((event) => event.activity.type === "result" && event.activity.toolName === "web_search").length).toBe(2);
    expect(chunkEvents.some((event) => event.delta.includes("多工具函数调用完成"))).toBeTrue();
  });

  test("openai 长链 tool_use 超过上限时应返回降级提示而非空回复", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "openai-fc-limit",
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
        return new Response(
          `data: {"choices":[{"delta":{"tool_calls":[{"id":"call_loop_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"loop query\\"}"}}]}}]}\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n` +
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

    const conversation = createConversation("openai 长链工具上限");
    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请持续执行工具直到完成",
        messageHistory: [],
        channelId: channel.id,
        modelId: "gpt-test",
        enabledToolIds: ["web_search"]
      },
      {
        onChunk: () => {},
        onReasoning: () => {},
        onComplete: () => {},
        onError: () => {},
        onToolActivity: () => {}
      }
    );

    expect(requestBodies.length).toBe(6);
    const messages = getConversationMessages(conversation.id);
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    expect(lastAssistant?.content).toContain("工具调用轮次达到上限");
  });

  test("anthropic provider 启用工具时应走模型函数调用链路", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "anthropic-fc",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [{ id: "claude-test", name: "claude-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"latest ai news\\\"}\"}}\n" +
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic 函数调用后的最终回答\"}}\n" +
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n" +
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

    const conversation = createConversation("anthropic 函数调用工具链路");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请帮我获取今天的 AI 新闻并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "claude-test",
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

    const secondMessages = (requestBodies[1] as { messages: Array<{ role: string; content?: Array<{ type?: string; tool_use_id?: string }> }> }).messages;
    expect(
      secondMessages.some((item) =>
        item.role === "user"
        && Array.isArray(item.content)
        && item.content.some((part) => part.type === "tool_result" && part.tool_use_id === "toolu_1")
      )
    ).toBeTrue();

    expect(toolEvents.some((event) => event.activity.type === "start" && event.activity.toolName === "web_search")).toBeTrue();
    expect(toolEvents.some((event) => event.activity.type === "result" && event.activity.toolName === "web_search")).toBeTrue();
    expect(chunkEvents.some((event) => event.delta.includes("Anthropic 函数调用后的最终回答"))).toBeTrue();
  });

  test("anthropic 异常顺序（delta 早于 tool_use start）时仍应执行工具", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "anthropic-fc-oo-order",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [{ id: "claude-test", name: "claude-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"latest ai news\\\"}\"}}\n" +
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_oo_1\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic 异常顺序调用完成\"}}\n" +
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n" +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("anthropic 异常顺序 tool_use");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请联网搜索最新 AI 新闻",
        messageHistory: [],
        channelId: channel.id,
        modelId: "claude-test",
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
    expect(duckQueries).toContain("latest ai news");
    expect(toolEvents.some((event) => event.activity.type === "start" && event.activity.toolName === "web_search")).toBeTrue();
    expect(toolEvents.some((event) => event.activity.type === "result" && event.activity.toolName === "web_search")).toBeTrue();
    expect(chunkEvents.some((event) => event.delta.includes("Anthropic 异常顺序调用完成"))).toBeTrue();
  });

  test("anthropic 同轮交错 index delta 时应分别命中两组工具参数", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "anthropic-fc-interleaved-index",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [{ id: "claude-test", name: "claude-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_a\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_b\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"latest ai news\\\"}\"}}\n" +
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"lume desktop release\\\"}\"}}\n" +
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic 交错 delta 调用完成\"}}\n" +
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n" +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("anthropic 交错 index delta tool_use");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请联网检索两组信息并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "claude-test",
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
    expect(duckQueries).toContain("latest ai news");
    expect(duckQueries).toContain("lume desktop release");
    expect(toolEvents.filter((event) => event.activity.type === "start" && event.activity.toolName === "web_search").length).toBe(2);
    expect(toolEvents.filter((event) => event.activity.type === "result" && event.activity.toolName === "web_search").length).toBe(2);
    expect(chunkEvents.some((event) => event.delta.includes("Anthropic 交错 delta 调用完成"))).toBeTrue();
  });

  test("anthropic 同轮多 tool_use 时应保留两次执行并续接双 tool_result", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "anthropic-fc-multi",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      models: [{ id: "claude-test", name: "claude-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"latest ai news\\\"}\"}}\n" +
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_2\",\"name\":\"web_search\"}}\n" +
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"lume desktop release\\\"}\"}}\n" +
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic 多工具函数调用完成\"}}\n" +
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n" +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("anthropic 同轮多工具");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请联网检索两组信息并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "claude-test",
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
    const secondMessages = (requestBodies[1] as { messages: Array<{ role: string; content?: Array<{ type?: string; tool_use_id?: string }> }> }).messages;
    expect(
      secondMessages.some((item) =>
        item.role === "user"
        && Array.isArray(item.content)
        && item.content.some((part) => part.type === "tool_result" && part.tool_use_id === "toolu_1")
      )
    ).toBeTrue();
    expect(
      secondMessages.some((item) =>
        item.role === "user"
        && Array.isArray(item.content)
        && item.content.some((part) => part.type === "tool_result" && part.tool_use_id === "toolu_2")
      )
    ).toBeTrue();

    expect(duckQueries).toContain("latest ai news");
    expect(duckQueries).toContain("lume desktop release");
    expect(toolEvents.filter((event) => event.activity.type === "start" && event.activity.toolName === "web_search").length).toBe(2);
    expect(toolEvents.filter((event) => event.activity.type === "result" && event.activity.toolName === "web_search").length).toBe(2);
    expect(chunkEvents.some((event) => event.delta.includes("Anthropic 多工具函数调用完成"))).toBeTrue();
  });

  test("google provider 启用工具时应走模型函数调用链路", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "google-fc",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "sk-test",
      models: [{ id: "gemini-test", name: "gemini-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":streamGenerateContent")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"web_search\",\"args\":{\"query\":\"latest ai news\"}}}]}}]}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Google 函数调用后的最终回答\"}]}}]}\n" +
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

    const conversation = createConversation("google 函数调用工具链路");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请帮我获取今天的 AI 新闻并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "gemini-test",
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
    const firstBody = requestBodies[0] as { tools?: unknown[] };
    expect(firstBody.tools?.length ?? 0).toBeGreaterThan(0);

    const secondContents = (requestBodies[1] as { contents: Array<{ role: string; parts?: Array<{ functionResponse?: { name?: string } }> }> }).contents;
    expect(
      secondContents.some((item) =>
        item.role === "user"
        && (item.parts ?? []).some((part) => part.functionResponse?.name === "web_search")
      )
    ).toBeTrue();

    expect(toolEvents.some((event) => event.activity.type === "start" && event.activity.toolName === "web_search")).toBeTrue();
    expect(toolEvents.some((event) => event.activity.type === "result" && event.activity.toolName === "web_search")).toBeTrue();
    expect(chunkEvents.some((event) => event.delta.includes("Google 函数调用后的最终回答"))).toBeTrue();
  });

  test("google 同名多函数调用时应保留两次执行并正确续接 functionResponse 名称", async () => {
    delete process.env.LUME_CHAT_MOCK_SUCCESS;
    delete process.env.LUME_CHAT_MOCK_TEXT;

    const channel = createChannel({
      name: "google-fc-multi",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "sk-test",
      models: [{ id: "gemini-test", name: "gemini-test", enabled: true }],
      enabled: true
    });
    updateChatToolState("web_search", { enabled: true });

    const requestBodies: unknown[] = [];
    const duckQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":streamGenerateContent")) {
        if (init?.body && typeof init.body === "string") {
          requestBodies.push(JSON.parse(init.body));
        }
        if (requestBodies.length === 1) {
          return new Response(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"web_search\",\"args\":{\"query\":\"latest ai news\"}}},{\"functionCall\":{\"name\":\"web_search\",\"args\":{\"query\":\"lume desktop release\"}}}]}}]}\n" +
            "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response(
          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Google 同名多函数调用完成\"}]}}]}\n" +
          "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      if (url.includes("duckduckgo.com/html")) {
        const query = decodeURIComponent((url.split("?q=")[1] ?? "").split("&")[0] ?? "");
        duckQueries.push(query);
        return new Response(
          "<a class=\"result__a\" href=\"https://example.com/news\">Latest AI News</a><div class=\"result__snippet\">snippet</div>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const conversation = createConversation("google 同名多函数调用");
    const toolEvents: StreamToolActivityEvent[] = [];
    const chunkEvents: StreamChunkEvent[] = [];

    await sendMessage(
      {
        conversationId: conversation.id,
        userMessage: "请联网检索两组信息并总结",
        messageHistory: [],
        channelId: channel.id,
        modelId: "gemini-test",
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
    const secondContents = (requestBodies[1] as { contents: Array<{ role: string; parts?: Array<{ functionResponse?: { name?: string } }> }> }).contents;
    const functionResponseNames = secondContents
      .flatMap((item) => item.parts ?? [])
      .map((part) => part.functionResponse?.name)
      .filter((name): name is string => typeof name === "string");
    expect(functionResponseNames.filter((name) => name === "web_search").length).toBe(2);

    expect(duckQueries).toContain("latest ai news");
    expect(duckQueries).toContain("lume desktop release");
    expect(toolEvents.filter((event) => event.activity.type === "start" && event.activity.toolName === "web_search").length).toBe(2);
    expect(toolEvents.filter((event) => event.activity.type === "result" && event.activity.toolName === "web_search").length).toBe(2);
    expect(chunkEvents.some((event) => event.delta.includes("Google 同名多函数调用完成"))).toBeTrue();
  });
});
