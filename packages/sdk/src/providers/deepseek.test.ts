import { afterEach, describe, expect, test } from "bun:test"

import { createProvider, DeepSeekProvider } from "./index.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("DeepSeekProvider", () => {
  test("factory creates a dedicated DeepSeek provider", () => {
    expect(createProvider("deepseek-chat-completions", {})).toBeInstanceOf(DeepSeekProvider)
  })

  test("sends DeepSeek-specific assistant tool-call messages without null content", async () => {
    let capturedBody: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : undefined
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "done" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new DeepSeekProvider({ apiKey: "sk-test" })
    await provider.createMessage({
      model: "deepseek-chat",
      maxTokens: 100,
      system: "",
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_search_1",
          name: "web_search",
          input: { query: "latest ai news" },
        }],
      }],
      tools: [],
    })

    const body = capturedBody as {
      messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
    }
    const assistantMessage = body.messages.find((message) => message.role === "assistant")

    expect(assistantMessage?.content).toBe("")
    expect(assistantMessage?.tool_calls?.length).toBe(1)
  })
})
