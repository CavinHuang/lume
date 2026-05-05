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
})
