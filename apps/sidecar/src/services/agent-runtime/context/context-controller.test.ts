import { describe, expect, test } from "bun:test";
import {
  createKernelContextController,
  createContextBudgetSnapshot,
  microCompactKernelMessages,
  sanitizeKernelContextMessages
} from "./context-controller";

describe("Kernel context controller", () => {
  test("creates a concrete budget snapshot from model and prompt inputs", () => {
    expect(createContextBudgetSnapshot({
      model: "gpt-test",
      total: 1000,
      systemPrompt: "system prompt",
      memoryContext: "memory",
      sessionMessages: [{ role: "user", content: "hello" }],
      toolSchemaTokens: 25,
      reservedOutputTokens: 50
    })).toMatchObject({
      model: "gpt-test",
      totalTokens: 1000,
      usedTokens: expect.any(Number),
      sections: {
        system: expect.any(Number),
        memory: expect.any(Number),
        session: expect.any(Number),
        toolSchemas: 25,
        reservedOutput: 50
      }
    });
  });

  test("uses content-aware token estimates for kernel budget sections", () => {
    const sections = createContextBudgetSnapshot({
      model: "gpt-test",
      total: 10_000,
      systemPrompt: "你好世界",
      sessionMessages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "12345678" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(40_000) } }
        ]
      }],
      reservedOutputTokens: 0
    }).sections;

    expect(sections.system).toBeGreaterThan(0);
    expect(sections.session).toBeGreaterThanOrEqual(2_000);
  });

  test("truncates oversized tool results while preserving active tool pairs", () => {
    const largeOutput = `${"a".repeat(60)}${"b".repeat(60)}`;
    const messages = sanitizeKernelContextMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "large.txt" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: largeOutput }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "orphan result" }]
      }
    ]);
    const compacted = microCompactKernelMessages(messages, {
      maxToolResultChars: 40
    });

    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.content).toEqual([
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "large.txt" } }
    ]);
    expect(JSON.stringify(compacted[1]?.content)).toContain("tool-1");
    expect(JSON.stringify(compacted[1]?.content)).toContain("...(truncated by Lume context controller)...");
  });

  test("strips afterglow from assistant text blocks before compaction", () => {
    const messages = sanitizeKernelContextMessages([{
      role: "assistant",
      content: [
        { type: "text", text: "正文\n⟡ 不要进入压缩\n结尾" },
        { type: "tool_use", id: "tool-1", name: "Read", input: {} }
      ]
    }]);

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "正文\n结尾" },
      { type: "tool_use", id: "tool-1", name: "Read", input: {} }
    ]);
  });

  test("triggers auto-compaction from reducible kernel session budget even when SDK message history alone is small", async () => {
    const controller = createKernelContextController({
      threadId: "thread-1",
      model: "gpt-test",
      contextWindow: 100,
      systemPrompt: "system",
      sessionMessages: [{ role: "user", content: "x".repeat(360) }]
    });

    await expect(Promise.resolve(controller.shouldAutoCompact?.({
      messages: [{ role: "user", content: "small" }],
      model: "gpt-test",
      state: { compacted: false, turnCounter: 0, consecutiveFailures: 0 },
      estimatedTokens: 2
    }))).resolves.toBe(true);
  });

  test("does not auto-compact when only fixed kernel overhead exceeds the threshold", async () => {
    const controller = createKernelContextController({
      threadId: "thread-1",
      model: "gpt-test",
      contextWindow: 100,
      systemPrompt: "s".repeat(360),
      sessionMessages: []
    });

    await expect(Promise.resolve(controller.shouldAutoCompact?.({
      messages: [{ role: "user", content: "small" }],
      model: "gpt-test",
      state: { compacted: false, turnCounter: 0, consecutiveFailures: 0 },
      estimatedTokens: 2
    }))).resolves.toBe(false);
  });

  test("emits source message ids and preserved segment metadata for compaction evidence", async () => {
    const controller = createKernelContextController({
      threadId: "thread-1",
      model: "gpt-test",
      contextWindow: 1000,
      systemPrompt: "system",
      sessionMessages: [
        { id: "msg-head", role: "user", content: "first" },
        { id: "msg-anchor", role: "assistant", content: "middle" },
        { id: "msg-tail", role: "user", content: "latest" }
      ]
    });

    const result = await controller.compactConversation?.({
      provider: {
        apiType: "anthropic-messages",
        createMessage: async () => ({
          content: [{ type: "text", text: "summary" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      },
      model: "gpt-test",
      messages: [{ role: "user", content: "latest" }],
      state: { compacted: false, turnCounter: 0, consecutiveFailures: 0 },
      trigger: "manual",
      preTokens: 900
    });

    expect(result?.metadata).toMatchObject({
      sourceMessageIds: ["msg-head", "msg-anchor", "msg-tail"],
      preservedSegment: {
        head_uuid: "msg-head",
        anchor_uuid: "msg-anchor",
        tail_uuid: "msg-tail"
      }
    });
  });
});
