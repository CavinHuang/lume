import { describe, expect, test } from "bun:test"
import type { NormalizedMessageParam } from "../providers/types.js"
import {
  createContextUsageSnapshot,
  createEstimatedContextUsage,
  normalizeProviderUsage,
} from "./usage.js"
import { estimateMessagesTokens } from "./tokens.js"

describe("provider usage normalization", () => {
  test("keeps provider input tokens exclusive of cache tokens", () => {
    const usage = normalizeProviderUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
      totalTokens: 160,
    })
  })

  test("subtracts cache tokens when a provider reports input tokens inclusive of cache", () => {
    const usage = normalizeProviderUsage({
      input_tokens: 140,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    }, { inputIncludesCache: true })

    expect(usage.inputTokens).toBe(100)
    expect(usage.totalTokens).toBe(160)
  })

  test("normalizes OpenAI Responses usage details", () => {
    const usage = normalizeProviderUsage({
      input_tokens: 140,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40 },
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
      totalTokens: 160,
    })
  })

  test("normalizes DeepSeek prompt cache hit and miss fields", () => {
    const usage = normalizeProviderUsage({
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 20,
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
      totalTokens: 160,
    })
  })

  test("normalizes Gemini usage metadata cached tokens", () => {
    const usage = normalizeProviderUsage({
      usageMetadata: {
        promptTokenCount: 140,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 18,
        thoughtsTokenCount: 2,
      },
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
      totalTokens: 160,
    })
  })
})

describe("estimated context usage", () => {
  test("creates an estimated snapshot with explicit sections", () => {
    expect(createEstimatedContextUsage({
      messageTokens: 30,
      systemTokens: 20,
      memoryTokens: 10,
      toolSchemaTokens: 5,
      contextWindow: 200_000,
      contextWindowSource: "model",
    })).toEqual({
      source: "estimated",
      inputTokens: 65,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 65,
      estimatedTailTokens: 65,
      sections: {
        systemTokens: 20,
        memoryTokens: 10,
        toolSchemaTokens: 5,
        messageTokens: 30,
      },
      contextWindow: 200_000,
      contextWindowSource: "model",
    })
  })
})

describe("context usage snapshots", () => {
  test("anchors on the latest conversation assistant usage and estimates tail messages", () => {
    const tail: NormalizedMessageParam[] = [{ role: "user", content: "tail message after provider anchor" }]
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "anchored",
        usage: normalizeProviderUsage({ input_tokens: 100, output_tokens: 20 }),
        usageIdentity: { threadId: "thread-1", callerKind: "conversation" },
      },
      ...tail,
    ] as Array<NormalizedMessageParam & Record<string, unknown>>

    const snapshot = createContextUsageSnapshot(messages, {
      threadId: "thread-1",
      contextWindow: 200_000,
      contextWindowSource: "model",
    })

    const tailTokens = estimateMessagesTokens(tail)
    expect(snapshot.source).toBe("provider")
    expect(snapshot.inputTokens).toBe(100 + tailTokens)
    expect(snapshot.outputTokens).toBe(20)
    expect(snapshot.estimatedTailTokens).toBe(tailTokens)
    expect(snapshot.totalTokens).toBe(120 + tailTokens)
  })

  test("walks back to the first split assistant sibling before estimating tool result tail", () => {
    const usage = normalizeProviderUsage({ input_tokens: 100, output_tokens: 20 })
    const firstToolResult: NormalizedMessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "first tool output" }],
    }
    const splitAssistant: NormalizedMessageParam = {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-2", name: "Read", input: { path: "second.txt" } }],
    }
    const secondToolResult: NormalizedMessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-2", content: "second tool output" }],
    }
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "first.txt" } }],
        usage,
        usageIdentity: { threadId: "thread-1", callerKind: "conversation", responseId: "resp-1" },
      },
      firstToolResult,
      {
        ...splitAssistant,
        usage,
        usageIdentity: { threadId: "thread-1", callerKind: "conversation", responseId: "resp-1" },
      },
      secondToolResult,
    ] as Array<NormalizedMessageParam & Record<string, unknown>>

    const snapshot = createContextUsageSnapshot(messages, {
      threadId: "thread-1",
      contextWindow: 200_000,
      contextWindowSource: "model",
    })

    const tailTokens = estimateMessagesTokens([
      firstToolResult,
      splitAssistant,
      secondToolResult,
    ])
    expect(snapshot.source).toBe("provider")
    expect(snapshot.estimatedTailTokens).toBe(tailTokens)
    expect(snapshot.totalTokens).toBe(120 + tailTokens)
  })

  test("ignores compaction and subagent usage as main context anchors", () => {
    const messages = [
      {
        role: "assistant",
        content: "summary",
        usage: normalizeProviderUsage({ input_tokens: 10, output_tokens: 5 }),
        usageIdentity: { threadId: "thread-1", callerKind: "compaction" },
      },
      {
        role: "assistant",
        content: "child",
        usage: normalizeProviderUsage({ input_tokens: 300, output_tokens: 40 }),
        usageIdentity: { threadId: "thread-1", callerKind: "subagent" },
      },
      { role: "user", content: "main thread tail" },
    ] as Array<NormalizedMessageParam & Record<string, unknown>>

    const snapshot = createContextUsageSnapshot(messages, {
      threadId: "thread-1",
      contextWindow: 200_000,
      contextWindowSource: "model",
      systemTokens: 11,
      memoryTokens: 7,
      toolSchemaTokens: 5,
    })

    expect(snapshot.source).toBe("estimated")
    expect(snapshot.sections).toMatchObject({
      systemTokens: 11,
      memoryTokens: 7,
      toolSchemaTokens: 5,
    })
  })

  test("falls back to estimated sections when there is no provider anchor", () => {
    const messages = [{ role: "user", content: "estimate me" }] as NormalizedMessageParam[]

    const snapshot = createContextUsageSnapshot(messages, {
      threadId: "thread-1",
      contextWindow: 200_000,
      contextWindowSource: "fallback",
      systemTokens: 4,
      memoryTokens: 3,
      toolSchemaTokens: 2,
    })

    expect(snapshot.source).toBe("estimated")
    expect(snapshot.contextWindowSource).toBe("fallback")
    expect(snapshot.sections).toEqual({
      systemTokens: 4,
      memoryTokens: 3,
      toolSchemaTokens: 2,
      messageTokens: estimateMessagesTokens(messages),
    })
  })
})
