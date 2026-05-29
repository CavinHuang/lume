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

  test("maps DeepSeek prompt cache hit and miss tokens", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "done" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 140,
          completion_tokens: 20,
          total_tokens: 160,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 100,
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new DeepSeekProvider({ apiKey: "sk-test" })
    const result = await provider.createMessage({
      model: "deepseek-chat",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })

    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    })
  })

  test("requests streaming usage from DeepSeek", async () => {
    let capturedBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : undefined
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}],"usage":null}',
        'data: {"choices":[],"usage":{"prompt_tokens":140,"completion_tokens":20,"total_tokens":160,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":100}}',
        "data: [DONE]",
        "",
      ].join("\n")
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const provider = new DeepSeekProvider({ apiKey: "sk-test" })
    const generator = provider.createMessageStream({
      model: "deepseek-chat",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })

    let final
    while (true) {
      const next = await generator.next()
      if (next.done) {
        final = next.value
        break
      }
    }

    expect(capturedBody?.stream_options).toEqual({ include_usage: true })
    expect(final?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    })
  })
})
