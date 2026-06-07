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
    expect(requestBody?.instructions).toBe("You are helpful")
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
        name: "get_weather",
        input: { location: "Tokyo" },
      },
    ])
    expect(result.stopReason).toBe("tool_use")
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
    expect(functionCallOutput).toEqual({
      type: "function_call_output",
      call_id: "call_001",
      output: "Sunny, 25°C",
    })
  })
})
