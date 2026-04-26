import { describe, expect, test } from "bun:test";

import { DeepSeekAdapter } from "./deepseek-adapter";
import type { StreamRequestInput } from "./types";

function createInput(): StreamRequestInput {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    modelId: "deepseek-chat",
    history: [],
    userMessage: "continue",
    readImageAttachments: () => [],
    continuationMessages: [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call_search_1",
        name: "web_search",
        arguments: { query: "latest ai news" },
      }],
    }],
  };
}

describe("DeepSeekAdapter", () => {
  test("builds DeepSeek-specific assistant tool-call messages without null content", () => {
    const adapter = new DeepSeekAdapter();
    const request = adapter.buildStreamRequest(createInput());
    const body = JSON.parse(request.body) as {
      messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
    };

    const assistantMessage = body.messages.find((message) => message.role === "assistant");

    expect(assistantMessage?.content).toBe("");
    expect(assistantMessage?.tool_calls?.length).toBe(1);
  });
});
