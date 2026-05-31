import { describe, expect, test } from "bun:test"

import { AnthropicProvider } from "./anthropic.js"

describe("AnthropicProvider", () => {
  test("counts request input tokens with Anthropic countTokens when available", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" })
    const calls: unknown[] = []
    ;(provider as any).client = {
      beta: {
        messages: {
          countTokens: async (request: unknown) => {
            calls.push(request)
            return { input_tokens: 321 }
          },
        },
      },
    }

    const tokens = await provider.countTokens?.({
      model: "claude-test",
      maxTokens: 100,
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    })

    expect(tokens).toBe(321)
    expect(calls).toEqual([{
      model: "claude-test",
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    }])
  })

  test("maps cache creation detail fields when aggregate field is absent", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" })
    ;(provider as any).client = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 21,
            output_tokens: 393,
            cache_read_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 456,
              ephemeral_1h_input_tokens: 100,
            },
          },
        }),
      },
    }

    const result = await provider.createMessage({
      model: "claude-test",
      maxTokens: 100,
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })

    expect(result.usage).toEqual({
      input_tokens: 21,
      output_tokens: 393,
      cache_creation_input_tokens: 556,
      cache_read_input_tokens: 0,
    })
  })
})
