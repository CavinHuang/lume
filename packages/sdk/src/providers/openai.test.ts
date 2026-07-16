import { afterEach, describe, expect, test } from "bun:test"

import { OpenAIProvider } from "./openai.js"

const originalFetch = globalThis.fetch
const fastRetry = {
  maxRetries: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableStatusCodes: [429, 500, 502, 503, 529],
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("OpenAIProvider", () => {
  test("retries transient 5xx chat completion failures", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "网络错误" } }), { status: 500 })
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const result = await provider.createMessage({
      model: "gpt-test",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })

    expect(calls).toBe(2)
    expect(result.content).toEqual([{ type: "text", text: "ok" }])
  })

  test("converts image content blocks to OpenAI image_url parts", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    await provider.createMessage({
      model: "gpt-test",
      maxTokens: 100,
      system: "",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "ZmFrZQ==",
            },
          },
        ],
      }],
      tools: [],
    })

    expect(requestBody?.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,ZmFrZQ==" },
        },
      ],
    }])
  })

  test("tool_result array content becomes tool text plus user image parts", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    await provider.createMessage({
      model: "gpt-test",
      maxTokens: 100,
      system: "",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "generated image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
          ],
        }],
      }],
      tools: [],
    })

    expect(requestBody?.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "generated image" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The following image was returned by a tool. Inspect its pixels directly and use it as visual evidence for the current user request.",
          },
          { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
        ],
      },
    ])
  })

  test("maps cached prompt tokens from non-streaming usage", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "cached" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 140,
          completion_tokens: 20,
          total_tokens: 160,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const result = await provider.createMessage({
      model: "gpt-test",
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

  test("maps cached tokens from Responses-style OpenAI usage", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "cached" },
          finish_reason: "stop",
        }],
        usage: {
          input_tokens: 140,
          output_tokens: 20,
          total_tokens: 160,
          input_tokens_details: { cached_tokens: 40 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const result = await provider.createMessage({
      model: "gpt-test",
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

  test("sends prompt cache routing key and maps runtime to developer", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "chatcmpl-cache",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          input_tokens: 150,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const result = await provider.createMessage({
      model: "gpt-test",
      maxTokens: 100,
      system: "stable system",
      messages: [
        { role: "user", content: "old" },
        { role: "runtime", content: "current runtime" },
        { role: "user", content: "new" },
      ],
      promptCache: {
        strategy: "implicit",
        routingKey: "lume:v1:hash",
        runtimeRole: "developer",
      },
    })

    expect(requestBody?.prompt_cache_key).toBe("lume:v1:hash")
    expect(requestBody?.messages[2]).toEqual({ role: "developer", content: "current runtime" })
    expect(result.usage).toEqual({
      input_tokens: 90,
      output_tokens: 10,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 20,
    })
  })

  test("uses OpenRouter sticky session and Claude system cache marker", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "chatcmpl-openrouter",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseURL: "https://openrouter.ai/api/v1",
      retryConfig: fastRetry,
    })
    await provider.createMessage({
      model: "anthropic/claude-test",
      maxTokens: 100,
      system: "stable system",
      messages: [{ role: "user", content: "hello" }],
      promptCache: {
        strategy: "openrouter-sticky",
        routingKey: "lume:v1:thread",
        ttl: "5m",
        cacheStableSystem: true,
        runtimeRole: "system",
      },
    })

    expect(requestBody?.session_id).toBe("lume:v1:thread")
    expect(requestBody?.prompt_cache_key).toBeUndefined()
    expect(requestBody?.messages[0]).toEqual({
      role: "system",
      content: [{
        type: "text",
        text: "stable system",
        cache_control: { type: "ephemeral", ttl: "5m" },
      }],
    })
  })

  test("createMessageStream 将 abortSignal 透传给 fetch，支持中途停止", async () => {
    let usedSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input, init) => {
      usedSignal = init?.signal
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "data: [DONE]",
        "",
      ].join("\n")
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const controller = new AbortController()
    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const generator = provider.createMessageStream({
      model: "gpt-test",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      abortSignal: controller.signal,
    })

    // 触发 fetch
    await generator.next()

    // abortSignal 必须透传给底层 fetch，否则点击停止无法中断在飞的流式请求
    expect(usedSignal).toBe(controller.signal)
  })

  test("retries transient 5xx streaming failures before reading the stream", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "网络错误" } }), { status: 500 })
      }
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "data: [DONE]",
        "",
      ].join("\n")
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const generator = provider.createMessageStream({
      model: "gpt-test",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })

    const events = []
    let final
    while (true) {
      const next = await generator.next()
      if (next.done) {
        final = next.value
        break
      }
      events.push(next.value)
    }

    expect(calls).toBe(2)
    expect(events).toContainEqual({ type: "text_delta", text: "ok" })
    expect(final?.content).toEqual([{ type: "text", text: "ok" }])
  })

  test("maps cached prompt tokens from streaming usage", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":140,"completion_tokens":20,"total_tokens":160,"prompt_tokens_details":{"cached_tokens":40}}}',
        "data: [DONE]",
        "",
      ].join("\n")
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const generator = provider.createMessageStream({
      model: "gpt-test",
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

    expect(requestBody?.stream_options).toEqual({ include_usage: true })
    expect(final?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    })
  })

  test("merges partial streaming usage chunks without dropping cache fields", async () => {
    globalThis.fetch = (async () => {
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30011,"completion_tokens":233,"total_tokens":30244}}',
        'data: {"choices":[],"usage":{"prompt_tokens_details":{"cached_tokens":19904}}}',
        "data: [DONE]",
        "",
      ].join("\n\n")
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const provider = new OpenAIProvider({ apiKey: "sk-test", retryConfig: fastRetry })
    const generator = provider.createMessageStream({
      model: "gpt-test",
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

    expect(final?.usage).toEqual({
      input_tokens: 10107,
      output_tokens: 233,
      cache_read_input_tokens: 19904,
      cache_creation_input_tokens: 0,
    })
  })
})
