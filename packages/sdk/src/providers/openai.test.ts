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
