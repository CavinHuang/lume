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

  test("applies official five-minute cache markers and hoists runtime system content", async () => {
    let request: Record<string, any> | undefined
    const provider = new AnthropicProvider({ apiKey: "sk-test" })
    ;(provider as any).client = {
      messages: {
        create: async (value: Record<string, any>) => {
          request = value
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
      },
    }

    await provider.createMessage({
      model: "claude-test",
      maxTokens: 100,
      system: "stable system",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "runtime", content: "current runtime" },
        { role: "user", content: "new question" },
      ],
      promptCache: {
        strategy: "anthropic-ephemeral",
        ttl: "5m",
        cacheStableSystem: true,
        cacheConversation: true,
        runtimeRole: "system",
      },
    })

    // runtimeRole:'system' 的内容并入顶层 system（messages 数组不接受 role:'system'）
    expect(request?.system).toEqual([
      {
        type: "text",
        text: "stable system",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
      {
        type: "text",
        text: "<lume_runtime_context>\ncurrent runtime\n</lume_runtime_context>",
      },
    ])
    // cache_control 只能挂 content block：顶层不再出现，落到最后一条消息的最后一个 block
    expect(request?.cache_control).toBeUndefined()
    expect(request?.messages).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      {
        role: "user",
        content: [{
          type: "text",
          text: "new question",
          cache_control: { type: "ephemeral", ttl: "5m" },
        }],
      },
    ])
  })

  test("marks the last content block of the last message when cacheConversation is on", async () => {
    let request: Record<string, any> | undefined
    const provider = new AnthropicProvider({ apiKey: "sk-test" })
    ;(provider as any).client = {
      messages: {
        create: async (value: Record<string, any>) => {
          request = value
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
      },
    }

    await provider.createMessage({
      model: "claude-test",
      maxTokens: 100,
      system: "",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
          { type: "text", text: "hello" },
        ],
      }],
      promptCache: {
        strategy: "anthropic-ephemeral",
        ttl: "5m",
        cacheConversation: true,
      },
    })

    expect(request?.cache_control).toBeUndefined()
    expect(request?.messages).toEqual([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
        { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
    }])
  })

  test("does not send Anthropic cache extensions to compatible endpoints by default", async () => {
    let request: Record<string, any> | undefined
    const provider = new AnthropicProvider({ apiKey: "sk-test", baseURL: "https://compatible.example/v1" })
    ;(provider as any).client = {
      messages: {
        create: async (value: Record<string, any>) => {
          request = value
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
      },
    }

    await provider.createMessage({
      model: "claude-compatible",
      maxTokens: 100,
      system: "stable system",
      messages: [{ role: "runtime", content: "current runtime" }],
      promptCache: { strategy: "implicit", runtimeRole: "user" },
    })

    expect(request?.system).toBe("stable system")
    expect(request?.cache_control).toBeUndefined()
    expect(request?.messages).toEqual([{
      role: "user",
      content: "<lume_runtime_context>\ncurrent runtime\n</lume_runtime_context>",
    }])
  })
})
