import { afterEach, describe, expect, test } from "bun:test"

import { OpenAIResponsesProvider } from "./openai-responses.js"

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

describe("OpenAIResponsesProvider", () => {
  test("should have apiType openai-responses", () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
    })
    expect(provider.apiType).toBe("openai-responses")
  })

  test("should send request to /responses endpoint", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          id: "resp_123",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello World" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const originalFetchImpl = globalThis.fetch
    globalThis.fetch = ((url: any, options: any) => {
      if (url.toString().includes("/responses")) {
        requestBody = JSON.parse(options?.body as string)
      }
      return originalFetchImpl(url, options)
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    const result = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "You are helpful",
      messages: [{ role: "user", content: "Hello" }],
    })

    expect(requestBody).toBeDefined()
    expect(requestBody?.instructions).toBeUndefined()
    expect(requestBody?.input?.[0]).toEqual({
      role: "developer",
      type: "message",
      content: [{ type: "input_text", text: "You are helpful" }],
    })
    expect(requestBody?.model).toBe("gpt-4o")
    expect(requestBody?.max_output_tokens).toBe(1024)
    expect(requestBody?.input).toBeDefined()

    expect(result.content).toEqual([{ type: "text", text: "Hello World" }])
    expect(result.stopReason).toBe("end_turn")
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test("should handle function calls in response", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          id: "resp_456",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_001",
              call_id: "call_001",
              name: "get_weather",
              arguments: '{"location":"Tokyo"}',
              status: "completed",
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    const result = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [{ role: "user", content: "What is the weather?" }],
    })

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_001",
        response_item_id: "fc_001",
        name: "get_weather",
        input: { location: "Tokyo" },
      },
    ])
    expect(result.stopReason).toBe("tool_use")
  })

  test("replays full assistant and tool history with runtime developer input", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "resp_history",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        usage: {
          input_tokens: 120,
          output_tokens: 8,
          total_tokens: 128,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })
    const result = await provider.createMessage({
      model: "gpt-test",
      maxTokens: 100,
      system: "stable system",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", response_item_id: "fc_1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
        { role: "runtime", content: "current runtime" },
        { role: "user", content: "new question" },
      ],
      promptCache: { strategy: "implicit", routingKey: "lume:v1:history", runtimeRole: "developer" },
    })

    expect(requestBody?.previous_response_id).toBeUndefined()
    expect(requestBody?.prompt_cache_key).toBe("lume:v1:history")
    expect(requestBody?.input).toEqual([
      { role: "developer", type: "message", content: [{ type: "input_text", text: "stable system" }] },
      { role: "user", type: "message", content: [{ type: "input_text", text: "old question" }] },
      { role: "assistant", type: "message", content: [{ type: "input_text", text: "old answer" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
      { role: "developer", type: "message", content: [{ type: "input_text", text: "current runtime" }] },
      { role: "user", type: "message", content: [{ type: "input_text", text: "new question" }] },
    ])
    expect(result.usage).toEqual({
      input_tokens: 70,
      output_tokens: 8,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    })
  })

  test("normalizes invalid tool names and restores the original response name", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          id: "resp_memory",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_memory",
              call_id: "call_memory",
              name: requestBody?.tools?.[0]?.name,
              arguments: '{"query":"notes"}',
              status: "completed",
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    const result = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [{ role: "user", content: "Find my notes" }],
      tools: [{
        name: "memory.search",
        description: "Search memory",
        input_schema: { type: "object", properties: {} },
      }],
    })

    expect(requestBody?.tools?.[0]?.name).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(requestBody?.tools?.[0]?.name).not.toBe("memory.search")
    expect(result.content).toContainEqual({
      type: "tool_use",
      id: "call_memory",
      response_item_id: "fc_memory",
      name: "memory.search",
      input: { query: "notes" },
    })
  })

  test("restores original tool names from streaming function calls", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      const wireName = requestBody?.tools?.[0]?.name
      const frames = [
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_memory", call_id: "call_memory", name: wireName } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"query":"notes"}' },
        { type: "response.completed", response: { id: "resp_memory", object: "response", status: "completed", output: [], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } } } },
      ]
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })
    const stream = provider.createMessageStream({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [{ role: "user", content: "Find my notes" }],
      tools: [{
        name: "memory.search",
        description: "Search memory",
        input_schema: { type: "object", properties: {} },
      }],
    })

    let step = await stream.next()
    while (!step.done) step = await stream.next()

    expect(requestBody?.tools?.[0]?.name).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(step.value.content).toContainEqual({
      type: "tool_use",
      id: "call_memory",
      response_item_id: "fc_memory",
      name: "memory.search",
      input: { query: "notes" },
    })
    expect(step.value.usage).toEqual({
      input_tokens: 15,
      output_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    })
  })

  test("should convert tool_result to function_call_output", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (url: any, options: any) => {
      if (url.toString().includes("/responses")) {
        requestBody = JSON.parse(options?.body as string)
      }
      return new Response(
        JSON.stringify({
          id: "resp_789",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The weather is sunny" }],
            },
          ],
          usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_001",
              name: "get_weather",
              input: { location: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_001",
              content: "Sunny, 25°C",
            },
          ],
        },
      ],
    })

    expect(requestBody).toBeDefined()
    const functionCallOutput = requestBody?.input?.find(
      (item: any) => item.type === "function_call_output",
    )
    const functionCall = requestBody?.input?.find(
      (item: any) => item.type === "function_call",
    )
    expect(functionCall).toEqual({
      type: "function_call",
      call_id: "call_001",
      name: "get_weather",
      arguments: '{"location":"Tokyo"}',
    })
    expect(functionCallOutput).toEqual({
      type: "function_call_output",
      call_id: "call_001",
      output: "Sunny, 25°C",
    })
  })

  test("replays preserved Responses function call item IDs", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_001",
          response_item_id: "fc_001",
          name: "get_weather",
          input: { location: "Tokyo" },
        }],
      }],
    })

    expect(requestBody?.input).toContainEqual({
      type: "function_call",
      id: "fc_001",
      call_id: "call_001",
      name: "get_weather",
      arguments: '{"location":"Tokyo"}',
    })
  })

  test("tool_result array content becomes function_call_output plus user image input", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
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
    })

    expect(requestBody?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "generated image",
    })
    expect(requestBody?.input).toContainEqual({
      role: "user",
      type: "message",
      content: [
        {
          type: "input_text",
          text: "The following image was returned by a tool. Inspect its pixels directly and use it as visual evidence for the current user request.",
        },
        { type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
      ],
    })
  })

  test("empty tool_result array still becomes function_call_output", async () => {
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      retryConfig: fastRetry,
    })

    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 1024,
      system: "",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_empty",
          content: [{ type: "text", text: "" }],
        }],
      }],
    })

    expect(requestBody?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_empty",
      output: "",
    })
  })
})
